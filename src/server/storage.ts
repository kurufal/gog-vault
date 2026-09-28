import { mkdir, readdir, realpath, stat, writeFile, readFile, rename, access, constants, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { desiredFingerprint, normalizeTitle, safeName, withinRoot, type Game } from '../shared/domain';
import { activity, configDir, db, filesFor, gameById, games, jobsFor, mediaFor, now, settings } from './db';
import { secureLink, trustedGogUrl } from './gog/products';
import { verifyFile } from './transfer';

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
  try {
    const data = await statfs(path, { bigint: true });
    const capacity = data.blocks * data.bsize;
    const unallocated = data.bfree * data.bsize;
    const accessible = data.bavail * data.bsize;
    if (capacity > 0n && unallocated <= capacity && accessible <= unallocated && capacity <= BigInt(Number.MAX_SAFE_INTEGER)) {
      total = Number(capacity); free = Number(unallocated); available = Number(accessible);
    }
  } catch {}
  const indexedBytes = (db.query('SELECT COALESCE(SUM(local_size),0) AS bytes FROM games WHERE folder != ?').get('') as { bytes: number }).bytes;
  return { writable, online: true, total, free, available, indexedBytes, appDataPath: resolve(configDir) };
}
export function folderName(game: Game): string {
  const preferred = safeName(game.title);
  const occupied = db.query('SELECT id FROM games WHERE folder=? AND id!=?').get(preferred, game.id);
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
    db.query('UPDATE games SET folder=? WHERE id=?').run(folder, game.id);
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
  const existing = db.query('SELECT id FROM games WHERE folder=? AND id!=?').get(name, gameId);
  if (existing) throw new Error('Folder already linked to another game');
  db.query('UPDATE games SET folder=? WHERE id=?').run(name, gameId);
  db.query('DELETE FROM unlinked_folders WHERE vault_path=? AND folder=?').run(base, name);
  activity(`${game.title} linked to a local folder`);
}
export async function organizePreview() {
  const base = await vaultPath();
  const proposals = [];
  const all = games();
  for (const game of all.filter(item => item.folder && item.folder !== safeName(item.title))) {
    const target = safeName(game.title);
    const source = await gameFolder(game);
    const existing = await lstat(withinRoot(base, target)).then(() => true).catch(() => false);
    const mapped = db.query('SELECT id FROM games WHERE folder=? AND id!=?').get(target, game.id);
    let confidence: 'high' | 'review' = 'review';
    try {
      const metadata = join(source, '.gog-vault', 'metadata.json');
      if ((await lstat(metadata)).size < 131072 && String(JSON.parse(await readFile(metadata, 'utf8')).id) === game.id) confidence = 'high';
    } catch {}
    proposals.push({ id: game.id, title: game.title, current: source, proposed: withinRoot(base, target), target,
      conflict: existing || !!mapped || all.some(other => other.id !== game.id && safeName(other.title) === target), confidence });
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
  if (await lstat(proposal.proposed).then(() => true).catch(() => false)) throw new Error('Destination folder already exists');
  await rename(source, proposal.proposed);
  try {
    const result = db.query('UPDATE games SET folder=? WHERE id=? AND folder=?').run(proposal.target, id, game.folder);
    if (!result.changes) throw new Error('Game folder mapping changed during rename');
  }
  catch (error) { await rename(proposal.proposed, source); throw error; }
  activity(`${game.title} folder organized`);
  return gameById(id);
}
export async function findGameFolder(base: string, game: Pick<Game, 'id' | 'title' | 'slug'>, linked: Set<string>): Promise<string | null> {
  const dirs = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !linked.has(entry.name));
  const metadata: string[] = [];
  for (const dir of dirs) {
    const path = join(base, dir.name, '.gog-vault', 'metadata.json');
    try {
      const info = await lstat(path);
      if (info.isFile() && info.size < 131072 && String(JSON.parse(await readFile(path, 'utf8')).id) === game.id) metadata.push(dir.name);
    } catch {}
  }
  if (metadata.length === 1) return metadata[0]!;
  if (metadata.length > 1) return null;
  const exact = dirs.filter(entry => normalizeTitle(entry.name) === normalizeTitle(game.title));
  if (exact.length === 1) return exact[0]!.name;
  if (exact.length > 1) return null;
  const slug = normalizeTitle(game.slug);
  const aliases = dirs.filter(entry => slug && normalizeTitle(entry.name) === slug);
  return aliases.length === 1 ? aliases[0]!.name : null;
}
export async function scanGame(id: string, fullVerify = false) {
  const game = gameById(id);
  if (!game) throw new Error('Game not found');
  if (!game.folder) {
    const base = await vaultPath();
    const linked = new Set((db.query("SELECT folder FROM games WHERE folder != ''").all() as { folder: string }[]).map(row => row.folder));
    const match = await findGameFolder(base, game, linked);
    if (match) await mapFolder(id, match);
  }
  const current = gameById(id)!;
  if (!current.folder) return current;
  const path = await gameFolder(current);
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
  const previous = new Map((db.query('SELECT relative_path,size,mtime_ms,sha256,verified_at FROM local_files WHERE game_id=?').all(id) as
    { relative_path: string; size: number; mtime_ms: number; sha256: string; verified_at: string }[]).map(row => [row.relative_path, row]));
  const saveLocal = db.query('INSERT INTO local_files(game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?) ON CONFLICT(game_id,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,verified_at=excluded.verified_at');
  db.transaction(() => {
    db.query('DELETE FROM local_files WHERE game_id=?').run(id);
    for (const [name, info] of local) {
      const cached = previous.get(name);
      const unchanged = cached?.size === info.size && cached.mtime_ms === info.mtimeMs;
      saveLocal.run(id, name, info.size, info.mtimeMs, unchanged ? cached.sha256 : '', unchanged ? cached.verified_at : '');
    }
  })();
  for (const file of filesFor(id)) {
    let match = local.has(file.name) ? file.name : '';
    let checksum = file.checksumUrl || '';
    if ((!match || fullVerify && !checksum) && [...local.values()].some(info => info.size === file.size)) {
      try {
        const link = await secureLink(file);
        if (local.has(link.filename)) match = link.filename;
        checksum = link.checksum || '';
        if (match) db.query('UPDATE remote_files SET name=?,checksum_url=? WHERE game_id=? AND key=?').run(match, checksum, id, file.key);
      } catch {}
    }
    const info = local.get(match);
    const matched = !!info && safeName(match) === match && info.size === file.size;
    const cached = previous.get(match);
    const unchanged = !!info && cached?.size === info.size && cached.mtime_ms === info.mtimeMs;
    const verified = matched && !!checksum && (fullVerify || !unchanged || !file.verified || !cached?.verified_at
      ? await verifyFile(join(path, match), file.size, checksum)
      : true);
    if (verified) db.query('UPDATE local_files SET verified_at=? WHERE game_id=? AND relative_path=?').run(now(), id, match);
    db.query('UPDATE remote_files SET verified=?,matched=? WHERE game_id=? AND key=?').run(Number(verified), Number(matched), id, file.key);
  }
  db.query('UPDATE games SET scanned_at=?,local_size=? WHERE id=?').run(now(), localSize, id);
  const all = filesFor(id);
  const required = all.filter(file => file.selected);
  if (required.some(file => file.category === 'main') && required.every(file => file.verified || file.matched)) {
    const fingerprint = desiredFingerprint(all);
    if (required.every(file => file.verified) && !current.archivedHash) {
      db.query('UPDATE games SET archived_hash=manifest_hash,archived_selected_hash=? WHERE id=?').run(fingerprint, id);
    } else if (!current.archivedHash && !(db.query('SELECT archived_selected_hash AS hash FROM games WHERE id=?').get(id) as { hash: string }).hash) {
      db.query('UPDATE games SET archived_selected_hash=? WHERE id=?').run(fingerprint, id);
    }
  }
  activity(`${current.title} scanned`);
  await writeOfflineMetadata(id);
  return gameById(id)!;
}
export const scanState = { running: false, done: 0, total: 0, error: '', phase: '', current: '', startedAt: '',
  unlinked: (db.query('SELECT folder FROM unlinked_folders WHERE vault_path=? ORDER BY folder').all(settings().vaultPath) as { folder: string }[]).map(row => row.folder), cancelled: false };
export function cancelScan() { if (scanState.running) scanState.cancelled = true; }
export async function scanVault() {
  if (scanState.running) return;
  scanState.running = true; scanState.done = 0; scanState.error = ''; scanState.cancelled = false;
  scanState.startedAt = now(); scanState.phase = 'Scanning games'; scanState.current = '';
  try {
    const base = await vaultPath();
    const all = games(); scanState.total = all.length;
    for (const game of all) {
      if (scanState.cancelled) break;
      scanState.current = game.title;
      try { await scanGame(game.id); } catch (error) { console.warn(`Scan ${game.id}: ${error instanceof Error ? error.message : 'failed'}`); }
      scanState.done++;
    }
    if (!scanState.cancelled) {
      scanState.phase = 'Checking unlinked folders'; scanState.current = '';
      const linked = new Set((db.query("SELECT folder FROM games WHERE folder != ''").all() as { folder: string }[]).map(row => row.folder));
      const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !linked.has(entry.name)).map(entry => entry.name);
      db.transaction(() => {
        db.query('DELETE FROM unlinked_folders WHERE vault_path=?').run(base);
        const insert = db.query('INSERT INTO unlinked_folders(vault_path,folder,discovered_at) VALUES (?,?,?)');
        for (const folder of folders) insert.run(base, folder, now());
      })();
      scanState.unlinked = folders;
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
  await writeSafe('manifest.json', JSON.stringify(filesFor(gameId).map(({ downlink, checksumUrl, ...file }) => file), null, 2));
  for (const [name, url] of artwork) {
    if (!trustedGogUrl(url, true)) continue;
    const ext = new URL(url).pathname.match(/\.(png|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
    const filename = `${name}.${ext}`;
    if (previous.artworkSources?.[name] === url && await lstat(join(dir, filename)).then(info => info.isFile()).catch(() => false)) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.ok && trustedGogUrl(response.url, true) && Number(response.headers.get('content-length') || 0) < 10_000_000) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 10_000_000) {
          await writeSafe(filename, Buffer.from(bytes));
          artworkSources[name] = url;
        }
      }
    } catch {}
  }
  await writeSafe('metadata.json', JSON.stringify({ ...metadata, cover, background, artworkSources, media: media.map(({ key, role, url, poster, localPath }) => ({ key, role, url, poster, localPath })) }, null, 2));
}