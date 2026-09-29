import { db, activity, changeJob, filesFor, gameById, jobsFor, now, settings } from './db';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { desiredFingerprint, transition, type DownloadFailure, type Job, type JobState, type RemoteFile } from '../shared/domain';
import { downloadFile, type DownloadVerification } from './transfer';
import { folderName, gameFolder, vaultPath, writeOfflineMetadata } from './storage';
import { archiveMedia } from './media';

const running = new Map<number, AbortController>();
const inFlight = new Set<Promise<void>>();
const listeners = new Set<(jobs: Job[]) => void>();
export const partNumber = (name: string): number | null => {
  const match = /\(Part (\d+) of \d+\)/i.exec(name);
  return match ? Number(match[1]) : null;
};
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : 'Download failed')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(token|secret|signature|sig|key)=([^&\s]+)/gi, '$1=[redacted]');
}
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
  const files = filesFor(gameId).filter(file => file.selected && !file.verified && !file.matched);
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
    if (action === 'resume') db.query("UPDATE download_jobs SET error='',error_details='' WHERE id=?").run(id);
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
  let stage = 'resolve_manifest'; let httpStatus: number | null = null; let activeFile: RemoteFile | undefined;
  try {
    changeJob(job.id, 'downloading'); broadcast();
    const pending = db.query('SELECT file_key,bytes,snapshot,destination FROM download_files WHERE job_id=? AND state!=?').all(job.id, 'complete') as { file_key: string; bytes: number; snapshot: string; destination: string }[];
    pending.sort((left, right) => {
      const leftPart = partNumber((JSON.parse(left.snapshot || '{}') as RemoteFile).name || '');
      const rightPart = partNumber((JSON.parse(right.snapshot || '{}') as RemoteFile).name || '');
      return leftPart !== null && rightPart !== null ? leftPart - rightPart : 0;
    });
    const destination = (pending[0]?.destination || folderName(game));
    const folder = await gameFolder(game, true, destination);
    for (const entry of pending) {
      if (controller.signal.aborted) return;
      const file = entry.snapshot ? JSON.parse(entry.snapshot) as ReturnType<typeof filesFor>[number] : filesFor(job.gameId).find(item => item.key === entry.file_key);
      if (!file) throw new Error('Queued file has no saved download metadata');
      activeFile = file;
      stage = 'resolve_downlink'; httpStatus = null;
      const completed = db.query("SELECT COALESCE(SUM(bytes),0) AS total FROM download_files WHERE job_id=? AND state='complete'").get(job.id) as { total: number };
      db.query('UPDATE download_jobs SET current_file=? WHERE id=?').run(file.name, job.id);
      lastWrite = lastBytes = 0; lastTime = Date.now();
      let verification: DownloadVerification | undefined;
      const filename = await downloadFile(file, folder, controller.signal, (bytes) => {
        const time = Date.now();
        if (time - lastWrite < 1000) return;
        const speed = Math.max(0, Math.round((bytes - lastBytes) * 1000 / Math.max(1, time - lastTime)));
        db.query('UPDATE download_jobs SET bytes=?,speed=?,updated_at=? WHERE id=?').run(completed.total + bytes, speed, now(), job.id);
        db.query('UPDATE download_files SET bytes=? WHERE job_id=? AND file_key=?').run(bytes, job.id, file.key);
        lastWrite = lastTime = time; lastBytes = bytes; broadcast();
      }, (expectedSize) => {
        changeJob(job.id, 'verifying');
        db.query('UPDATE download_files SET state=?,bytes=? WHERE job_id=? AND file_key=?').run('verifying', expectedSize || file.size, job.id, file.key);
        db.query('UPDATE download_jobs SET bytes=?,speed=0 WHERE id=?').run(completed.total + (expectedSize || file.size), job.id);
        broadcast();
      }, () => {
        changeJob(job.id, 'downloading');
        db.query('UPDATE download_files SET state=? WHERE job_id=? AND file_key=?').run('downloading', job.id, file.key);
        lastWrite = lastBytes = 0; lastTime = Date.now();
        broadcast();
      }, result => { verification = result; }, (nextStage, status) => {
        stage = nextStage;
        if (status !== undefined) httpStatus = status;
        if (process.env.GOG_VAULT_DEBUG_DOWNLOAD === '1') console.log(JSON.stringify({ event: 'download', productId: game.id, file: file.name, part: partNumber(file.name), stage, httpStatus }));
      });
      if (controller.signal.aborted) return;
      changeJob(job.id, 'verifying'); broadcast();
      stage = 'advance_part';
      const info = verification ? await lstat(join(folder, filename)) : null;
      db.transaction(() => {
        db.query('UPDATE remote_files SET verified=1,name=?,verification_source=?,verified_size=?,checksum_url=? WHERE game_id=? AND key=? AND size=? AND version=? AND downlink=?')
          .run(filename, verification?.source || 'gog-checksum', verification?.size || file.size, verification?.checksumUrl || '', job.gameId, file.key, file.size, file.version, file.downlink);
        db.query("UPDATE download_files SET state='complete',bytes=? WHERE job_id=? AND file_key=?").run(verification?.size || file.size, job.id, file.key);
        if (verification) db.query('UPDATE download_jobs SET total=total+? WHERE id=?').run(verification.size - file.size, job.id);
        if (verification && info) db.query('INSERT INTO local_files(game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?) ON CONFLICT(game_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,verified_at=excluded.verified_at')
          .run(game.id, filename, verification.size, Math.round(info.mtimeMs), verification.sha256, now());
      })();
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
    stage = 'write_metadata';
    await writeOfflineMetadata(job.gameId);
    if (db.query("SELECT 1 FROM media_assets WHERE game_id=? AND selected=1 AND external=0 AND local_path='' LIMIT 1").get(job.gameId)) {
      try { await archiveMedia(job.gameId); }
      catch (error) { activity(`${game.title} media archive incomplete: ${safeError(error)}`); }
    }
    changeJob(job.id, 'complete');
    db.query('UPDATE download_jobs SET bytes=total,speed=0,current_file=? WHERE id=?').run('', job.id);
    activity(`${game.title} download verified`);
    console.log(JSON.stringify({ event: 'download_complete', title: game.title }));
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = safeError(error);
      const details: DownloadFailure = { stage, productId: job.gameId, fileId: activeFile?.key || '', filename: activeFile?.name || '',
        partNumber: activeFile ? partNumber(activeFile.name) : null, httpStatus, errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : '',
        safeMessage: message, technicalMessage: message, timestamp: now(), retryable: !/Unsafe|checksum mismatch/i.test(message) };
      changeJob(job.id, 'error', message);
      db.query('UPDATE download_jobs SET error_details=? WHERE id=?').run(JSON.stringify(details), job.id);
      if (process.env.GOG_VAULT_DEBUG_DOWNLOAD === '1') console.warn(JSON.stringify({ event: 'download', productId: job.gameId, file: details.filename, part: details.partNumber, stage, httpStatus, error: message }));
      activity(`${game.title} download failed`);
    }
  }
}