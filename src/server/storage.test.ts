import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'gog-vault-adoption-'));
const previousDataDir = process.env.GOG_VAULT_DATA_DIR;
process.env.GOG_VAULT_DATA_DIR = directory;
let online = true;
let lookups = 0;
let trustedArtwork = false;
mock.module('./gog/products', () => ({
  trustedGogUrl: () => trustedArtwork,
  secureLink: async (file: { key: string }) => {
    lookups++;
    if (!online) throw new Error('GOG unavailable');
    return { url: 'https://cdn.gog.com/file', filename: file.key === 'one' ? 'setup_agony_v1.exe' : 'setup_agony_v1-1.bin' };
  }
}));
const { db, upsertGame, saveSettings, filesFor, mediaFor, replaceMedia, replaceFiles } = await import('./db');
const { scanGame, scanVault, findGameFolder, linkAndScan, organizePreview, organizeGame, importPreview, importGame, scanState, matchingReview, ignoreFolder, writeOfflineMetadata } = await import('./storage');
const { archiveMedia } = await import('./media');
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
  expect((await scanGame('42')).folder).toBe('');
  const first = await linkAndScan('42', 'Agony');
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

test('offline artwork persists image dimensions and replaces only stale role extensions', async () => {
  const root = join(directory, 'artwork-vault');
  const folder = join(root, 'Artwork');
  const offline = join(folder, '.gog-vault');
  await mkdir(offline, { recursive: true });
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'artwork-id', title: 'Artwork', cover: 'https://images.gog.com/card.png', background: 'https://images.gog.com/hero.jpg' });
  db.query('UPDATE games SET folder=? WHERE id=?').run('Artwork', 'artwork-id');
  replaceMedia('artwork-id', ['card', 'hero'].map(role => ({ key: role, gameId: 'artwork-id', role: role as 'card' | 'hero',
    url: role === 'card' ? 'https://images.gog.com/card.png' : 'https://images.gog.com/hero.jpg', poster: '', localPath: '', size: 0, selected: false, external: false })));
  await writeFile(join(offline, 'cover.jpg'), 'obsolete');
  await writeFile(join(offline, 'metadata.json'), JSON.stringify({ artworkSources: { cover: 'https://images.gog.com/old.jpg' } }));
  const originalFetch = globalThis.fetch;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2cAAAAASUVORK5CYII=', 'base64');
  trustedArtwork = true;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const response = new Response(image, { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  }, { preconnect: originalFetch.preconnect });
  try {
    await writeOfflineMetadata('artwork-id');
    expect(await readFile(join(offline, 'artwork', 'cover.png'))).toEqual(image);
    expect(access(join(offline, 'cover.jpg'))).rejects.toThrow();
    expect(mediaFor('artwork-id')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'card', width: 1, height: 1, mimeType: 'image/png', sourceUrl: 'https://images.gog.com/card.png' }),
      expect.objectContaining({ role: 'hero', width: 1, height: 1, mimeType: 'image/png' })
    ]));
    db.query('UPDATE media_assets SET width=0,height=0,mime_type=? WHERE game_id=?').run('', 'artwork-id');
    globalThis.fetch = Object.assign(async () => { throw new Error('Cached artwork must not be fetched again'); }, { preconnect: originalFetch.preconnect });
    await writeOfflineMetadata('artwork-id');
    expect(mediaFor('artwork-id').map(asset => [asset.width, asset.height, asset.mimeType])).toEqual([[1, 1, 'image/png'], [1, 1, 'image/png']]);
  } finally {
    trustedArtwork = false;
    globalThis.fetch = originalFetch;
  }
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

test.skipIf(process.platform !== 'win32')('case-only organization renames through a sibling without treating itself as occupied', async () => {
  const root = join(directory, 'case-vault');
  const source = join(root, 'doom 3');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'setup.exe'), 'preserve installer');
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'doom-3-id', title: 'DOOM 3' });
  db.query('UPDATE games SET folder=? WHERE id=?').run('doom 3', 'doom-3-id');
  const proposal = (await organizePreview()).find(item => item.id === 'doom-3-id')!;
  expect(proposal.conflict).toBe(false);
  expect((await organizeGame('doom-3-id'))?.folder).toBe('DOOM 3');
  expect(await readFile(join(root, 'DOOM 3', 'setup.exe'), 'utf8')).toBe('preserve installer');
  expect(await readdir(root)).toEqual(['DOOM 3']);
  expect((await organizePreview()).some(item => item.id === 'doom-3-id')).toBe(false);
});

test('manual link immediately rescans existing files and clears Needs Matching', async () => {
  const root = join(directory, 'manual-vault');
  const folder = 'Unmatched installers';
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, folder, 'setup_agony_v1.exe'), Buffer.alloc(32));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'manual-1', title: 'Different Store Title' });
  db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,selected) VALUES (?,?,?,?,?,?,?,?,?,1)`)
    .run('manual-1', 'one', 'setup_agony_v1.exe', 'main', 'windows', 'English', '1', 32, 'https://api.gog.com/products/42/downlink/installer/one');
  db.query('INSERT INTO unlinked_folders(vault_path,folder,discovered_at) VALUES (?,?,?)').run(root, folder, new Date().toISOString());
  scanState.unlinked = [folder];
  const game = await linkAndScan('manual-1', folder);
  expect(game.folder).toBe(folder);
  expect(game.completion.main).toBe(100);
  expect(game.status).toBe('Needs Verification');
  expect(scanState.unlinked).not.toContain(folder);
  expect(db.query('SELECT folder FROM unlinked_folders WHERE vault_path=?').all(root)).toEqual([]);
});

test('selected screenshot archive saves measured dimensions and local path', async () => {
  const root = join(directory, 'screenshot-vault');
  await mkdir(join(root, 'Screenshots'), { recursive: true });
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'screenshot-id', title: 'Screenshots' });
  db.query('UPDATE games SET folder=? WHERE id=?').run('Screenshots', 'screenshot-id');
  replaceMedia('screenshot-id', [{ key: 'screenshot', gameId: 'screenshot-id', role: 'screenshot', url: 'https://images.gog.com/screenshot.png', poster: '', localPath: '', size: 0, selected: true, external: false }]);
  db.query('UPDATE media_assets SET selected=1 WHERE game_id=? AND key=?').run('screenshot-id', 'screenshot');
  const originalFetch = globalThis.fetch;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2cAAAAASUVORK5CYII=', 'base64');
  trustedArtwork = true;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const response = new Response(image, { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  }, { preconnect: originalFetch.preconnect });
  try {
    const result = await archiveMedia('screenshot-id');
    expect(result.downloaded).toBe(1);
    expect(result.media[0]).toMatchObject({ localPath: '.gog-vault/screenshots/screenshot.png', sourceUrl: 'https://images.gog.com/screenshot.png', width: 1, height: 1, mimeType: 'image/png', size: image.byteLength });
    expect(await readFile(join(root, 'Screenshots', '.gog-vault', 'screenshots', 'screenshot.png'))).toEqual(image);
  } finally {
    trustedArtwork = false;
    globalThis.fetch = originalFetch;
  }
});

test('ignored folders persist across rescans without blacklisting their name globally', async () => {
  const root = join(directory, 'ignore-vault');
  await mkdir(join(root, 'MODS'), { recursive: true });
  await mkdir(join(root, '.__gogvault_temporary'));
  await mkdir(join(root, 'Previous Versions'));
  saveSettings({ vaultPath: root });
  await scanVault();
  expect(scanState.unlinked).toEqual(['MODS']);
  expect((await matchingReview()).folders[0]).toMatchObject({ folder: 'MODS', localPath: join(root, 'MODS') });
  await ignoreFolder('MODS');
  expect(scanState.unlinked).toEqual([]);
  await scanVault();
  expect(scanState.unlinked).toEqual([]);
  expect((await matchingReview()).ignored).toBe(1);
});

test('batch refresh does not replace a distinct catalog card with a hero fallback', () => {
  upsertGame({ id: 'art-priority', title: 'Card Game', cover: 'https://images.gog.com/card.jpg', background: 'https://images.gog.com/hero.jpg' });
  upsertGame({ id: 'art-priority', title: 'Card Game', cover: 'https://images.gog.com/hero.jpg', background: 'https://images.gog.com/hero.jpg' });
  expect((db.query('SELECT cover,background FROM games WHERE id=?').get('art-priority'))).toEqual({ cover: 'https://images.gog.com/card.jpg', background: 'https://images.gog.com/hero.jpg' });
});

test('external import previews separate folders, copies without overwriting, and moves only after verification', async () => {
  const root = join(directory, 'import-vault');
  const archive = join(directory, 'old-archive');
  await mkdir(root);
  await mkdir(join(archive, 'First Game'), { recursive: true });
  await mkdir(join(archive, 'Second Game'), { recursive: true });
  await writeFile(join(archive, 'First Game', 'installer.bin'), Buffer.from('first installer'));
  await writeFile(join(archive, 'Second Game', 'installer.bin'), Buffer.from('second installer'));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'import-1', title: 'First Game' });
  upsertGame({ id: 'import-2', title: 'Second Game' });
  replaceFiles('import-1', [{ key: 'import-main', gameId: 'import-1', name: 'installer.bin', category: 'main', platform: 'windows', language: 'English', version: '1', size: 15,
    downlink: 'https://api.gog.com/products/import-1/downlink', selected: true, verified: false }]);
  const plans = await importPreview(archive);
  expect(plans).toHaveLength(2);
  expect(plans.map(plan => plan.candidates[0]?.id)).toEqual(['import-1', 'import-2']);
  await importGame(plans[0]!.source, 'import-1', plans[0]!.signature, 'copy');
  expect(await readFile(join(archive, 'First Game', 'installer.bin'), 'utf8')).toBe('first installer');
  expect(await readFile(join(root, 'First Game', 'installer.bin'), 'utf8')).toBe('first installer');
  expect(filesFor('import-1')[0]).toMatchObject({ verified: true, verificationSource: 'local-sha256', verifiedSize: 15 });
  expect((await scanGame('import-1')).completion.main).toBe(100);
  db.query('UPDATE remote_files SET size=? WHERE game_id=? AND key=?').run(10, 'import-1', 'import-main');
  expect((await scanGame('import-1')).completion.main).toBe(100);
  await expect(importGame(plans[0]!.source, 'import-1', plans[0]!.signature, 'copy')).rejects.toThrow('Product mapping conflicts');
  await writeFile(join(archive, 'Second Game', 'installer.bin'), 'changed');
  await expect(importGame(plans[1]!.source, 'import-2', plans[1]!.signature, 'move')).rejects.toThrow('changed since preview');
  expect(await readFile(join(archive, 'Second Game', 'installer.bin'), 'utf8')).toBe('changed');
  const refreshed = (await importPreview(join(archive, 'Second Game')))[0]!;
  await importGame(refreshed.source, 'import-2', refreshed.signature, 'move');
  expect(await readFile(join(root, 'Second Game', 'installer.bin'), 'utf8')).toBe('changed');
  await expect(access(join(archive, 'Second Game', 'installer.bin'))).rejects.toThrow();
});