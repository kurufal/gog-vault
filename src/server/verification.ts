import { randomUUID } from 'node:crypto';
import { activeVault, filesFor, gameById } from './db';
import { scanGame } from './storage';

export type VerificationJob = {
  id: string; gameId: string; vaultId: number; state: 'queued' | 'verifying' | 'reconciling' | 'complete' | 'failed' | 'cancelled';
  done: number; total: number; bytes: number; totalBytes: number; currentFile: string; error: string;
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
  if (!game?.folder || !vaultId) throw new Error('Link a game folder before verifying');
  if (jobs.some(job => job.gameId === gameId && job.vaultId === vaultId && ['queued', 'verifying', 'reconciling'].includes(job.state)))
    throw new Error('Verification already running for this game');
  const selected = filesFor(gameId).filter(file => file.selected);
  const job: VerificationJob = { id: randomUUID(), gameId, vaultId, state: 'queued', done: 0, total: selected.length, bytes: 0,
    totalBytes: selected.reduce((sum, file) => sum + file.size, 0), currentFile: '', error: '' };
  jobs.unshift(job);
  if (jobs.length > 100) jobs.pop();
  void runNext();
  return { ...job };
}

export function cancelVerification(id: string) {
  const job = jobs.find(item => item.id === id && item.vaultId === activeVault()?.id);
  if (!job || !['queued', 'verifying'].includes(job.state)) throw new Error('Verification is not cancellable');
  if (job.state === 'queued') job.state = 'cancelled';
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
  try {
    if (activeVault()?.id !== job.vaultId) throw new Error('Vault changed before verification started');
    await scanGame(job.gameId, true, undefined, new Set(), (done, total, name, bytes) => {
      job.done = done; job.total = total; job.currentFile = name; job.bytes = bytes;
      if (!name) job.state = 'reconciling';
    }, controller.signal);
    job.state = 'complete';
  } catch (cause) {
    job.error = (cause as Error).message;
    job.state = controller.signal.aborted ? 'cancelled' : 'failed';
  } finally {
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