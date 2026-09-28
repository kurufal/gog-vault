import { db, activity, changeJob, filesFor, gameById, jobsFor, now, settings } from './db';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { desiredFingerprint, transition, type Job, type JobState } from '../shared/domain';
import { downloadFile } from './transfer';
import { folderName, gameFolder, vaultPath, writeOfflineMetadata } from './storage';

const running = new Map<number, AbortController>();
const inFlight = new Set<Promise<void>>();
const listeners = new Set<(jobs: Job[]) => void>();
let stopping = false;
let timer: ReturnType<typeof setInterval> | undefined;
export function subscribe(listener: (jobs: Job[]) => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function broadcast() { const jobs = jobsFor(); for (const listener of listeners) listener(jobs); }
export function startQueue() {
  db.query("UPDATE download_jobs SET state='queued',updated_at=? WHERE state IN ('downloading','verifying')").run(now());
  db.query("UPDATE download_files SET state='queued' WHERE state IN ('downloading','verifying')").run();
  schedule();
  timer = setInterval(schedule, 15000);
  timer.unref();
}
export async function shutdownQueue() {
  stopping = true;
  if (timer) clearInterval(timer);
  for (const controller of running.values()) controller.abort();
  await Promise.allSettled([...inFlight]);
  db.transaction(() => {
    db.query("UPDATE download_jobs SET state='queued',speed=0,updated_at=? WHERE state IN ('downloading','verifying')").run(now());
    db.query("UPDATE download_files SET state='queued' WHERE state IN ('downloading','verifying')").run();
  })();
}
export function enqueue(gameId: string) {
  if (stopping) throw new Error('Queue is stopping');
  if (!settings().vaultPath) throw new Error('Select a vault directory first');
  const game = gameById(gameId);
  if (!game) throw new Error('Game not found');
  const files = filesFor(gameId).filter(file => file.selected && !file.verified);
  if (!files.length) throw new Error('No missing selected files to download');
  if (jobsFor(gameId).some(job => ['queued', 'downloading', 'paused', 'verifying'].includes(job.state))) throw new Error('Game already in queue');
  const destination = folderName(game);
  const job = db.transaction(() => {
    const created = db.query('INSERT INTO download_jobs(game_id,state,created_at,updated_at,total,desired_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .get(gameId, 'queued', now(), now(), files.reduce((sum, file) => sum + file.size, 0), desiredFingerprint(filesFor(gameId))) as { id: number };
    const insert = db.query('INSERT INTO download_files(job_id,file_key,snapshot,destination) VALUES (?,?,?,?)');
    for (const file of files) insert.run(created.id, file.key, JSON.stringify(file), destination);
    return created;
  })();
  activity(`${game.title} queued`); broadcast(); schedule();
  return job.id;
}
export function command(id: number, action: 'pause' | 'resume' | 'cancel' | 'remove') {
  const job = jobsFor().find(entry => entry.id === id);
  if (!job) throw new Error('Job not found');
  if (action === 'remove') {
    if (!['complete', 'cancelled', 'error'].includes(job.state)) throw new Error('Stop the job first');
    db.query('DELETE FROM download_jobs WHERE id=?').run(id);
  } else {
    const next: JobState = action === 'resume' ? 'queued' : action === 'pause' ? 'paused' : 'cancelled';
    if (!transition(job.state, next)) throw new Error(`Cannot ${action} a ${job.state} job`);
    changeJob(id, next);
    if (action !== 'resume') running.get(id)?.abort();
    if (action === 'resume') schedule();
  }
  broadcast();
}
let scheduling = false;
export function schedule() {
  if (scheduling || stopping) return;
  scheduling = true;
  void vaultPath().then(() => {
    scheduling = false;
    if (stopping) return;
    const slots = Math.max(1, settings().concurrency) - running.size;
    for (const job of jobsFor().filter(entry => entry.state === 'queued').slice(0, Math.max(0, slots))) {
      const controller = new AbortController();
      running.set(job.id, controller);
      const task = run(job, controller).finally(() => { running.delete(job.id); inFlight.delete(task); broadcast(); schedule(); });
      inFlight.add(task);
    }
  }).catch(() => { scheduling = false; });
}
async function run(job: Job, controller: AbortController) {
  const game = gameById(job.gameId);
  if (!game) return;
  let lastWrite = 0; let lastBytes = 0; let lastTime = Date.now();
  try {
    changeJob(job.id, 'downloading'); broadcast();
    const pending = db.query('SELECT file_key,bytes,snapshot,destination FROM download_files WHERE job_id=? AND state!=?').all(job.id, 'complete') as { file_key: string; bytes: number; snapshot: string; destination: string }[];
    const destination = (pending[0]?.destination || folderName(game));
    const folder = await gameFolder(game, true, destination);
    for (const entry of pending) {
      if (controller.signal.aborted) return;
      const file = entry.snapshot ? JSON.parse(entry.snapshot) as ReturnType<typeof filesFor>[number] : filesFor(job.gameId).find(item => item.key === entry.file_key);
      if (!file) throw new Error('Queued file has no saved download metadata');
      const completed = db.query("SELECT COALESCE(SUM(bytes),0) AS total FROM download_files WHERE job_id=? AND state='complete'").get(job.id) as { total: number };
      db.query('UPDATE download_jobs SET current_file=? WHERE id=?').run(file.name, job.id);
      lastWrite = lastBytes = 0; lastTime = Date.now();
      const filename = await downloadFile(file, folder, controller.signal, (bytes) => {
        const time = Date.now();
        if (time - lastWrite < 1000) return;
        const speed = Math.max(0, Math.round((bytes - lastBytes) * 1000 / Math.max(1, time - lastTime)));
        db.query('UPDATE download_jobs SET bytes=?,speed=?,updated_at=? WHERE id=?').run(completed.total + bytes, speed, now(), job.id);
        db.query('UPDATE download_files SET bytes=? WHERE job_id=? AND file_key=?').run(bytes, job.id, file.key);
        lastWrite = lastTime = time; lastBytes = bytes; broadcast();
      }, () => {
        changeJob(job.id, 'verifying');
        db.query('UPDATE download_files SET state=?,bytes=? WHERE job_id=? AND file_key=?').run('verifying', file.size, job.id, file.key);
        db.query('UPDATE download_jobs SET bytes=?,speed=0 WHERE id=?').run(completed.total + file.size, job.id);
        broadcast();
      }, () => {
        changeJob(job.id, 'downloading');
        db.query('UPDATE download_files SET state=? WHERE job_id=? AND file_key=?').run('downloading', job.id, file.key);
        lastWrite = lastBytes = 0; lastTime = Date.now();
        broadcast();
      });
      if (controller.signal.aborted) return;
      changeJob(job.id, 'verifying'); broadcast();
      db.query('UPDATE remote_files SET verified=1,name=? WHERE game_id=? AND key=? AND size=? AND version=? AND downlink=?')
        .run(filename, job.gameId, file.key, file.size, file.version, file.downlink);
      db.query("UPDATE download_files SET state='complete',bytes=? WHERE job_id=? AND file_key=?").run(file.size, job.id, file.key);
      changeJob(job.id, 'downloading');
    }
    if (controller.signal.aborted) return;
    changeJob(job.id, 'verifying'); broadcast();
    let localSize = 0;
    for (const entry of await readdir(folder)) {
      const info = await lstat(join(folder, entry));
      if (info.isFile() && !entry.endsWith('.part')) localSize += info.size;
    }
    const snapshot = db.query('SELECT desired_hash FROM download_jobs WHERE id=?').get(job.id) as { desired_hash: string };
    db.query('UPDATE games SET archived_hash=manifest_hash,archived_selected_hash=?,scanned_at=?,local_size=? WHERE id=?').run(snapshot.desired_hash || desiredFingerprint(filesFor(job.gameId)), now(), localSize, job.gameId);
    await writeOfflineMetadata(job.gameId);
    changeJob(job.id, 'complete');
    db.query('UPDATE download_jobs SET bytes=total,speed=0,current_file=? WHERE id=?').run('', job.id);
    activity(`${game.title} download verified`);
    console.log(JSON.stringify({ event: 'download_complete', title: game.title }));
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : 'Download failed';
      changeJob(job.id, 'error', message);
      activity(`${game.title} download failed`);
    }
  }
}