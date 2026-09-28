import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'gog-vault-adoption-'));
const previousDataDir = process.env.GOG_VAULT_DATA_DIR;
process.env.GOG_VAULT_DATA_DIR = directory;
let online = true;
let lookups = 0;
mock.module('./gog/products', () => ({
  trustedGogUrl: () => false,
  secureLink: async (file: { key: string }) => {
    lookups++;
    if (!online) throw new Error('GOG unavailable');
    return { url: 'https://cdn.gog.com/file', filename: file.key === 'one' ? 'setup_agony_v1.exe' : 'setup_agony_v1-1.bin' };
  }
}));
const { db, upsertGame, saveSettings, filesFor, mediaFor, replaceMedia } = await import('./db');
const { scanGame, findGameFolder, organizePreview, organizeGame } = await import('./storage');
afterAll(async () => {
  db.close();
  if (previousDataDir === undefined) delete process.env.GOG_VAULT_DATA_DIR;
  else process.env.GOG_VAULT_DATA_DIR = previousDataDir;
  await rm(directory, { recursive: true, force: true });
});

test('adopts an existing multipart installer without redownloading or calling old files corrupt', async () => {
  const root = join(directory, 'vault');
  const folder = join(root, 'Agony');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'setup_agony_v1.exe'), Buffer.alloc(32, 1));
  await writeFile(join(folder, 'setup_agony_v1-1.bin'), Buffer.alloc(64, 2));
  await mkdir(join(folder, 'Previous Versions'));
  await writeFile(join(folder, 'Previous Versions', 'setup_agony_old.exe'), Buffer.alloc(7, 3));
  saveSettings({ vaultPath: root });
  upsertGame({ id: '42', title: 'Agony', slug: 'agony' });
  const insert = db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,selected)
    VALUES (?,?,?,?,?,?,?,?,?,1)`);
  insert.run('42', 'one', 'Agony (Part 1 of 2)', 'main', 'windows', 'English', '1', 32, 'https://api.gog.com/products/42/downlink/installer/one');
  insert.run('42', 'two', 'Agony (Part 2 of 2)', 'main', 'windows', 'English', '1', 64, 'https://api.gog.com/products/42/downlink/installer/two');
  const first = await scanGame('42');
  expect(first.folder).toBe('Agony');
  expect(first.localSize).toBe(103);
  expect(first.completion.main).toBe(100);
  expect(first.status).toBe('Needs Verification');
  expect(filesFor('42').map(file => [file.matched, file.verified])).toEqual([[true, false], [true, false]]);
  expect(lookups).toBe(2);
  online = false;
  expect((await scanGame('42')).completion.main).toBe(100);
  expect(lookups).toBe(2);
  expect((db.query('SELECT archived_selected_hash AS hash FROM games WHERE id=?').get('42') as { hash: string }).hash).not.toBe('');
  db.query('UPDATE remote_files SET version=?,matched=0,verified=0 WHERE game_id=? AND key=?').run('2', '42', 'one');
  expect((await scanGame('42')).status).toBe('Update Available');
  expect((await readFile(join(folder, 'setup_agony_v1.exe'))).byteLength).toBe(32);
  expect(db.query('SELECT COUNT(*) AS total FROM local_files WHERE game_id=?').get('42')).toEqual({ total: 5 });
  expect(db.query('SELECT size FROM local_files WHERE game_id=? AND relative_path=?').get('42', 'Previous Versions/setup_agony_old.exe')).toEqual({ size: 7 });
  expect((await readFile(join(folder, 'setup_agony_v1.exe'))).byteLength).toBe(32);
  insert.run('42', 'missing', 'Missing installer', 'main', 'windows', 'English', '1', 999, 'https://api.gog.com/products/42/downlink/installer/missing');
  const previousLookups = lookups;
  expect((await scanGame('42')).completion.main).toBeLessThan(100);
  expect(lookups).toBe(previousLookups);
});

test('product ID metadata outranks a changed folder title without moving files', async () => {
  const root = join(directory, 'second-vault');
  const folder = join(root, 'Batman Arkham Asylum');
  await mkdir(join(folder, '.gog-vault'), { recursive: true });
  await writeFile(join(folder, '.gog-vault', 'metadata.json'), JSON.stringify({ id: '99' }));
  expect(await findGameFolder(root, { id: '99', title: 'Batman: Arkham Asylum Game of the Year Edition', slug: 'batman-arkham-asylum-goty' }, new Set())).toBe('Batman Arkham Asylum');
  expect(await findGameFolder(root, { id: '100', title: 'Different', slug: '' }, new Set())).toBeNull();
  expect(await findGameFolder(root, { id: '99', title: 'Different', slug: '' }, new Set(['Batman Arkham Asylum']))).toBeNull();
});

test('store media defaults off and per-game choice survives refresh', () => {
  const asset = { key: 'image-1', gameId: '42', role: 'screenshot' as const, url: 'https://images.gog.com/a.jpg', poster: '', localPath: '', size: 16, selected: false, external: false };
  replaceMedia('42', [asset]);
  expect(mediaFor('42')[0]?.selected).toBe(false);
  db.query('UPDATE media_assets SET selected=1 WHERE game_id=? AND key=?').run('42', asset.key);
  replaceMedia('42', [{ ...asset, size: 20 }]);
  expect(mediaFor('42')[0]).toMatchObject({ selected: true, size: 20 });
});

test('organization previews linked folders, refuses conflicts, and preserves installer bytes and product ID', async () => {
  const root = join(directory, 'organized-vault');
  const original = join(root, 'Batman Old');
  await mkdir(original, { recursive: true });
  await writeFile(join(original, 'setup.exe'), Buffer.from('installer'));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'organize-1', title: 'Batman: New Edition' });
  db.query('UPDATE games SET folder=? WHERE id=?').run('Batman Old', 'organize-1');
  const proposal = (await organizePreview()).find(item => item.id === 'organize-1')!;
  expect(proposal.current).toBe(original);
  expect(proposal.conflict).toBe(false);
  await mkdir(proposal.proposed);
  expect((await organizePreview()).find(item => item.id === 'organize-1')?.conflict).toBe(true);
  expect(organizeGame('organize-1')).rejects.toThrow('Destination folder already exists');
  await rm(proposal.proposed, { recursive: true });
  expect((await organizeGame('organize-1'))?.folder).toBe(proposal.target);
  expect(await readFile(join(proposal.proposed, 'setup.exe'), 'utf8')).toBe('installer');
  expect(access(original)).rejects.toThrow();
  expect((await organizePreview()).find(item => item.id === 'organize-1')).toBeUndefined();
});

test('organization marks duplicate-title destinations as conflicting', async () => {
  const root = join(directory, 'duplicate-vault');
  await mkdir(join(root, 'First'), { recursive: true });
  await mkdir(join(root, 'Second'));
  saveSettings({ vaultPath: root });
  for (const [id, folder] of [['dupe-1', 'First'], ['dupe-2', 'Second']]) {
    upsertGame({ id, title: 'Shared Title' });
    db.query('UPDATE games SET folder=? WHERE id=?').run(folder, id);
  }
  expect((await organizePreview()).filter(item => item.title === 'Shared Title').map(item => item.conflict)).toEqual([true, true]);
});