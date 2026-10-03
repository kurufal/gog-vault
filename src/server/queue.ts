import { activeVault, db, activity, changeJob, filesFor, gameById, jobsFor, mediaFor, now, saveFileState, saveLocalGame, settings } from './db';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { desiredFingerprint, transition, type DownloadFailure, type Job, type JobState, type RemoteFile } from '../shared/domain';
import { downloadFile, type DownloadVerification } from './transfer';
import { folderName, gameFolder, scanGame, vaultPath } from './storage';
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
  db.query("UPDATE download_jobs SET state='error',error='Legacy download has no known destination vault; inspect before retrying' WHERE vault_id IS NULL AND state NOT IN ('complete','error','cancelled')").run();
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
  const vaultId = activeVault()!.id;
  const game = gameById(gameId);
  if (!game) throw new Error('Game not found');
  const files = filesFor(gameId).filter(file => file.selected && !file.verified && !file.matched && !file.unavailable);
  if (!files.length) throw new Error('No missing selected files to download');
  for (const file of files) if (db.query(`SELECT 1 FROM download_files snapshot JOIN download_jobs job ON job.id=snapshot.job_id
    WHERE job.vault_id=? AND job.game_id!=? AND snapshot.file_key=? AND job.state IN ('queued','downloading','verifying','paused','error') LIMIT 1`)
    .get(vaultId, gameId, file.key)) throw new Error('DLC is still in a legacy parent download; finish or cancel that job first');
  if (jobsFor(gameId).some(job => ['queued', 'downloading', 'paused', 'verifying'].includes(job.state))) throw new Error('Game already in queue');
  const destination = folderName(game);
  const job = db.transaction(() => {
    const created = db.query('INSERT INTO download_jobs(game_id,state,created_at,updated_at,total,desired_hash,vault_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(gameId, 'queued', now(), now(), files.reduce((sum, file) => sum + file.size, 0), desiredFingerprint(filesFor(gameId)), vaultId) as { id: number };
    const insert = db.query('INSERT INTO download_files(job_id,file_key,snapshot,destination) VALUES (?,?,?,?)');
    for (const file of files) insert.run(created.id, file.key, JSON.stringify(file), destination);
    return created;
  })();
  activity(`${game.title} queued`); broadcast(); schedule();
  return job.id;
}
export function enqueueWithChildren(gameId: string) {
  if (!settings().vaultPath) throw new Error('Select a vault directory first');
  const game = gameById(gameId);
  if (!game) throw new Error('Game not found');
  const ids = [gameId, ...(game.dlcChildren || []).filter(child => child.selected).map(child => child.id)];
  const started: number[] = [];
  for (const id of new Set(ids)) {
    if (!filesFor(id).some(file => file.selected && !file.verified && !file.matched) ||
      jobsFor(id).some(job => ['queued', 'downloading', 'paused', 'verifying'].includes(job.state))) continue;
    started.push(enqueue(id));
  }
  if (!started.length) throw new Error('No missing selected files to download');
  return started;
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
    if (action === 'resume') {
      const unavailable = filesFor(job.gameId).some(file => file.selected && file.unavailable &&
        db.query("SELECT 1 FROM download_files WHERE job_id=? AND file_key=? AND state!='complete'").get(id, file.key));
      if (unavailable) throw new Error('Refresh GOG metadata before retrying an unavailable file');
      const selected = new Map(filesFor(job.gameId).map(file => [file.key, file.selected]));
      const obsolete = (db.query("SELECT file_key FROM download_files WHERE job_id=? AND state!='complete'").all(id) as { file_key: string }[])
        .filter(file => selected.get(file.file_key) === false);
      db.transaction(() => {
        for (const file of obsolete) db.query('DELETE FROM download_files WHERE job_id=? AND file_key=?').run(id, file.file_key);
        if (obsolete.length) {
          const remaining = db.query('SELECT state,bytes,snapshot FROM download_files WHERE job_id=?').all(id) as { state: string; bytes: number; snapshot: string }[];
          const completed = remaining.filter(file => file.state === 'complete').reduce((total, file) => total + file.bytes, 0);
          const total = completed + remaining.filter(file => file.state !== 'complete').reduce((sum, file) => sum + (JSON.parse(file.snapshot) as RemoteFile).size, 0);
          db.query('UPDATE download_jobs SET bytes=?,total=?,speed=0,current_file=?,desired_hash=? WHERE id=?')
            .run(completed, total, '', desiredFingerprint(filesFor(job.gameId)), id);
        }
        changeJob(id, next);
        db.query("UPDATE download_jobs SET error='',error_details='' WHERE id=?").run(id);
      })();
    } else changeJob(id, next);
    if (action !== 'resume') running.get(id)?.abort();
    if (action === 'resume') schedule();
  }
  broadcast();
}
export function cancelObsoleteSnapshots(gameId: string, currentKeys: ReadonlySet<string>) {
  const pending = db.query(`SELECT DISTINCT job.id, snapshot.file_key FROM download_jobs job
    JOIN download_files snapshot ON snapshot.job_id=job.id
    WHERE job.game_id=? AND job.state IN ('queued','downloading','verifying','paused','error') AND snapshot.state!='complete'`)
    .all(gameId) as { id: number; file_key: string }[];
  for (const id of new Set(pending.filter(row => !currentKeys.has(row.file_key)).map(row => row.id))) {
    if (jobsFor().some(job => job.id === id)) command(id, 'cancel');
    else changeJob(id, 'cancelled');
  }
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
      if ((db.query('SELECT vault_id FROM download_jobs WHERE id=?').get(job.id) as { vault_id: number } | null)?.vault_id !== activeVault()?.id) continue;
      running.set(job.id, controller);
      const task = run(job, controller).finally(() => { running.delete(job.id); inFlight.delete(task); broadcast(); schedule(); });
      inFlight.add(task);
    }
  }).catch(() => { scheduling = false; });
}
async function run(job: Job, controller: AbortController) {
  const jobVaultId = (db.query('SELECT vault_id FROM download_jobs WHERE id=?').get(job.id) as { vault_id: number }).vault_id;
  if (!jobVaultId || jobVaultId !== activeVault()?.id) return;
  const game = gameById(job.gameId);
  if (!game) return;
  let lastWrite = 0; let lastBytes = 0; let lastTime = Date.now();
  let stage = 'resolve_manifest'; let httpStatus: number | null = null; let activeFile: RemoteFile | undefined;
  try {
    changeJob(job.id, 'downloading'); broadcast();
    const pending = db.query('SELECT file_key,bytes,snapshot,destination FROM download_files WHERE job_id=? AND state!=?').all(job.id, 'complete') as { file_key: string; bytes: number; snapshot: string; destination: string }[];
    pending.sort((left, right) => {
      const first = JSON.parse(left.snapshot || '{}') as RemoteFile;
      const second = JSON.parse(right.snapshot || '{}') as RemoteFile;
      const order: RemoteFile['category'][] = ['main', 'dlc', 'patches', 'languagePacks', 'extras', 'other'];
      const categoryOrder = order.indexOf(first.category) - order.indexOf(second.category);
      if (categoryOrder) return categoryOrder;
      const leftPart = partNumber(first.name || '');
      const rightPart = partNumber(second.name || '');
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
        saveFileState(job.gameId, file.key, { ...file, name: filename, matched: true, verified: true,
          verificationSource: verification?.source || 'gog-checksum', verifiedSize: verification?.size || file.size,
          checksumUrl: verification?.checksumUrl || '' }, jobVaultId);
        db.query("UPDATE download_files SET state='complete',bytes=? WHERE job_id=? AND file_key=?").run(verification?.size || file.size, job.id, file.key);
        if (verification) db.query('UPDATE download_jobs SET total=total+? WHERE id=?').run(verification.size - file.size, job.id);
        if (verification && info) db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vault_id,game_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,verified_at=excluded.verified_at')
          .run(jobVaultId, game.id, filename, verification.size, Math.round(info.mtimeMs), verification.sha256, now());
      })();
      changeJob(job.id, 'downloading');
    }
    if (controller.signal.aborted) return;
    changeJob(job.id, 'verifying'); broadcast();
    stage = 'indexing';
    await scanGame(job.gameId);
    const snapshot = db.query('SELECT desired_hash FROM download_jobs WHERE id=?').get(job.id) as { desired_hash: string };
    saveLocalGame(job.gameId, { archivedHash: game.manifestHash, archivedSelectedHash: snapshot.desired_hash || desiredFingerprint(filesFor(job.gameId)) }, jobVaultId);
    if (mediaFor(job.gameId).some(asset => asset.selected && !asset.external && !asset.localPath)) {
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
      if (activeFile && stage === 'resolve_downlink' && /^GOG \/products\/.* returned HTTP 404$/.test(message)) {
        db.query('UPDATE remote_files SET unavailable=1 WHERE game_id=? AND key=? AND downlink=?')
          .run(job.gameId, activeFile.key, activeFile.downlink);
      }
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