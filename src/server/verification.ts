import { randomUUID } from 'node:crypto';
import { activeVault, db, filesFor, gameById, now } from './db';
import type { ActivityFile } from '../shared/domain';
import { scanGame } from './storage';

export type VerificationJob = {
  id: string; gameId: string; vaultId: number; state: 'queued' | 'verifying' | 'reconciling' | 'complete' | 'failed' | 'cancelled';
  done: number; total: number; bytes: number; totalBytes: number; currentFile: string; error: string;
  createdAt: string; startedAt: string; finishedAt: string; files: ActivityFile[];
};
const jobs: VerificationJob[] = [];
const controllers = new Map<string, AbortController>();
let running = false;

export function verificationJobs(): VerificationJob[] {
  return jobs.filter(job => job.vaultId === activeVault()?.id).map(job => ({ ...job }));
}
export function hasActiveVerification() {
  return jobs.some(job => ['queued', 'verifying', 'reconciling'].includes(job.state));
}

export function enqueueVerification(gameId: string): VerificationJob {
  const game = gameById(gameId);
  const vaultId = activeVault()?.id;
  if (!game || !vaultId || !game.folder && !db.query('SELECT 1 FROM vault_child_file_locations WHERE vault_id=? AND child_product_id=?').get(vaultId, gameId))
    throw new Error('Link a game folder before verifying');
  if (jobs.some(job => job.gameId === gameId && job.vaultId === vaultId && ['queued', 'verifying', 'reconciling'].includes(job.state)))
    throw new Error('Verification already running for this game');
  const selected = filesFor(gameId).filter(file => file.selected);
  const job: VerificationJob = { id: randomUUID(), gameId, vaultId, state: 'queued', done: 0, total: selected.length, bytes: 0,
    totalBytes: selected.reduce((sum, file) => sum + file.size, 0), currentFile: '', error: '',
    createdAt: now(), startedAt: '', finishedAt: '', files: selected.map(file => ({ name: file.name, size: file.size, bytes: 0, state: 'queued' })) };
  jobs.unshift(job);
  if (jobs.length > 100) jobs.pop();
  for (const child of game.dlcChildren || []) if (child.selected && (gameById(child.id)?.folder ||
    db.query('SELECT 1 FROM vault_child_file_locations WHERE vault_id=? AND child_product_id=?').get(vaultId, child.id)) &&
    !jobs.some(item => item.gameId === child.id && item.vaultId === vaultId && ['queued', 'verifying', 'reconciling'].includes(item.state))) {
    const selectedFiles = filesFor(child.id).filter(file => file.selected);
    jobs.push({ id: randomUUID(), gameId: child.id, vaultId, state: 'queued', done: 0, total: selectedFiles.length, bytes: 0,
      totalBytes: selectedFiles.reduce((sum, file) => sum + file.size, 0), currentFile: '', error: '',
      createdAt: now(), startedAt: '', finishedAt: '', files: selectedFiles.map(file => ({ name: file.name, size: file.size, bytes: 0, state: 'queued' })) });
  }
  void runNext();
  return { ...job };
}

export function cancelVerification(id: string) {
  const job = jobs.find(item => item.id === id && item.vaultId === activeVault()?.id);
  if (!job || !['queued', 'verifying'].includes(job.state)) throw new Error('Verification is not cancellable');
  if (job.state === 'queued') { job.state = 'cancelled'; job.finishedAt = now(); }
  else controllers.get(id)?.abort();
}

async function runNext() {
  if (running) return;
  const job = jobs.find(item => item.state === 'queued');
  if (!job) return;
  running = true;
  const controller = new AbortController();
  controllers.set(job.id, controller);
  job.state = 'verifying';
  job.startedAt = now();
  const selected = filesFor(job.gameId).filter(file => file.selected);
  job.files = selected.map(file => ({ name: file.name, size: file.size, bytes: 0, state: 'queued' }));
  try {
    if (activeVault()?.id !== job.vaultId) throw new Error('Vault changed before verification started');
    await scanGame(job.gameId, true, undefined, new Set(), (done, total, name, bytes) => {
      if (done > job.done && selected[done - 1]) {
        const file = filesFor(job.gameId).find(file => file.key === selected[done - 1]!.key);
        job.files[done - 1] = { name: name || file?.name || selected[done - 1]!.name, size: file?.verifiedSize || file?.size || 0,
          bytes: file?.matched || file?.verified ? file.verifiedSize || file.size : 0,
          state: file?.verified ? 'verified' : file?.matched ? 'identified' : 'missing' };
      }
      job.done = done; job.total = total; job.currentFile = name; job.bytes = bytes;
      if (!name) job.state = 'reconciling';
    }, controller.signal);
    job.state = 'complete';
  } catch (cause) {
    job.error = (cause as Error).message;
    job.state = controller.signal.aborted ? 'cancelled' : 'failed';
  } finally {
    job.finishedAt = now();
    controllers.delete(job.id);
    running = false;
    void runNext();
  }
}
export function removeVerification(id: string) {
  const index = jobs.findIndex(job => job.id === id && job.vaultId === activeVault()?.id && ['complete', 'failed', 'cancelled'].includes(job.state));
  if (index < 0) throw new Error('Finish or cancel verification before removing it');
  jobs.splice(index, 1);
}