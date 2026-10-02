import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, lstat, realpath, readdir, rename, rm, unlink, rmdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { activeVault, db, gameById, hasIndexedLinkedFile, jobsFor, now, activity } from './db';
import { folderName, finalizeImportedGame, inspectImport, vaultPath } from './storage';
import { withinRoot } from './paths';
import { localSha256 } from './transfer';

export type ImportState = 'queued' | 'analyzing' | 'copying' | 'hashing' | 'verifying' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
export type ImportFailure = { stage: string; sourcePath: string; destinationPath: string; filename: string;
  code: string; safeMessage: string; technicalMessage: string; retryable: boolean };
export type ImportJob = { id: string; batchId: string; gameId: string; source: string; mode: 'copy' | 'move'; destination: string;
  state: ImportState; createdAt: string; startedAt: string; completedAt: string; bytes: number; total: number;
  speed: number; currentFile: string; filesDone: number; filesTotal: number; errorDetails: ImportFailure | null };
type Row = { id: string; batch_id: string; game_id: string; source: string; signature: string; mode: 'copy' | 'move';
  destination: string; staged_path: string; vault_id: number | null; state: ImportState; created_at: string; started_at: string;
  completed_at: string; bytes: number; total: number; speed: number; current_file: string; files_done: number;
  files_total: number; error_details: string };
type SavedFile = { name: string; size: number; mtime_ms: number; sha256: string; state: string };
const active = new Map<string, AbortController>();
const inFlight = new Set<Promise<void>>();
const listeners = new Set<(jobs: ImportJob[]) => void>();
let stopping = false;
let scheduling = false;
let timer: ReturnType<typeof setInterval> | undefined;

export function importJobs(): ImportJob[] {
  return (db.query('SELECT * FROM import_jobs WHERE vault_id=? ORDER BY created_at DESC').all(activeVault()?.id || -1) as Row[]).map(row => ({
    id: row.id, batchId: row.batch_id, gameId: row.game_id, source: row.source, mode: row.mode,
    destination: row.destination, state: row.state, createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, bytes: row.bytes, total: row.total, speed: row.speed, currentFile: row.current_file,
    filesDone: row.files_done, filesTotal: row.files_total, errorDetails: row.error_details ? JSON.parse(row.error_details) as ImportFailure : null
  }));
}
export function subscribeImports(listener: (jobs: ImportJob[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function broadcast() { const jobs = importJobs(); for (const listener of listeners) listener(jobs); }
export function enqueueImports(entries: { source: string; id: string; signature: string }[], mode: 'copy' | 'move') {
  if (stopping) throw new Error('Import service is stopping');
  if (!entries.length || entries.length > 100 || !['copy', 'move'].includes(mode)) throw new Error('Select up to 100 import folders and a valid mode');
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || new Set(entries.map(entry => entry.source.toLowerCase())).size !== entries.length)
    throw new Error('Select each game and source folder only once');
  const batchId = randomUUID();
  const vaultId = activeVault()?.id;
  if (!vaultId) throw new Error('Select a vault directory first');
  const createdAt = now();
  db.transaction(() => {
    for (const entry of entries) {
      if (!isAbsolute(entry.source) || entry.source.includes('\0') || !/^[a-f0-9]{64}$/.test(entry.signature)) throw new Error('Invalid import source or preview signature');
      const game = gameById(entry.id);
      if (!game || game.folder || hasIndexedLinkedFile(entry.id, vaultId)) throw new Error('Product already has archived files or is not in the library');
      if (jobsFor(entry.id).some(job => ['queued', 'downloading', 'verifying', 'paused'].includes(job.state))) throw new Error('Finish this game download before importing');
      if (db.query("SELECT 1 FROM import_jobs WHERE vault_id=? AND game_id=? AND state NOT IN ('completed','cancelled') LIMIT 1").get(vaultId, entry.id)) throw new Error('An import job already exists for this game in this vault');
      db.query('INSERT INTO import_jobs(id,batch_id,game_id,source,signature,mode,destination,created_at,vault_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), batchId, entry.id, entry.source, entry.signature, mode, folderName(game), createdAt, vaultId);
    }
  })();
  broadcast(); scheduleImports();
  return { importJobId: batchId, status: 'queued' as const };
}
export function importCommand(id: string, action: 'cancel' | 'retry' | 'remove') {
  const row = db.query('SELECT * FROM import_jobs WHERE id=?').get(id) as Row | null;
  if (!row) throw new Error('Import job not found');
  if (row.vault_id !== activeVault()?.id) throw new Error('Select the destination vault before changing this import');
  if (action === 'remove') {
    if (row.state !== 'completed' || active.has(id)) throw new Error('Only completed imports can be removed; stopped imports may have recoverable staged files');
    db.transaction(() => {
      db.query('DELETE FROM import_files WHERE job_id=?').run(id);
      db.query('DELETE FROM import_jobs WHERE id=? AND vault_id=?').run(id, row.vault_id);
    })();
  } else if (action === 'cancel') {
    if (['completed', 'failed', 'cancelled', 'finalizing'].includes(row.state)) throw new Error('Import cannot be cancelled in this state');
    db.query("UPDATE import_jobs SET state='cancelled',completed_at=?,speed=0 WHERE id=?").run(now(), id);
    active.get(id)?.abort();
  } else {
    if (row.state !== 'failed' && row.state !== 'cancelled') throw new Error('Only stopped imports can be retried');
    if (active.has(id)) throw new Error('Import is still stopping; retry after cancellation finishes');
    if (row.error_details && !(JSON.parse(row.error_details) as ImportFailure).retryable) throw new Error('Import requires manual review before retrying');
    db.query("UPDATE import_jobs SET state='queued',error_details='',completed_at='',speed=0 WHERE id=?").run(id);
    scheduleImports();
  }
  broadcast();
}
export function startImports() {
  db.query("UPDATE import_jobs SET state='failed',error_details=? WHERE vault_id IS NULL AND state NOT IN ('completed','failed','cancelled')")
    .run(JSON.stringify({ stage: 'recovery', sourcePath: '', destinationPath: '', filename: '', code: '', safeMessage: 'Legacy import has no known destination vault; inspect before retrying', technicalMessage: 'Unknown destination vault', retryable: false }));
  db.query("UPDATE import_jobs SET state='queued',speed=0 WHERE state IN ('analyzing','copying','hashing','verifying')").run();
  db.query("UPDATE import_jobs SET state='failed',error_details=?,completed_at=? WHERE state='deleting_source'")
    .run(JSON.stringify({ stage: 'delete_source', sourcePath: '', destinationPath: '', filename: '', code: '',
      safeMessage: 'MOVE cleanup was interrupted; inspect source and destination before retrying',
      technicalMessage: 'MOVE cleanup was interrupted; inspect source and destination before retrying', retryable: false }), now());
  db.query("UPDATE import_jobs SET state='queued' WHERE state='finalizing'").run();
  scheduleImports();
  timer = setInterval(scheduleImports, 5000);
  timer.unref();
}
export async function shutdownImports() {
  stopping = true;
  if (timer) clearInterval(timer);
  for (const controller of active.values()) controller.abort();
  await Promise.allSettled([...inFlight]);
  db.query("UPDATE import_jobs SET state='queued',speed=0 WHERE state IN ('analyzing','copying','hashing','verifying')").run();
}
function scheduleImports() {
  if (scheduling || stopping || active.size) return;
  scheduling = true;
  void vaultPath().then(() => {
    scheduling = false;
    if (stopping || active.size) return;
    const row = db.query("SELECT * FROM import_jobs WHERE state='queued' AND vault_id=? ORDER BY created_at,id LIMIT 1").get(activeVault()?.id || -1) as Row | null;
    if (!row) return;
    const controller = new AbortController();
    active.set(row.id, controller);
    const task = runImport(row, controller.signal).finally(() => {
      active.delete(row.id); inFlight.delete(task); broadcast(); scheduleImports();
    });
    inFlight.add(task);
  }).catch(() => { scheduling = false; });
}
function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : 'Import failed')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(token|secret|signature|sig|key)=([^&\s]+)/gi, '$1=[redacted]');
}
async function runImport(job: Row, signal: AbortSignal) {
  let stage: ImportState | 'indexing' | 'delete_source' = 'analyzing';
  let filename = '';
  let destination = '';
  const setState = (state: ImportState) => {
    stage = state;
    db.query('UPDATE import_jobs SET state=?,current_file=? WHERE id=?').run(state, filename, job.id);
    broadcast();
  };
  const checkStopped = () => { if (signal.aborted) throw new Error('Import cancelled'); };
  try {
    if (job.vault_id !== activeVault()?.id) throw new Error('Import destination vault changed');
    db.query("UPDATE import_jobs SET state='analyzing',started_at=? WHERE id=?").run(now(), job.id);
    broadcast();
    const plan = await inspectImport(job.source);
    if (!plan.entries.length || plan.signature !== job.signature) throw new Error('Import source changed since preview; review it again');
    const game = gameById(job.game_id);
    if (!game) throw new Error('Game is not in the library');
    if (hasIndexedLinkedFile(job.game_id, job.vault_id || undefined)) throw new Error('DLC already has indexed archive bytes; avoid importing a second copy');
    const base = await vaultPath();
    const recorded = db.query('SELECT root_path FROM vaults WHERE id=?').get(job.vault_id) as { root_path: string } | null;
    if (!recorded || recorded.root_path !== base) throw new Error('Import destination root changed');
    destination = withinRoot(base, job.destination);
    let staged = job.staged_path || withinRoot(base, `.__gogvault_import_${job.id}`);
    const committed = await lstat(destination).then(info => info.isDirectory()).catch(() => false);
    const marker = join('.gog-vault', 'import-job.json');
    if (committed) {
      const recorded = await readFile(join(destination, marker), 'utf8').then(JSON.parse).catch(() => null);
      if (recorded?.id !== job.id) throw new Error('Destination already exists; no files were overwritten');
      if (game.folder && game.folder !== job.destination) throw new Error('Game folder mapping changed since import');
      staged = destination;
    } else {
      if (game.folder) throw new Error('Game already has a vault folder');
      if (await lstat(staged).then(info => !info.isDirectory() || info.isSymbolicLink()).catch(() => false)) throw new Error('Unsafe import staging folder');
      await mkdir(staged, { recursive: true });
    }
    db.query('UPDATE import_jobs SET staged_path=?,total=?,files_total=? WHERE id=?').run(staged, plan.bytes, plan.entries.length, job.id);
    const previous = new Map((db.query('SELECT * FROM import_files WHERE job_id=?').all(job.id) as SavedFile[]).map(file => [file.name, file]));
    db.transaction(() => {
      for (const entry of plan.entries) {
        const saved = previous.get(entry.name);
        if (saved && (saved.size !== entry.size || saved.mtime_ms !== entry.mtimeMs)) throw new Error('Import source changed since last attempt');
        db.query('INSERT OR IGNORE INTO import_files(job_id,name,size,mtime_ms) VALUES (?,?,?,?)').run(job.id, entry.name, entry.size, entry.mtimeMs);
      }
    })();
    let completedBytes = 0;
    let filesDone = 0;
    let speed = 0;
    for (const entry of plan.entries) {
      checkStopped();
      filename = entry.name;
      const original = withinRoot(plan.origin, entry.name);
      const target = withinRoot(staged, entry.name);
      const saved = (db.query('SELECT * FROM import_files WHERE job_id=? AND name=?').get(job.id, entry.name) as SavedFile);
      if (saved.state === 'verified' && saved.sha256 && await lstat(target).then(info => info.isFile() && info.size === entry.size).catch(() => false)
        && await localSha256(target) === saved.sha256 && await localSha256(original) === saved.sha256) {
        completedBytes += entry.size; filesDone++;
        db.query('UPDATE import_jobs SET bytes=?,files_done=?,current_file=? WHERE id=?').run(completedBytes, filesDone, filename, job.id);
        broadcast();
        continue;
      }
      if (committed) throw new Error(`Committed import file changed: ${entry.name}`);
      const info = await lstat(original);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || Math.round(info.mtimeMs) !== entry.mtimeMs || await realpath(original) !== original)
        throw new Error('Source file changed since preview');
      if (await lstat(target).then(() => true).catch(() => false)) throw new Error('Import destination file already exists; review before retrying');
      await mkdir(dirname(target), { recursive: true });
      const partial = `${target}.part`;
      const partialInfo = await lstat(partial).catch(() => null);
      if (partialInfo && (!partialInfo.isFile() || partialInfo.isSymbolicLink())) throw new Error('Unsafe import partial file');
      if (partialInfo) await unlink(partial);
      setState('copying');
      const handle = await open(partial, 'wx');
      const hash = createHash('sha256');
      let written = 0;
      let lastAt = Date.now();
      let lastBytes = 0;
      try {
        for await (const chunk of createReadStream(original, { highWaterMark: 1024 * 1024, signal })) {
          checkStopped();
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error('Destination write made no progress');
            offset += bytesWritten;
          }
          written += chunk.length;
          const time = Date.now();
          if (time - lastAt >= 350) {
            speed = speed * 0.7 + ((written - lastBytes) * 1000 / (time - lastAt)) * 0.3;
            db.query('UPDATE import_jobs SET bytes=?,speed=?,current_file=? WHERE id=?').run(completedBytes + written, speed, filename, job.id);
            lastBytes = written; lastAt = time; broadcast();
          }
        }
        await handle.sync();
      } finally { await handle.close(); }
      checkStopped();
      setState('hashing');
      const sha256 = hash.digest('hex');
      const updated = await lstat(original);
      if (written !== entry.size || updated.size !== entry.size || Math.round(updated.mtimeMs) !== entry.mtimeMs || (await lstat(partial)).size !== entry.size)
        throw new Error('File size or source timestamp changed during copy');
      setState('verifying');
      if (await localSha256(partial, signal) !== sha256) throw new Error('Destination SHA-256 differs from source; source retained');
      checkStopped();
      await rename(partial, target);
      db.query("UPDATE import_files SET state='verified',sha256=? WHERE job_id=? AND name=?").run(sha256, job.id, filename);
      completedBytes += entry.size; filesDone++;
      db.query('UPDATE import_jobs SET bytes=?,files_done=?,speed=0 WHERE id=?').run(completedBytes, filesDone, job.id);
      broadcast();
    }
    checkStopped();
    setState('finalizing');
    if (!committed) {
      const markerPath = withinRoot(staged, marker.replaceAll('\\', '/'));
      await mkdir(dirname(markerPath), { recursive: true });
      if (await lstat(markerPath).then(() => true).catch(() => false)) throw new Error('Import marker collision in source folder');
      await writeFile(markerPath, JSON.stringify({ id: job.id, gameId: job.game_id }));
      if (await lstat(destination).then(() => true).catch(() => false)) throw new Error('Destination already exists; no files were overwritten');
      if (hasIndexedLinkedFile(job.game_id, job.vault_id || undefined)) throw new Error('DLC already has indexed archive bytes; avoid importing a second copy');
      await rename(staged, destination);
      staged = destination;
      db.query('UPDATE import_jobs SET staged_path=? WHERE id=?').run(destination, job.id);
    }
    const verifiedFiles = db.query('SELECT name,size,sha256 FROM import_files WHERE job_id=? AND state=?').all(job.id, 'verified') as { name: string; size: number; sha256: string }[];
    if (verifiedFiles.length !== plan.entries.length) throw new Error('Import contains unverified files');
    if (committed) for (const file of verifiedFiles) if (await localSha256(withinRoot(destination, file.name)) !== file.sha256) throw new Error(`Committed file failed SHA-256 verification: ${file.name}`);
    stage = 'indexing';
    db.query('UPDATE import_jobs SET current_file=? WHERE id=?').run('Indexing local archive', job.id);
    broadcast();
    await finalizeImportedGame(job.game_id, job.destination, verifiedFiles);
    if (job.mode === 'move') {
      for (const file of verifiedFiles) if (await localSha256(withinRoot(plan.origin, file.name)) !== file.sha256)
        throw new Error(`Source changed; no source files were removed: ${file.name}`);
      stage = 'delete_source';
      db.query("UPDATE import_jobs SET state='deleting_source' WHERE id=?").run(job.id);
      broadcast();
      for (const file of verifiedFiles) await unlink(withinRoot(plan.origin, file.name));
      const folders = [...new Set(verifiedFiles.flatMap(file => {
        const parts = file.name.split('/');
        return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
      }))].sort((left, right) => right.length - left.length);
      for (const folder of folders) await rmdir(withinRoot(plan.origin, folder)).catch(() => {});
      await rmdir(plan.origin).catch(() => {});
    }
    db.query("UPDATE import_jobs SET state='completed',completed_at=?,speed=0,current_file='' WHERE id=?").run(now(), job.id);
    activity(`${game.title} imported by verified ${job.mode}`);
  } catch (error) {
    if (signal.aborted || (db.query('SELECT state FROM import_jobs WHERE id=?').get(job.id) as { state: string }).state === 'cancelled') {
      if (!stopping) db.query("UPDATE import_jobs SET state='cancelled',completed_at=?,speed=0 WHERE id=?").run(now(), job.id);
    } else {
      const message = safeMessage(error);
      const details: ImportFailure = { stage, sourcePath: job.source, destinationPath: destination, filename,
        code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '',
        safeMessage: message, technicalMessage: message, retryable: stage !== 'delete_source' && !/changed|collision|already exists|unsafe/i.test(message) };
      db.query("UPDATE import_jobs SET state='failed',error_details=?,completed_at=?,speed=0 WHERE id=?").run(JSON.stringify(details), now(), job.id);
      console.error(JSON.stringify({ event: 'import_failure', at: now(), jobId: job.id, gameId: job.game_id, stage, filename, code: details.code, message }));
    }
  } finally { broadcast(); }
}