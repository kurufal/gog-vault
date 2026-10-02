import { mkdir, readdir, realpath, stat, writeFile, readFile, rename, unlink, access, constants, lstat, copyFile, rm, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import { desiredFingerprint, normalizeTitle, safeName, type Game } from '../shared/domain';
import { withinRoot } from './paths';
import { scoreFolder } from './matching';
import { activeVault, activity, configDir, db, filesFor, gameById, games, hasIndexedLinkedFile, jobsFor, localGameRow, mapVaultGame, mediaFor, now, saveFileState, saveLocalGame, settings } from './db';
import { secureLink, trustedGogUrl } from './gog/products';
import { localSha256, verifyFile } from './transfer';

export async function vaultPath(relativePath = ''): Promise<string> {
  const selected = settings().vaultPath;
  if (!selected) throw new Error('Select a vault directory first');
  if (!isAbsolute(selected) || selected.includes('\0')) throw new Error('Invalid vault directory');
  const root = await realpath(selected);
  const path = withinRoot(root, relativePath);
  const real = await realpath(path);
  if (real !== root && !real.startsWith(root + sep)) throw new Error('Path escapes vault through a symlink');
  if (!(await stat(real)).isDirectory()) throw new Error('Not a directory');
  return real;
}
export async function storageInfo() { return statfsInfo(await vaultPath()); }
export async function selectVault(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Select an absolute directory');
  const real = await realpath(path);
  if (!(await stat(real)).isDirectory()) throw new Error('Not a directory');
  await access(real, constants.R_OK | constants.W_OK);
  const capacity = await statfsInfo(real);
  if (capacity.available !== null && capacity.available <= 0) throw new Error('Vault directory has no free space');
  return real;
}
async function statfsInfo(path: string) {
  const { statfs } = await import('node:fs/promises');
  let writable = true;
  try { await access(path, constants.W_OK); } catch { writable = false; }
  let total: number | null = null;
  let free: number | null = null;
  let available: number | null = null;
  if (process.platform !== 'win32') try {
    const data = await statfs(path, { bigint: true });
    const capacity = data.blocks * data.bsize;
    const unallocated = data.bfree * data.bsize;
    const accessible = data.bavail * data.bsize;
    if (capacity > 0n && unallocated <= capacity && accessible <= unallocated && capacity <= BigInt(Number.MAX_SAFE_INTEGER)) {
      total = Number(capacity); free = Number(unallocated); available = Number(accessible);
    }
  } catch {}
  const indexedBytes = (db.query("SELECT COALESCE(SUM(local_size),0) AS bytes FROM vault_games WHERE vault_id=? AND folder!=''").get(activeVault()?.id || -1) as { bytes: number }).bytes;
  return { writable, online: true, total, free, available, indexedBytes, appDataPath: resolve(configDir) };
}
export function folderName(game: Game): string {
  const preferred = safeName(game.title);
  const occupied = db.query('SELECT game_id FROM vault_games WHERE vault_id=? AND folder=? COLLATE NOCASE AND game_id!=?').get(activeVault()?.id || -1, preferred, game.id);
  return game.folder || (occupied ? `${preferred.slice(0, 140)} [${game.id}]` : preferred);
}
export async function gameFolder(game: Game, create = false, destination = folderName(game)): Promise<string> {
  const base = await vaultPath();
  const folder = destination;
  if (folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') throw new Error('Invalid game folder mapping');
  if (game.folder && game.folder !== folder) throw new Error('Game folder mapping changed since queueing');
  const target = withinRoot(base, folder);
  if (create) {
    if (!game.folder && await lstat(target).then(() => true).catch(() => false)) throw new Error('Existing game folder must be scanned or linked first');
    await mkdir(target, { recursive: true });
    mapVaultGame(game.id, folder);
  }
  const real = await realpath(target);
  if (!real.startsWith(base + sep)) throw new Error('Game folder escapes vault');
  return real;
}
export async function mapFolder(gameId: string, folder: string) {
  const game = gameById(gameId);
  if (!game) throw new Error('Game not found');
  const base = await vaultPath();
  const real = await realpath(isAbsolute(folder) ? folder : withinRoot(base, folder));
  const name = relative(base, real);
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\') || !(await stat(real)).isDirectory()) throw new Error('Select a direct child of the vault');
  const existing = db.query('SELECT game_id FROM vault_games WHERE vault_id=? AND folder=? COLLATE NOCASE AND game_id!=?').get(activeVault()?.id || -1, name, gameId);
  if (existing) throw new Error('Folder already linked to another game');
  mapVaultGame(gameId, name);
  db.query('DELETE FROM unlinked_folders WHERE vault_id=? AND folder=?').run(activeVault()?.id || -1, name);
  activity(`${game.title} linked to a local folder`);
}
export async function linkAndScan(gameId: string, folder: string) {
  const previous = gameById(gameId)?.folder;
  if (previous === undefined) throw new Error('Game not found');
  await mapFolder(gameId, folder);
  try {
    const game = await scanGame(gameId);
    scanState.unlinked = scanState.unlinked.filter(item => item !== game.folder);
    return game;
  } catch (error) {
    mapVaultGame(gameId, previous);
    const base = await vaultPath();
    const mapped = gameById(gameId)?.folder;
    if (!mapped) db.query('INSERT OR IGNORE INTO unlinked_folders(vault_path,folder,discovered_at,vault_id) VALUES (?,?,?,?)').run(base, folder, now(), activeVault()?.id || -1);
    throw error;
  }
}
async function sameDirectory(source: string, target: string): Promise<boolean> {
  const destination = await lstat(target).catch(() => null);
  if (!destination || destination.isSymbolicLink() || !destination.isDirectory()) return false;
  const origin = await lstat(source);
  if (origin.ino && destination.ino && origin.dev === destination.dev && origin.ino === destination.ino) return true;
  return process.platform === 'win32' && (await realpath(source)).toLowerCase() === (await realpath(target)).toLowerCase();
}
async function moveFolder(source: string, target: string) {
  if (source.toLowerCase() !== target.toLowerCase() || source === target) return rename(source, target);
  const temporary = join(await vaultPath(), `.__gogvault_rename_${randomUUID()}`);
  if (await lstat(temporary).then(() => true).catch(() => false)) throw new Error(`Temporary destination occupied: ${temporary}`);
  await rename(source, temporary);
  try { await rename(temporary, target); }
  catch (error) {
    try { await rename(temporary, source); }
    catch { throw new Error(`Recovery required: ${source} was moved to ${temporary}; intended destination ${target}`); }
    throw error;
  }
}
export async function organizePreview() {
  const base = await vaultPath();
  const proposals = [];
  const all = games();
  for (const game of all.filter(item => item.folder && item.folder !== safeName(item.title))) {
    const target = safeName(game.title);
    const source = await gameFolder(game).catch(() => null);
    if (!source) continue;
    const proposed = withinRoot(base, target);
    const existing = await lstat(proposed).then(() => true).catch(() => false);
    const sameSource = existing && await sameDirectory(source, proposed);
    const conflictWith = all.filter(other => other.id !== game.id && (other.folder.toLowerCase() === target.toLowerCase() || safeName(other.title) === target)).map(other => other.id);
    let confidence: 'high' | 'review' = 'review';
    try {
      const metadata = join(source, '.gog-vault', 'metadata.json');
      if ((await lstat(metadata)).size < 131072 && String(JSON.parse(await readFile(metadata, 'utf8')).id) === game.id) confidence = 'high';
    } catch {}
    proposals.push({ id: game.id, title: game.title, current: source, proposed, target,
      conflict: existing && !sameSource || conflictWith.length > 0, conflictWith, confidence });
  }
  return proposals;
}
export async function organizeGame(id: string) {
  const game = gameById(id);
  if (!game?.folder) throw new Error('Link a game folder before organizing');
  if (jobsFor(id).some(job => ['queued', 'downloading', 'verifying', 'paused'].includes(job.state))) throw new Error('Finish or cancel this game\'s queue job before organizing');
  const proposal = (await organizePreview()).find(item => item.id === id);
  if (!proposal) throw new Error('Folder is already organized');
  if (proposal.conflict) throw new Error('Destination folder already exists; review the conflict');
  const source = await gameFolder(game);
  if (source !== proposal.current) throw new Error('Game folder changed since preview');
  if (await lstat(proposal.proposed).then(() => true).catch(() => false) && !await sameDirectory(source, proposal.proposed)) throw new Error('Destination folder already exists');
  await moveFolder(source, proposal.proposed);
  try {
    const result = db.query('UPDATE vault_games SET folder=? WHERE vault_id=? AND game_id=? AND folder=?').run(proposal.target, activeVault()?.id || -1, id, game.folder);
    if (!result.changes) throw new Error('Game folder mapping changed during rename');
  }
  catch (error) {
    try { await moveFolder(proposal.proposed, source); }
    catch { throw new Error(`Recovery required: ${game.id} moved from ${source} to ${proposal.proposed} but the database update and rollback failed`); }
    throw error;
  }
  activity(`${game.title} folder organized`);
  return scanGame(id);
}
export type ImportEntry = { name: string; size: number; mtimeMs: number };
export async function inspectImport(source: string) {
  if (!isAbsolute(source) || source.includes('\0') || (await lstat(source)).isSymbolicLink()) throw new Error('Select a regular external folder');
  const origin = await realpath(source);
  const vault = await vaultPath();
  const lower = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (lower(origin) === lower(vault) || lower(origin).startsWith(lower(vault) + sep) || lower(vault).startsWith(lower(origin) + sep)) throw new Error('Import source must be outside the vault');
  if (!(await lstat(origin)).isDirectory()) throw new Error('Import source is not a folder');
  const entries: ImportEntry[] = [];
  const folders = [''];
  for (const folder of folders) {
    for (const item of await readdir(join(origin, folder), { withFileTypes: true })) {
      if (item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) throw new Error('Import contains a link or unsupported file');
      const name = folder ? `${folder}/${item.name}` : item.name;
      if (item.isDirectory()) folders.push(name);
      else {
        const info = await lstat(join(origin, name));
        entries.push({ name, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
        if (entries.length > 100000) throw new Error('Import contains too many files');
      }
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  let metadataId = '';
  const metadata = entries.find(item => item.name === '.gog-vault/metadata.json');
  if (metadata && metadata.size < 131072) try { metadataId = String(JSON.parse(await readFile(join(origin, metadata.name), 'utf8')).id || ''); } catch {}
  const signature = createHash('sha256').update(JSON.stringify({ origin, metadataId, entries })).digest('hex');
  return { origin, entries, metadataId, signature, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
}
export async function importPreview(root: string) {
  const checked = await inspectImport(root);
  const subfolders = (await readdir(checked.origin, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const hasInstallerAtRoot = checked.metadataId || checked.entries.some(entry => !entry.name.includes('/') && /\.(exe|bin|dmg|pkg|zip|sh)$/i.test(entry.name));
  const sources = subfolders.length && !hasInstallerAtRoot
    ? subfolders.map(entry => join(checked.origin, entry.name)) : [checked.origin];
  return Promise.all(sources.map(async source => {
    try {
      const plan = await inspectImport(source);
      const candidates = games().filter(game => !game.folder || plan.metadataId === game.id).map(game => scoreFolder(source.split(/[\\/]/).pop() || '', game,
        { metadataId: plan.metadataId, localFiles: plan.entries.filter(entry => !entry.name.includes('/')), expectedFiles: filesFor(game.id).filter(file => file.category === 'main') }))
        .filter((item): item is NonNullable<typeof item> => !!item).map(item => ({ ...item, existingFolder: !!gameById(item.id)?.folder || hasIndexedLinkedFile(item.id) }))
        .sort((left, right) => right.confidence - left.confidence).slice(0, 5);
      return { source: plan.origin, files: plan.entries.length, bytes: plan.bytes, signature: plan.signature, metadataId: plan.metadataId, candidates, error: '' };
    } catch (error) { return { source, files: 0, bytes: 0, signature: '', metadataId: '', candidates: [], error: error instanceof Error ? error.message : 'Cannot inspect folder' }; }
  }));
}
export async function importGame(source: string, id: string, signature: string, mode: 'copy' | 'move') {
  if (mode !== 'copy' && mode !== 'move') throw new Error('Invalid import mode');
  const plan = await inspectImport(source);
  if (!plan.entries.length || plan.signature !== signature) throw new Error('Import source changed since preview; review it again');
  const game = gameById(id);
  if (!game || game.folder || hasIndexedLinkedFile(id) || plan.metadataId && plan.metadataId !== id) throw new Error('Product mapping conflicts with local metadata or existing folder');
  if (jobsFor(id).some(job => ['queued', 'downloading', 'verifying', 'paused'].includes(job.state))) throw new Error('Finish this game download before importing');
  const base = await vaultPath();
  const folder = folderName(game);
  const destination = withinRoot(base, folder);
  if (await lstat(destination).then(() => true).catch(() => false)) throw new Error('Destination already exists; nothing was overwritten');
  const staged = withinRoot(base, `.__gogvault_import_${randomUUID()}`);
  await mkdir(staged);
  let committed = false;
  const copied: { name: string; sha256: string }[] = [];
  try {
    for (const entry of plan.entries) {
      const original = withinRoot(plan.origin, entry.name);
      const info = await lstat(original);
      if (!info.isFile() || info.size !== entry.size || Math.round(info.mtimeMs) !== entry.mtimeMs || await realpath(original) !== original) throw new Error('Import source changed while copying');
      const target = withinRoot(staged, entry.name);
      await mkdir(dirname(target), { recursive: true });
      const sha256 = await localSha256(original);
      await copyFile(original, target, constants.COPYFILE_EXCL);
      if (await localSha256(original) !== sha256 || await localSha256(target) !== sha256) throw new Error('Import copy failed SHA-256 verification; source retained');
      copied.push({ name: entry.name, sha256 });
    }
    if (await lstat(destination).then(() => true).catch(() => false) || gameById(id)?.folder || hasIndexedLinkedFile(id)) throw new Error('Import destination changed during copy');
    await rename(staged, destination);
    committed = true;
    await finalizeImportedGame(id, folder, copied.map(entry => ({ ...entry, size: plan.entries.find(item => item.name === entry.name)!.size })));
    if (mode === 'move') {
      for (const entry of copied) if (await localSha256(withinRoot(plan.origin, entry.name)) !== entry.sha256) throw new Error('Import complete, but source changed; source retained for manual cleanup');
      for (const entry of copied) await unlink(withinRoot(plan.origin, entry.name));
      const folders = [...new Set(plan.entries.flatMap(entry => { const parts = entry.name.split('/'); return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/')); }))].sort((left, right) => right.length - left.length);
      for (const name of folders) await rmdir(withinRoot(plan.origin, name)).catch(() => {});
      await rmdir(plan.origin).catch(() => {});
    }
    activity(`${game.title} imported by verified ${mode}`);
    return { game: gameById(id), files: copied.length, bytes: plan.bytes, mode };
  } finally { if (!committed) await rm(staged, { recursive: true, force: true }); }
}
export async function finalizeImportedGame(id: string, folder: string, copied: { name: string; size: number; sha256: string }[]) {
  await mapFolder(id, folder);
  const root = await gameFolder(gameById(id)!);
  const verified = await Promise.all(copied.map(async entry => ({ ...entry, mtimeMs: Math.round((await lstat(withinRoot(root, entry.name))).mtimeMs) })));
  db.transaction(() => {
    for (const entry of verified) {
      db.query(`INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,game_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,verified_at=excluded.verified_at`)
        .run(activeVault()?.id || -1, id, entry.name, entry.size, entry.mtimeMs, entry.sha256, now());
    }
    for (const file of filesFor(id)) {
      const exact = verified.find(entry => entry.name === file.name && entry.size === file.size);
      if (exact) saveFileState(id, file.key, { ...file, matched: true, verified: true, verificationSource: 'local-sha256', verifiedSize: exact.size });
    }
  })();
  return scanGame(id, false, undefined, new Set(verified.map(entry => entry.name)));
}
export async function findGameFolder(base: string, game: Pick<Game, 'id' | 'title' | 'slug'>, linked: Set<string>): Promise<string | null> {
  const dirs = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !linked.has(entry.name));
  const matches: string[] = [];
  for (const dir of dirs) {
    if (internalFolder(dir.name) || ignoredFolder(base, dir.name)) continue;
    const candidate = scoreFolder(dir.name, game, { ...await folderEvidence(base, dir.name), expectedFiles: filesFor(game.id).filter(file => file.category === 'main') });
    if (candidate?.autoLink) matches.push(dir.name);
  }
  return matches.length === 1 ? matches[0]! : null;
}
const internalFolder = (name: string) => name.toLowerCase() === '.gog-vault' || name.toLowerCase() === 'previous versions' || name.startsWith('.__gogvault_');
const ignoredFolder = (_base: string, folder: string) => !!db.query('SELECT 1 FROM ignored_folders WHERE vault_id=? AND folder=?').get(activeVault()?.id || -1, folder);
async function folderEvidence(base: string, folder: string) {
  const path = withinRoot(base, folder);
  const resolved = await realpath(path);
  if (resolved !== path || !resolved.startsWith(base + sep)) throw new Error('Folder escapes vault');
  let metadataId: string | undefined;
  try {
    const metadata = join(path, '.gog-vault', 'metadata.json');
    const info = await lstat(metadata);
    if (info.isFile() && info.size < 131072) metadataId = String(JSON.parse(await readFile(metadata, 'utf8')).id || '') || undefined;
  } catch {}
  const localFiles = await readdir(path, { withFileTypes: true }).then(async entries => Promise.all(entries.filter(entry => entry.isFile()).map(async entry =>
    ({ name: entry.name, size: (await lstat(join(path, entry.name))).size }))));
  return { metadataId, localFiles };
}
export async function matchingReview() {
  const base = await vaultPath();
  const available = games().filter(game => !game.folder);
  const unresolved = (db.query('SELECT folder FROM unlinked_folders WHERE vault_id=? ORDER BY folder').all(activeVault()?.id || -1) as { folder: string }[]).map(row => row.folder);
  const folders = (await Promise.all(unresolved.map(async folder => {
    const localPath = withinRoot(base, folder);
    const evidence = await folderEvidence(base, folder).catch(() => null);
    if (!evidence) return null;
    const candidates = available.map(game => scoreFolder(folder, game, { ...evidence, expectedFiles: filesFor(game.id).filter(file => file.category === 'main') }))
      .filter((item): item is NonNullable<typeof item> => !!item).sort((left, right) => right.confidence - left.confidence).slice(0, 5);
    return { folder, localPath, candidates };
  }))).filter((item): item is NonNullable<typeof item> => !!item);
  return { folders, ignored: (db.query('SELECT COUNT(*) AS total FROM ignored_folders WHERE vault_id=?').get(activeVault()?.id || -1) as { total: number }).total };
}
export async function ignoreFolder(folder: string) {
  const base = await vaultPath();
  if (!db.query('SELECT 1 FROM unlinked_folders WHERE vault_id=? AND folder=?').get(activeVault()?.id || -1, folder)) throw new Error('Folder is not awaiting a match');
  db.query('INSERT OR IGNORE INTO ignored_folders(vault_path,folder,ignored_at,vault_id) VALUES (?,?,?,?)').run(base, folder, now(), activeVault()?.id || -1);
  db.query('DELETE FROM unlinked_folders WHERE vault_id=? AND folder=?').run(activeVault()?.id || -1, folder);
  scanState.unlinked = scanState.unlinked.filter(item => item !== folder);
  scanState.ignored++;
  return { ignored: true };
}
export async function scanGame(id: string, fullVerify = false, knownFolder?: string | null, imported = new Set<string>(),
  progress?: (done: number, total: number, name: string, bytes: number) => void, signal?: AbortSignal) {
  const game = gameById(id);
  if (!game) throw new Error('Game not found');
  if (!game.folder) {
    const base = await vaultPath();
    const match = knownFolder === undefined ? null : knownFolder;
    if (match) await mapFolder(id, match);
  }
  const current = gameById(id)!;
  if (!current.folder) {
    if (fullVerify) {
      const linked = db.query(`SELECT location.file_key,location.storage_game_id,location.relative_path,physical.size,physical.sha256,storage.folder
        FROM vault_child_file_locations location JOIN vault_local_files physical ON physical.vault_id=location.vault_id
          AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
        JOIN vault_games storage ON storage.vault_id=location.vault_id AND storage.game_id=location.storage_game_id
        WHERE location.vault_id=? AND location.child_product_id=? AND storage.folder!=''`)
        .all(activeVault()?.id || -1, id) as { file_key: string; storage_game_id: string; relative_path: string; size: number; sha256: string; folder: string }[];
      const selected = filesFor(id).filter(file => file.selected);
      let done = 0;
      for (const file of selected) {
        if (signal?.aborted) throw new Error('Verification cancelled');
        const location = linked.find(item => item.file_key === file.key);
        if (!location) continue;
        const storageGame = gameById(location.storage_game_id);
        if (!storageGame?.folder) continue;
        const path = withinRoot(await gameFolder(storageGame), location.relative_path);
        const physical = await lstat(path).catch(() => null);
        const matched = !!physical?.isFile() && physical.size === location.size &&
          (!file.verifiedSize || physical.size === file.verifiedSize);
        let checksum = file.checksumUrl || '';
        if (!checksum) try { checksum = (await secureLink(file)).checksum || ''; } catch {}
        const verified = matched && (checksum ? await verifyFile(path, file.size, checksum, true, signal)
          : (!current.archivedHash || current.archivedHash === current.manifestHash) && !!location.sha256 &&
            await localSha256(path, signal) === location.sha256);
        saveFileState(id, file.key, { ...file, matched, verified, verifiedSize: verified ? physical!.size : 0 });
        if (verified) db.query('UPDATE vault_local_files SET verified_at=? WHERE vault_id=? AND game_id=? AND relative_path=?')
          .run(now(), activeVault()?.id || -1, location.storage_game_id, location.relative_path);
        done++;
        progress?.(done, selected.length, file.name, physical?.size || 0);
      }
      if (selected.length && selected.every(file => filesFor(id).find(current => current.key === file.key)?.verified))
        saveLocalGame(id, { archivedHash: current.manifestHash, archivedSelectedHash: desiredFingerprint(filesFor(id)), scannedAt: now() });
      progress?.(selected.length, selected.length, '', 0);
    }
    return gameById(id)!;
  }
  await vaultPath();
  let path: string;
  try { path = await gameFolder(current); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    db.transaction(() => {
      db.query('DELETE FROM vault_file_state WHERE vault_id=? AND game_id=?').run(activeVault()?.id || -1, id);
      db.query('DELETE FROM vault_local_files WHERE vault_id=? AND game_id=?').run(activeVault()?.id || -1, id);
      saveLocalGame(id, { folder: '', localSize: 0, scannedAt: now(), archivedHash: '', archivedSelectedHash: '' });
    })();
    return gameById(id)!;
  }
  let localSize = 0;
  const local = new Map<string, { size: number; mtimeMs: number }>();
  const directories = [''];
  for (const folder of directories) {
    const entries = await readdir(join(path, folder), { withFileTypes: true });
    for (const entry of entries) {
      const name = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) directories.push(name);
      else if (entry.isFile() && !entry.name.endsWith('.part')) {
        const info = await lstat(join(path, name));
        localSize += info.size;
        local.set(name, { size: info.size, mtimeMs: Math.round(info.mtimeMs) });
      }
    }
  }
  const previous = new Map((db.query('SELECT relative_path,size,mtime_ms,sha256,verified_at FROM vault_local_files WHERE vault_id=? AND game_id=?').all(activeVault()?.id || -1, id) as
    { relative_path: string; size: number; mtime_ms: number; sha256: string; verified_at: string }[]).map(row => [row.relative_path, row]));
  const saveLocal = db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vault_id,game_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,verified_at=excluded.verified_at');
  db.transaction(() => {
    db.query('DELETE FROM vault_local_files WHERE vault_id=? AND game_id=?').run(activeVault()?.id || -1, id);
    for (const [name, info] of local) {
      const cached = previous.get(name);
      const unchanged = cached?.size === info.size && cached.mtime_ms === info.mtimeMs;
      saveLocal.run(activeVault()?.id || -1, id, name, info.size, info.mtimeMs, unchanged ? cached.sha256 : '', unchanged ? cached.verified_at : '');
    }
  })();
  const manifest = filesFor(id).filter(file => !fullVerify || file.selected);
  let done = 0;
  let bytes = 0;
  for (const file of manifest) {
    if (signal?.aborted) throw new Error('Verification cancelled');
    progress?.(done, manifest.length, file.name, bytes);
    let match = local.has(file.name) ? file.name : '';
    let checksum = file.checksumUrl || '';
    let signedName = false;
    if ((!match || fullVerify || file.verificationSource === 'import-identified') && (local.has(file.name) || [...local].some(([name, info]) =>
      info.size === (file.verifiedSize || file.size) || file.selected && !!previous.get(name)?.sha256 && /\.(exe|bin|dmg|pkg|zip|sh)$/i.test(name)))) {
      try {
        const link = await secureLink(file);
        if (local.has(link.filename)) { match = link.filename; signedName = true; }
        checksum = link.checksum || '';
        if (match) saveFileState(id, file.key, { ...file, name: match, checksumUrl: checksum });
      } catch {}
    }
    let identified = file.verificationSource === 'import-identified';
    if (!match && file.selected && file.size) {
      const candidates = [...local].filter(([name, info]) => !name.includes('/') && /\.(exe|bin|dmg|pkg|zip|sh)$/i.test(name) && info.size === file.size && !!previous.get(name)?.sha256);
      const competing = filesFor(id).filter(other => other.key !== file.key && other.selected && other.size === file.size);
      if (candidates.length === 1 && !competing.length) { match = candidates[0]![0]; identified = true; }
    }
    const info = local.get(match);
    const candidate = !!info && safeName(match) === match;
    const sizeMatched = candidate && (!file.size || info.size === (file.verifiedSize || file.size));
    const cached = previous.get(match);
    const unchanged = !!info && cached?.size === info.size && cached.mtime_ms === info.mtimeMs;
    const official = candidate && !!checksum && (fullVerify || !unchanged || !file.verified || file.verificationSource !== 'gog-checksum' || !cached?.verified_at
      ? await verifyFile(join(path, match), file.size, checksum, true, signal) : true);
    const matched = sizeMatched || official;
    const localVerified = !official && !checksum && matched && (file.verificationSource === 'local-sha256' || signedName && (imported.has(match) || identified)) && !!cached?.sha256 && (fullVerify || !unchanged
      ? await localSha256(join(path, match), signal) === cached.sha256 : true);
    const verified = official || localVerified;
    if (verified) db.query('UPDATE vault_local_files SET verified_at=? WHERE vault_id=? AND game_id=? AND relative_path=?').run(now(), activeVault()?.id || -1, id, match);
    saveFileState(id, file.key, { ...file, name: match || file.name, checksumUrl: checksum, verified, matched, verifiedSize: verified ? info!.size : file.verifiedSize,
      verificationSource: official ? 'gog-checksum' : localVerified ? 'local-sha256' : identified && matched ? 'import-identified' : '' });
    done++;
    bytes += info?.size || 0;
    progress?.(done, manifest.length, match || file.name, bytes);
  }
  if (signal?.aborted) throw new Error('Verification cancelled');
  progress?.(done, manifest.length, '', bytes);
  saveLocalGame(id, { scannedAt: now(), localSize });
  const all = filesFor(id);
  const required = all.filter(file => file.selected);
  if (required.some(file => file.category === 'main') && required.every(file => file.verified || file.matched)) {
    const fingerprint = desiredFingerprint(all);
    if (required.every(file => file.verified) && !current.archivedHash) {
      saveLocalGame(id, { archivedHash: current.manifestHash, archivedSelectedHash: fingerprint });
    } else if (!current.archivedHash && !localGameRow(id)?.archived_selected_hash) {
      saveLocalGame(id, { archivedSelectedHash: fingerprint });
    }
  }
  activity(`${current.title} scanned`);
  await writeOfflineMetadata(id);
  return gameById(id)!;
}
export const scanState = { running: false, done: 0, total: 0, error: '', phase: '', current: '', startedAt: '',
  unlinked: (db.query('SELECT folder FROM unlinked_folders WHERE vault_id=? ORDER BY folder').all(activeVault()?.id || -1) as { folder: string }[]).map(row => row.folder),
  ignored: (db.query('SELECT COUNT(*) AS total FROM ignored_folders WHERE vault_id=?').get(activeVault()?.id || -1) as { total: number }).total, cancelled: false };
export function loadScanFolders(base: string) {
  scanState.unlinked = (db.query('SELECT folder FROM unlinked_folders WHERE vault_id=? ORDER BY folder').all(activeVault()?.id || -1) as { folder: string }[]).map(row => row.folder);
  scanState.ignored = (db.query('SELECT COUNT(*) AS total FROM ignored_folders WHERE vault_id=?').get(activeVault()?.id || -1) as { total: number }).total;
}
export function cancelScan() { if (scanState.running) scanState.cancelled = true; }
export async function scanVault() {
  if (scanState.running) return;
  scanState.running = true; scanState.done = 0; scanState.error = ''; scanState.cancelled = false;
  scanState.startedAt = now(); scanState.phase = 'Scanning games'; scanState.current = '';
  try {
    const base = await vaultPath();
    const all = games(); scanState.total = all.length;
    const linked = new Set(all.filter(game => game.folder).map(game => game.folder.toLowerCase()));
    const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !linked.has(entry.name.toLowerCase()) && !internalFolder(entry.name) && !ignoredFolder(base, entry.name));
    const folderData = (await Promise.all(directories.map(async entry => {
      const evidence = await folderEvidence(base, entry.name).catch(() => null);
      return evidence ? { name: entry.name, evidence } : null;
    }))).filter((item): item is NonNullable<typeof item> => !!item);
    const proposals = new Map<string, string>();
    for (const game of all.filter(item => !item.folder)) {
      const matches = folderData.filter(item => item.evidence.metadataId === game.id);
      if (matches.length === 1) proposals.set(game.id, matches[0]!.name);
    }
    const counts = new Map<string, number>();
    for (const folder of proposals.values()) counts.set(folder, (counts.get(folder) || 0) + 1);
    for (const game of all) {
      if (scanState.cancelled) break;
      scanState.current = game.title;
      try {
        const proposed = proposals.get(game.id);
        await scanGame(game.id, false, proposed && counts.get(proposed) === 1 ? proposed : null);
      } catch (error) { console.warn(`Scan ${game.id}: ${error instanceof Error ? error.message : 'failed'}`); }
      scanState.done++;
    }
    if (!scanState.cancelled) {
      scanState.phase = 'Checking unlinked folders'; scanState.current = '';
      const linked = new Set((db.query("SELECT folder FROM vault_games WHERE vault_id=? AND folder!=''").all(activeVault()?.id || -1) as { folder: string }[]).map(row => row.folder.toLowerCase()));
      const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !linked.has(entry.name.toLowerCase()) && !internalFolder(entry.name) && !ignoredFolder(base, entry.name)).map(entry => entry.name);
      db.transaction(() => {
        db.query('DELETE FROM unlinked_folders WHERE vault_id=?').run(activeVault()?.id || -1);
        const insert = db.query('INSERT INTO unlinked_folders(vault_path,folder,discovered_at,vault_id) VALUES (?,?,?,?)');
        for (const folder of folders) insert.run(base, folder, now(), activeVault()?.id || -1);
      })();
      scanState.unlinked = folders;
      scanState.ignored = (db.query('SELECT COUNT(*) AS total FROM ignored_folders WHERE vault_id=?').get(activeVault()?.id || -1) as { total: number }).total;
      db.query('UPDATE vaults SET last_scanned_at=? WHERE id=?').run(now(), activeVault()?.id || -1);
    }
  } catch (error) { scanState.error = error instanceof Error ? error.message : 'Scan failed'; }
  finally { scanState.running = false; scanState.phase = scanState.cancelled ? 'Cancelled' : 'Complete'; scanState.current = ''; }
}
export async function writeOfflineMetadata(gameId: string) {
  const game = gameById(gameId);
  if (!game?.folder) return;
  const folder = await gameFolder(game);
  const dir = join(folder, '.gog-vault');
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== dir) throw new Error('Offline metadata directory escapes game folder');
  const artworkDir = join(dir, 'artwork');
  await mkdir(artworkDir, { recursive: true });
  if (await realpath(artworkDir) !== artworkDir) throw new Error('Offline artwork directory escapes game folder');
  const writeSafe = async (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    if (await lstat(path).then(info => !info.isFile()).catch(() => false)) throw new Error('Unsafe offline metadata target');
    await writeFile(path, content);
  };
  const { cover, background, ...metadata } = game;
  const previous = await readFile(join(dir, 'metadata.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const media = mediaFor(gameId);
  const artwork = [
    ['cover', cover], ['background', background],
    ...media.filter(asset => asset.role === 'logo' || asset.role === 'icon' || asset.role === 'videoPoster')
      .filter((asset, index, selected) => selected.findIndex(other => other.role === asset.role) === index)
      .map(asset => [asset.role, asset.url])
  ];
  const artworkSources: Record<string, string> = { ...previous.artworkSources };
  const recordImage = (name: string, url: string, bytes: Uint8Array) => {
    const dimensions = imageSize(bytes);
    if (!dimensions.width || !dimensions.height) throw new Error('Image dimensions unavailable');
    const mimeType = dimensions.type === 'jpg' || dimensions.type === 'jpeg' ? 'image/jpeg' : `image/${dimensions.type}`;
    db.query('UPDATE media_assets SET width=?,height=?,mime_type=?,sha256=? WHERE game_id=? AND role=? AND url=?')
      .run(dimensions.width, dimensions.height, mimeType, createHash('sha256').update(bytes).digest('hex'), gameId, name === 'cover' ? 'card' : name === 'background' ? 'hero' : name, url);
    if (process.env.GOG_VAULT_DEBUG_MEDIA === '1') console.log(JSON.stringify({ role: name, url: new URL(url).origin + new URL(url).pathname, width: dimensions.width, height: dimensions.height, mimeType }));
  };
  await writeSafe('manifest.json', JSON.stringify(filesFor(gameId).map(({ downlink, checksumUrl, ...file }) => file), null, 2));
  for (const [name, url] of artwork) {
    if (!url || !trustedGogUrl(url, true)) continue;
    const ext = new URL(url).pathname.match(/\.(png|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
    const filename = `${name}.${ext}`;
    const destination = join(artworkDir, filename);
    if (previous.artworkSources?.[name] === url) {
      if (!await lstat(destination).then(info => info.isFile()).catch(() => false) && await lstat(join(dir, filename)).then(info => info.isFile()).catch(() => false))
        await rename(join(dir, filename), destination);
      if (await lstat(destination).then(info => info.isFile()).catch(() => false)) {
        try { recordImage(name, url, await readFile(destination)); continue; } catch {}
      }
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.ok && trustedGogUrl(response.url, true) && Number(response.headers.get('content-length') || 0) < 10_000_000) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 10_000_000) {
          recordImage(name, url, new Uint8Array(bytes));
          await writeSafe(`artwork/${filename}`, Buffer.from(bytes));
          for (const oldExt of ['jpg', 'png', 'webp']) {
            for (const base of [artworkDir, ...(previous.artworkSources?.[name] ? [dir] : [])]) {
              if (base !== dir && oldExt === ext) continue;
              await lstat(join(base, `${name}.${oldExt}`)).then(async info => {
                if (info.isFile()) await unlink(join(base, `${name}.${oldExt}`));
              }).catch(() => {});
            }
          }
          artworkSources[name] = url;
        }
      }
    } catch {}
  }
  await writeSafe('metadata.json', JSON.stringify({ ...metadata, cover, background, artworkSources, media: mediaFor(gameId).map(({ key, role, url, poster, localPath, width, height, mimeType, sha256, provider, videoId, embedUrl }) => ({ key, role, url, sourceUrl: url, poster, localPath, width, height, mimeType, sha256, provider, videoId, embedUrl })) }, null, 2));
}