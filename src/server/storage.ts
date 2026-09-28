import { mkdir, readdir, realpath, stat, writeFile, access, constants, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeTitle, safeName, withinRoot, type Game } from '../shared/domain';
import { activity, db, defaultVault, filesFor, gameById, games, now, settings } from './db';
import { secureLink } from './gog/products';
import { verifyFile } from './transfer';

export async function vaultPath(relativePath = ''): Promise<string> {
  const selected = settings().vaultPath || defaultVault;
  if (!isAbsolute(selected) || selected.includes('\0')) throw new Error('Invalid vault directory');
  const root = await realpath(selected);
  const path = withinRoot(root, relativePath);
  const real = await realpath(path);
  if (real !== root && !real.startsWith(root + sep)) throw new Error('Path escapes vault through a symlink');
  if (!(await stat(real)).isDirectory()) throw new Error('Not a directory');
  return real;
}
export async function browse(relativePath = '') {
  const path = await vaultPath(relativePath);
  const root = await vaultPath();
  const entries = await readdir(path, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const target = await realpath(join(path, entry.name));
    if (target.startsWith(root + sep)) dirs.push(entry.name);
  }
  const storage = await statfsInfo(path);
  return { root, path: relative(root, path).replaceAll('\\', '/'), dirs: dirs.sort(), ...storage };
}
export async function selectVault(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Select an absolute directory');
  const real = await realpath(path);
  if (!(await stat(real)).isDirectory()) throw new Error('Not a directory');
  await access(real, constants.R_OK | constants.W_OK);
  return real;
}
async function statfsInfo(path: string) {
  const { statfs } = await import('node:fs/promises');
  const data = await statfs(path);
  let writable = true;
  try { await access(path, constants.W_OK); } catch { writable = false; }
  return { writable, free: data.bavail * data.bsize, total: data.blocks * data.bsize };
}
export async function gameFolder(game: Game, create = false): Promise<string> {
  const base = await vaultPath();
  const preferred = safeName(game.title);
  const occupied = db.query('SELECT id FROM games WHERE folder=? AND id!=?').get(preferred, game.id);
  const folder = game.folder || (occupied ? `${preferred.slice(0, 140)} [${game.id}]` : preferred);
  if (folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') throw new Error('Invalid game folder mapping');
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
  if (!folder || folder.includes('/') || folder.includes('\\') || folder.startsWith('.')) throw new Error('Select a direct child of the vault');
  const base = await vaultPath();
  const real = await realpath(withinRoot(base, folder));
  if (!real.startsWith(base + sep) || !(await stat(real)).isDirectory()) throw new Error('Invalid folder');
  const existing = db.query('SELECT id FROM games WHERE folder=? AND id!=?').get(folder, gameId);
  if (existing) throw new Error('Folder already linked to another game');
  db.query('UPDATE games SET folder=? WHERE id=?').run(folder, gameId);
  activity(`${game.title} linked to a local folder`);
}
export async function scanGame(id: string) {
  const game = gameById(id);
  if (!game) throw new Error('Game not found');
  if (!game.folder) {
    const base = await vaultPath();
    const dirs = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && normalizeTitle(entry.name) === normalizeTitle(game.title));
    if (dirs.length === 1 && !db.query('SELECT id FROM games WHERE folder=?').get(dirs[0]!.name)) await mapFolder(id, dirs[0]!.name);
  }
  const current = gameById(id)!;
  if (!current.folder) return current;
  const path = await gameFolder(current);
  const entries = await readdir(path);
  let localSize = 0;
  for (const entry of entries) {
    const info = await lstat(join(path, entry));
    if (info.isFile()) localSize += info.size;
  }
  for (const file of filesFor(id)) {
    let match = entries.find(entry => entry === file.name);
    let checksum: string | undefined;
    try {
      const link = await secureLink(file);
      match = entries.find(entry => entry === link.filename);
      checksum = link.checksum;
      if (link.filename !== file.name) db.query('UPDATE remote_files SET name=? WHERE game_id=? AND key=?').run(link.filename, id, file.key);
    } catch {}
    const candidate = match && safeName(match) === match ? join(path, match) : '';
    const verified = !!candidate && (await lstat(candidate)).isFile() && await verifyFile(candidate, file.size, checksum);
    db.query('UPDATE remote_files SET verified=? WHERE game_id=? AND key=?').run(Number(verified), id, file.key);
  }
  db.query('UPDATE games SET scanned_at=?,local_size=? WHERE id=?').run(now(), localSize, id);
  const all = filesFor(id);
  const required = all.filter(file => file.selected && (file.category === 'main' || file.category === 'dlc'));
  if (required.some(file => file.category === 'main') && required.every(file => file.verified) && !current.archivedHash) {
    db.query('UPDATE games SET archived_hash=manifest_hash WHERE id=?').run(id);
  }
  activity(`${current.title} scanned`);
  await writeOfflineMetadata(id);
  return gameById(id)!;
}
export const scanState = { running: false, done: 0, total: 0, error: '' };
export async function scanVault() {
  if (scanState.running) return;
  scanState.running = true; scanState.done = 0; scanState.error = '';
  try {
    await vaultPath();
    const all = games(); scanState.total = all.length;
    for (const game of all) {
      try { await scanGame(game.id); } catch (error) { console.warn(`Scan ${game.id}: ${error instanceof Error ? error.message : 'failed'}`); }
      scanState.done++;
    }
  } catch (error) { scanState.error = error instanceof Error ? error.message : 'Scan failed'; }
  finally { scanState.running = false; }
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
  await writeSafe('metadata.json', JSON.stringify(metadata, null, 2));
  await writeSafe('manifest.json', JSON.stringify(filesFor(gameId).map(({ downlink, checksumUrl, ...file }) => file), null, 2));
  for (const [name, url] of [['cover', cover], ['background', background]] as const) {
    if (!/^https:\/\/[^/]*\.gog\.com\//.test(url)) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.ok && Number(response.headers.get('content-length') || 0) < 10_000_000) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 10_000_000) await writeSafe(`${name}.${new URL(url).pathname.endsWith('.png') ? 'png' : 'jpg'}`, Buffer.from(bytes));
      }
    } catch {}
  }
}