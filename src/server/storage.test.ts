import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { uniqueMedia } from '../shared/media';

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
    return { url: 'https://cdn.gog.com/file', filename: file.key === 'one' ? 'setup_agony_v1.exe' :
      file.key === 'official-size' ? 'setup_official.exe' :
      file.key === 'bonus-missing' ? 'track.flac' :
      file.key === 'beyond-main' ? 'setup_beyond_two_souls_1.0.exe' :
      file.key === 'beyond-part' ? 'setup_beyond_two_souls_1.0-1.bin' : 'setup_agony_v1-1.bin',
      checksum: file.key === 'official-size' ? 'https://cdn.gog.com/official.xml' :
        file.key === 'bonus-missing' ? 'https://cdn.gog.com/missing.xml' : undefined };
  }
}));
const { db, upsertGame, saveSettings, filesFor, mediaFor, replaceMedia, replaceFiles, gameById, games, setHiddenGames, mapVaultGame, saveFileState, saveLocalGame, activeVault, linkDlcProducts, selectDlcProduct, saveOwnedProducts } = await import('./db');
const { scanGame, scanVault, findGameFolder, linkAndScan, organizePreview, organizeGame, importPreview, importGame, scanState, matchingReview, ignoreFolder, writeOfflineMetadata } = await import('./storage');
const { enqueueVerification, cancelVerification, verificationJobs, hasActiveVerification } = await import('./verification');
const { archiveMedia } = await import('./media');
const { enqueueImports, importJobs, importCommand, shutdownImports, subscribeImports } = await import('./imports');
afterAll(async () => {
  await shutdownImports();
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
  expect(first.folderPath).toBe(join(root, 'Agony'));
  expect(first.localSize).toBe(103);
  expect(first.completion.main).toBe(100);
  expect(first.status).toBe('Needs Verification');
  expect(filesFor('42').map(file => [file.matched, file.verified])).toEqual([[true, false], [true, false]]);
  expect(lookups).toBe(2);
  online = false;
  expect((await scanGame('42')).completion.main).toBe(100);
  expect(lookups).toBe(2);
  expect(gameById('42')?.folder).toBe('Agony');
  db.query('UPDATE remote_files SET version=?,matched=0,verified=0 WHERE game_id=? AND key=?').run('2', '42', 'one');
  expect((await scanGame('42')).status).toBe('Needs Verification');
  expect((await readFile(join(folder, 'setup_agony_v1.exe'))).byteLength).toBe(32);
  expect(db.query('SELECT COUNT(*) AS total FROM vault_local_files WHERE game_id=?').get('42')).toEqual({ total: 5 });
  expect(db.query('SELECT size FROM vault_local_files WHERE game_id=? AND relative_path=?').get('42', 'Previous Versions/setup_agony_old.exe')).toEqual({ size: 7 });
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
  mapVaultGame('artwork-id', 'Artwork');
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
  mapVaultGame('organize-1', 'Batman Old');
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
    mapVaultGame(id, folder);
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
  mapVaultGame('doom-3-id', 'doom 3');
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
  db.query('INSERT INTO unlinked_folders(vault_path,folder,discovered_at,vault_id) VALUES (?,?,?,?)').run(root, folder, new Date().toISOString(), activeVault()!.id);
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
  mapVaultGame('screenshot-id', 'Screenshots');
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

test('COPY returns a durable job immediately and streams progress without changing its source', async () => {
  const root = join(directory, 'worker-vault');
  const source = join(directory, 'worker-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'installer.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'worker-game', title: 'Worker Game' });
  const preview = (await importPreview(source))[0]!;
  const events: string[] = [];
  const unsubscribe = subscribeImports(jobs => {
    const current = jobs.find(job => job.gameId === 'worker-game');
    if (current) events.push(current.state);
  });
  try {
    const startedAt = Date.now();
    const { importJobId, status } = enqueueImports([{ source: preview.source, id: 'worker-game', signature: preview.signature }], 'copy');
    expect(status).toBe('queued');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(importJobs().find(job => job.batchId === importJobId)?.state).not.toBe('completed');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Import did not finish')), 15000);
      const poll = setInterval(() => {
        const state = importJobs().find(job => job.batchId === importJobId)?.state;
        if (state === 'completed' || state === 'failed') {
          clearInterval(poll); clearTimeout(timeout);
          state === 'completed' ? resolve() : reject(new Error(`Import failed: ${JSON.stringify(importJobs().find(job => job.batchId === importJobId)?.errorDetails)}`));
        }
      }, 20);
    });
    expect(events).toContain('copying');
    expect(events).toContain('verifying');
    expect(importJobs().find(job => job.batchId === importJobId)).toMatchObject({ bytes: 4 * 1024 * 1024, total: 4 * 1024 * 1024, filesDone: 1 });
    expect(await readFile(join(root, 'Worker Game', 'installer.bin'))).toEqual(await readFile(join(source, 'installer.bin')));
    const completed = importJobs().find(job => job.batchId === importJobId)!;
    importCommand(completed.id, 'remove');
    expect(importJobs().find(job => job.id === completed.id)).toBeUndefined();
    expect(await readFile(join(root, 'Worker Game', 'installer.bin'))).toEqual(await readFile(join(source, 'installer.bin')));
  } finally { unsubscribe(); }
});

test('cancelling a COPY leaves the source and never links an incomplete destination', async () => {
  const root = join(directory, 'cancel-vault');
  const source = join(directory, 'cancel-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'installer.bin'), Buffer.alloc(1024 * 1024, 3));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'cancel-game', title: 'Cancelled Game' });
  const preview = (await importPreview(source))[0]!;
  const { importJobId } = enqueueImports([{ source: preview.source, id: 'cancel-game', signature: preview.signature }], 'copy');
  const job = importJobs().find(item => item.batchId === importJobId)!;
  importCommand(job.id, 'cancel');
  expect(importJobs().find(item => item.id === job.id)?.state).toBe('cancelled');
  expect(await readFile(join(source, 'installer.bin'))).toHaveLength(1024 * 1024);
  expect((db.query('SELECT folder FROM games WHERE id=?').get('cancel-game') as { folder: string }).folder).toBe('');
});
test('hidden games remain owned and hidden after metadata refresh', () => {
  upsertGame({ id: 'hide-fixture', title: 'Visible Game' });
  const owned = games().length;
  setHiddenGames(['hide-fixture'], true);
  upsertGame({ id: 'hide-fixture', title: 'Renamed Game' });
  expect(gameById('hide-fixture')).toMatchObject({ hiddenFromLibrary: true, title: 'Renamed Game' });
  expect(games().length).toBe(owned);
  setHiddenGames(['hide-fixture'], false);
  expect(gameById('hide-fixture')?.hiddenFromLibrary).toBe(false);
});
test('Beyond: Two Souls remains owned but archives only in its selected vault', async () => {
  const first = join(directory, 'beyond-vault-a');
  const second = join(directory, 'beyond-vault-b');
  await mkdir(join(first, 'Beyond Two Souls', '.gog-vault'), { recursive: true });
  await mkdir(second);
  await writeFile(join(first, 'Beyond Two Souls', '.gog-vault', 'metadata.json'), JSON.stringify({ id: 'beyond-switch' }));
  saveSettings({ vaultPath: first });
  upsertGame({ id: 'beyond-switch', title: 'Beyond: Two Souls', platforms: ['windows'] });
  db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,selected)
    VALUES (?,?,?,?,?,?,?,?,?,1)`).run('beyond-switch', 'installer', 'setup.exe', 'main', 'windows', 'English', '1', 4, 'https://api.gog.com/test');
  mapVaultGame('beyond-switch', 'Beyond Two Souls');
  saveFileState('beyond-switch', 'installer', { name: 'setup.exe', matched: true, verified: true, verificationSource: 'local-sha256', verifiedSize: 4 });
  const firstId = activeVault()!.id;
  const owned = games().length;
  expect(gameById('beyond-switch')).toMatchObject({ status: 'Vaulted', folder: 'Beyond Two Souls', completion: { main: 100 } });
  saveSettings({ vaultPath: second });
  expect(activeVault()!.id).not.toBe(firstId);
  expect(games()).toHaveLength(owned);
  expect(gameById('beyond-switch')).toMatchObject({ status: 'Not Downloaded', folder: '', completion: { main: 0 } });
  const source = join(directory, 'beyond-external-source');
  await mkdir(join(source, '.gog-vault'), { recursive: true });
  await writeFile(join(source, 'setup.exe'), 'test');
  await writeFile(join(source, '.gog-vault', 'metadata.json'), JSON.stringify({ id: 'beyond-switch' }));
  const preview = (await importPreview(source))[0]!;
  expect(preview.candidates.find(candidate => candidate.id === 'beyond-switch')?.existingFolder).toBe(false);
  expect(db.query('SELECT folder FROM vault_games WHERE vault_id=? AND game_id=?').get(activeVault()!.id, 'beyond-switch')).toBeNull();
  const { importJobId } = enqueueImports([{ source: preview.source, id: 'beyond-switch', signature: preview.signature }], 'copy');
  const job = importJobs().find(item => item.batchId === importJobId)!;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Second vault COPY timed out')); }, 15000);
    const unsubscribe = subscribeImports(items => {
      const state = items.find(item => item.id === job.id)?.state;
      if (state === 'completed' || state === 'failed') {
        clearTimeout(timeout); unsubscribe(); state === 'completed' ? resolve() : reject(new Error('Second vault COPY failed'));
      }
    });
  });
  expect(gameById('beyond-switch')).toMatchObject({ status: 'Vaulted', folder: 'Beyond Two Souls', completion: { main: 100 } });
  expect(await readFile(join(source, 'setup.exe'), 'utf8')).toBe('test');
  saveSettings({ vaultPath: first });
  expect(gameById('beyond-switch')).toMatchObject({ status: 'Vaulted', folder: 'Beyond Two Souls', completion: { main: 100 } });
  await rm(join(first, 'Beyond Two Souls'), { recursive: true });
  expect(await scanGame('beyond-switch')).toMatchObject({ status: 'Not Downloaded', folder: '', completion: { main: 0 } });
  saveSettings({ vaultPath: second });
  expect(gameById('beyond-switch')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
});
test('vault switching refuses queued filesystem jobs without changing the selected root', async () => {
  const first = join(directory, 'guard-vault-a');
  const second = join(directory, 'guard-vault-b');
  await mkdir(first); await mkdir(second);
  saveSettings({ vaultPath: first });
  upsertGame({ id: 'guard-game', title: 'Guarded Game' });
  const vaultId = activeVault()!.id;
  db.query('INSERT INTO download_jobs(game_id,state,created_at,updated_at,vault_id) VALUES (?,?,?,?,?)')
    .run('guard-game', 'queued', new Date().toISOString(), new Date().toISOString(), vaultId);
  expect(() => saveSettings({ vaultPath: second })).toThrow('Finish or cancel active filesystem jobs');
  expect(activeVault()!.id).toBe(vaultId);
  expect(gameById('guard-game')?.status).toBe('Queued');
  db.query("UPDATE download_jobs SET state='cancelled' WHERE game_id=?").run('guard-game');
  saveSettings({ vaultPath: second });
  expect(activeVault()!.id).not.toBe(vaultId);
  expect(gameById('guard-game')?.status).toBe('Not Downloaded');
});
test('retry waits for cancelled worker to settle before resuming a COPY', async () => {
  const root = join(directory, 'retry-vault');
  const source = join(directory, 'retry-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'installer.bin'), Buffer.alloc(24 * 1024 * 1024, 4));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'retry-game', title: 'Retry Game' });
  const preview = (await importPreview(source))[0]!;
  const { importJobId } = enqueueImports([{ source: preview.source, id: 'retry-game', signature: preview.signature }], 'copy');
  const job = importJobs().find(item => item.batchId === importJobId)!;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Import did not start')); }, 15000);
    const unsubscribe = subscribeImports(items => {
      if (items.find(item => item.id === job.id)?.state === 'copying') { clearTimeout(timeout); unsubscribe(); resolve(); }
    });
  });
  importCommand(job.id, 'cancel');
  expect(() => importCommand(job.id, 'retry')).toThrow('still stopping');
  await new Promise<void>((resolve, reject) => {
    let retrying = false;
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Cancelled worker did not settle')); }, 15000);
    const unsubscribe = subscribeImports(() => {
      if (retrying) return;
      try { retrying = true; importCommand(job.id, 'retry'); clearTimeout(timeout); unsubscribe(); resolve(); }
      catch (error) { retrying = false;
        if (!(error instanceof Error) || !error.message.includes('still stopping')) { clearTimeout(timeout); unsubscribe(); reject(error); }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Retry did not finish')); }, 15000);
    const unsubscribe = subscribeImports(items => {
      const state = items.find(item => item.id === job.id)?.state;
      if (state === 'completed' || state === 'failed') { clearTimeout(timeout); unsubscribe(); state === 'completed' ? resolve() : reject(new Error('Retry failed')); }
    });
  });
  expect((await readFile(join(source, 'installer.bin'))).byteLength).toBe(24 * 1024 * 1024);
  expect((await readFile(join(root, 'Retry Game', 'installer.bin'))).byteLength).toBe(24 * 1024 * 1024);
});
test('MOVE removes only verified disposable source after destination is committed', async () => {
  const root = join(directory, 'move-vault');
  const source = join(directory, 'move-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'installer.bin'), Buffer.alloc(512 * 1024, 5));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'move-game', title: 'Moved Game' });
  const preview = (await importPreview(source))[0]!;
  const { importJobId } = enqueueImports([{ source: preview.source, id: 'move-game', signature: preview.signature }], 'move');
  const job = importJobs().find(item => item.batchId === importJobId)!;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('MOVE timed out')); }, 15000);
    const unsubscribe = subscribeImports(items => {
      const state = items.find(item => item.id === job.id)?.state;
      if (state === 'completed' || state === 'failed') {
        clearTimeout(timeout); unsubscribe();
        state === 'completed' ? resolve() : reject(new Error(`MOVE failed: ${JSON.stringify(importJobs().find(item => item.id === job.id)?.errorDetails)}`));
      }
    });
  });
  expect((await readFile(join(root, 'Moved Game', 'installer.bin'))).byteLength).toBe(512 * 1024);
  expect(await access(join(source, 'installer.bin')).then(() => true).catch(() => false)).toBe(false);
  expect(gameById('move-game')?.folder).toBe('Moved Game');
});

test('multipart COPY reconciles display labels with signed filenames and survives an offline scan', async () => {
  online = true;
  const root = join(directory, 'multipart-vault');
  const archive = join(directory, 'multipart-source');
  const source = join(archive, 'Beyond Two Souls');
  await mkdir(root);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'setup_beyond_two_souls_1.0.exe'), Buffer.alloc(30, 1));
  await writeFile(join(source, 'setup_beyond_two_souls_1.0-1.bin'), Buffer.alloc(50, 2));
  await mkdir(join(source, 'Previous Versions'));
  await writeFile(join(source, 'Previous Versions', 'setup_beyond_two_souls_0.9.exe'), Buffer.alloc(12, 3));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'beyond-copy', title: 'Beyond: Two Souls' });
  replaceFiles('beyond-copy', ['beyond-main', 'beyond-part'].map((key, index) => ({
    key, gameId: 'beyond-copy', name: `Beyond: Two Souls (Part ${index + 1} of 2)`, category: 'main' as const,
    platform: 'windows' as const, language: 'English', version: '1.0', size: index ? 50 : 30,
    downlink: `https://api.gog.com/products/beyond-copy/downlink/${key}`, selected: true, verified: false
  })));
  const preview = (await importPreview(source))[0]!;
  await importGame(preview.source, 'beyond-copy', preview.signature, 'copy');
  expect(gameById('beyond-copy')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
  expect(filesFor('beyond-copy').map(file => [file.name, file.verified])).toEqual([
    ['setup_beyond_two_souls_1.0.exe', true], ['setup_beyond_two_souls_1.0-1.bin', true]
  ]);
  online = false;
  expect(await scanGame('beyond-copy')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
  online = true;
  expect((await readFile(join(source, 'setup_beyond_two_souls_1.0.exe'))).byteLength).toBe(30);
  replaceFiles('beyond-copy', ['beyond-main', 'beyond-part'].map((key, index) => ({
    key, gameId: 'beyond-copy', name: `Beyond: Two Souls (Part ${index + 1} of 2)`, category: 'main' as const,
    platform: 'windows' as const, language: 'English', version: '2.0', size: index ? 50 : 30,
    downlink: `https://api.gog.com/products/beyond-copy/downlink/${key}`, selected: true, verified: false
  })));
  expect(await scanGame('beyond-copy')).toMatchObject({ status: 'Vaulted', previousInstallerParts: 2, completion: { main: 100 } });
  expect(filesFor('beyond-copy').every(file => !file.verified)).toBe(true);
});

test('offline multipart COPY stays identified and verifies on a later online scan', async () => {
  const root = join(directory, 'offline-multipart-vault');
  const source = join(directory, 'offline-multipart-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'setup_beyond_two_souls_1.0.exe'), Buffer.alloc(31, 1));
  await writeFile(join(source, 'setup_beyond_two_souls_1.0-1.bin'), Buffer.alloc(51, 2));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'offline-import', title: 'Beyond: Two Souls Offline' });
  replaceFiles('offline-import', ['beyond-main', 'beyond-part'].map((key, index) => ({
    key, gameId: 'offline-import', name: `Beyond: Two Souls (Part ${index + 1} of 2)`, category: 'main' as const,
    platform: 'windows' as const, language: 'English', version: '1', size: index ? 51 : 31,
    downlink: `https://api.gog.com/products/offline-import/downlink/${key}`, selected: true, verified: false
  })));
  const preview = (await importPreview(source))[0]!;
  online = false;
  try {
    await importGame(preview.source, 'offline-import', preview.signature, 'copy');
    expect(gameById('offline-import')).toMatchObject({ status: 'Needs Verification', completion: { main: 100 } });
    expect((await scanGame('offline-import')).status).toBe('Needs Verification');
    online = true;
    expect(await scanGame('offline-import')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
  } finally { online = true; }
});

test('a complete older multipart set remains identified without becoming current verified files', async () => {
  const root = join(directory, 'previous-build-vault');
  const source = join(directory, 'previous-build-source');
  await mkdir(root);
  await mkdir(source);
  await writeFile(join(source, 'setup_beyond_two_souls_1.0_(67183).exe'), Buffer.alloc(35, 1));
  await writeFile(join(source, 'setup_beyond_two_souls_1.0_(67183)-1.bin'), Buffer.alloc(55, 2));
  await writeFile(join(source, 'setup_beyond_two_souls_1.0_(67183)-2.bin'), Buffer.alloc(75, 3));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'previous-build', title: 'Beyond: Two Souls' });
  replaceFiles('previous-build', [30, 50, 70].map((size, index) => ({
    key: `previous-${index}`, gameId: 'previous-build', name: `Beyond: Two Souls (Part ${index + 1} of 3)`,
    category: 'main' as const, platform: 'windows' as const, language: 'English', version: '2.0', size,
    downlink: `https://api.gog.com/products/previous-build/downlink/${index}`, selected: true, verified: false
  })));
  const preview = (await importPreview(source))[0]!;
  await importGame(preview.source, 'previous-build', preview.signature, 'copy');
  expect(gameById('previous-build')).toMatchObject({ status: 'Vaulted', previousInstallerParts: 3, completion: { main: 0 } });
  expect(await scanGame('previous-build')).toMatchObject({ status: 'Vaulted', previousInstallerParts: 3, completion: { main: 0 } });
  expect(filesFor('previous-build').every(file => !file.verified)).toBe(true);
  const archived = join(root, gameById('previous-build')!.folder);
  await writeFile(join(archived, 'setup_beyond_two_souls_1.0_(67183)-2.bin'), Buffer.alloc(76, 3));
  expect(await scanGame('previous-build')).toMatchObject({ status: 'Not Downloaded', previousInstallerParts: 0, completion: { main: 0 } });
});

test('an official checksum can verify an imported installer despite a smaller manifest placeholder', async () => {
  const root = join(directory, 'official-size-vault');
  const source = join(directory, 'official-size-source');
  await mkdir(root);
  await mkdir(source);
  const bytes = Buffer.from('offline installer');
  await writeFile(join(source, 'setup_official.exe'), bytes);
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'official-size-game', title: 'Official Size Game' });
  replaceFiles('official-size-game', [{ key: 'official-size', gameId: 'official-size-game', name: 'Official installer',
    category: 'main', platform: 'windows', language: 'English', version: '1', size: 14,
    downlink: 'https://api.gog.com/products/official-size-game/downlink', selected: true, verified: false }]);
  const originalFetch = globalThis.fetch;
  const md5 = new Bun.CryptoHasher('md5').update(bytes).digest('hex');
  globalThis.fetch = Object.assign(async () => new Response(`<file md5="${md5}" total_size="${bytes.length}"/>`), { preconnect: originalFetch.preconnect });
  try {
    const preview = (await importPreview(source))[0]!;
    await importGame(preview.source, 'official-size-game', preview.signature, 'copy');
    expect(gameById('official-size-game')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
    expect(filesFor('official-size-game')[0]).toMatchObject({ verified: true, verificationSource: 'gog-checksum', verifiedSize: bytes.length });
  } finally { globalThis.fetch = originalFetch; }
});

test('Full Verify clears its lock after completion and failure', async () => {
  const root = join(directory, 'verify-jobs-vault');
  await mkdir(root);
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'verify-jobs', title: 'Verify Jobs' });
  mapVaultGame('verify-jobs', 'Verify Jobs');
  await mkdir(join(root, 'Verify Jobs'));
  const finished = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = verificationJobs().find(item => item.id === id);
      if (job && ['complete', 'failed', 'cancelled'].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Verification job did not finish');
  };
  const first = enqueueVerification('verify-jobs');
  expect(() => enqueueVerification('verify-jobs')).toThrow('Verification already running');
  expect(hasActiveVerification()).toBe(true);
  expect((await finished(first.id)).state).toBe('complete');
  expect(hasActiveVerification()).toBe(false);
  await rm(root, { recursive: true });
  const failed = enqueueVerification('verify-jobs');
  expect((await finished(failed.id)).state).toBe('failed');
  expect(hasActiveVerification()).toBe(false);
  expect(gameById('verify-jobs')?.folder).toBe('Verify Jobs');
  await mkdir(join(root, 'Verify Jobs'), { recursive: true });
  expect((await finished(enqueueVerification('verify-jobs').id)).state).toBe('complete');
  upsertGame({ id: 'verify-jobs-second', title: 'Second Verify' });
  mapVaultGame('verify-jobs-second', 'Second Verify');
  await mkdir(join(root, 'Second Verify'));
  const running = enqueueVerification('verify-jobs');
  const waiting = enqueueVerification('verify-jobs-second');
  expect(waiting.state).toBe('queued');
  cancelVerification(waiting.id);
  expect((await finished(waiting.id)).state).toBe('cancelled');
  expect((await finished(running.id)).state).toBe('complete');
  expect((await finished(enqueueVerification('verify-jobs-second').id)).state).toBe('complete');
});

test('Windows vault display paths keep native separators for UNC, drives and nested folders', () => {
  expect(win32.join('\\\\server\\share\\Games\\GOG Vault', 'Agony')).toBe('\\\\server\\share\\Games\\GOG Vault\\Agony');
  expect(win32.join('D:\\Vault', 'Agony')).toBe('D:\\Vault\\Agony');
  expect(win32.join('D:\\Vault', 'Agony', 'Previous Versions')).toBe('D:\\Vault\\Agony\\Previous Versions');
  expect('Agony/Previous Versions').toBe('Agony/Previous Versions');
});

test('refresh replaces stale card and tiny logo while retaining the banner hero and icon', () => {
  upsertGame({ id: '303', title: 'Agony media roles', slug: 'agony-media' });
  const banner = 'https://images.gog-statics.com/banner.jpg';
  const cardLogo = 'https://images.gog-statics.com/full-size.png';
  const icon = 'https://images.gog-statics.com/icon.png';
  const asset = (key: string, role: 'card' | 'hero' | 'logo' | 'icon', url: string) => ({ key, gameId: '303', role, url, poster: '', localPath: '', size: 0, selected: false, external: false });
  replaceMedia('303', [asset('old-card', 'card', banner), asset('hero', 'hero', banner), asset('tiny-logo', 'logo', 'https://images.gog-statics.com/tiny.png'), asset('icon', 'icon', icon)]);
  replaceMedia('303', [asset('full-card', 'card', cardLogo), asset('hero', 'hero', banner), asset('full-logo', 'logo', cardLogo), asset('icon', 'icon', icon)]);
  expect(mediaFor('303').map(({ role, url }) => [role, url])).toEqual([
    ['card', cardLogo], ['hero', banner], ['icon', icon], ['logo', cardLogo]
  ]);
  expect(uniqueMedia(mediaFor('303')).map(({ roles, url }) => [roles, url])).toEqual([
    [['card', 'logo'], cardLogo], [['hero'], banner], [['icon'], icon]
  ]);
});
test('Blades DLC remains its own card while the parent references one existing installer', async () => {
  const root = join(directory, 'blades-vault');
  const parentFolder = join(root, 'Blades of Time');
  await mkdir(parentFolder, { recursive: true });
  const filename = 'setup_blades_of_time_-_dismal_swamp_1.0_(39944).exe';
  const content = Buffer.from('Dismal Swamp fixture');
  await writeFile(join(parentFolder, filename), content);
  await writeFile(join(parentFolder, 'parent.exe'), 'abc');
  const info = await import('node:fs/promises').then(fs => fs.lstat(join(parentFolder, filename)));
  const mainInfo = await import('node:fs/promises').then(fs => fs.lstat(join(parentFolder, 'parent.exe')));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'blades-base', title: 'Blades of Time', platforms: ['windows'] });
  upsertGame({ id: 'blades-child', title: 'Blades of Time - Dismal Swamp DLC', platforms: ['windows'] });
  const insert = db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,selected)
    VALUES (?,?,?,?,?,'English','1',?,'https://api.gog.com/child',1)`);
  insert.run('blades-base', 'blades-main', 'parent.exe', 'main', 'windows', 3);
  insert.run('blades-base', 'blades-child:installers:1:1', filename, 'dlc', 'windows', content.length);
  insert.run('blades-child', 'blades-child:installers:1:1', filename, 'main', 'windows', content.length);
  mapVaultGame('blades-base', 'Blades of Time');
  saveLocalGame('blades-base', { localSize: content.length + 3 });
  saveFileState('blades-base', 'blades-main', { matched: true, verified: true, name: 'parent.exe', verifiedSize: 3, verificationSource: 'local-sha256' });
  saveFileState('blades-base', 'blades-child:installers:1:1', { matched: true, verified: true, name: filename, verifiedSize: content.length });
  db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?)')
    .run(activeVault()!.id, 'blades-base', filename, content.length, Math.round(info.mtimeMs), createHash('sha256').update(content).digest('hex'), 'now');
  db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?)')
    .run(activeVault()!.id, 'blades-base', 'parent.exe', 3, Math.round(mainInfo.mtimeMs), createHash('sha256').update('abc').digest('hex'), 'now');
  linkDlcProducts('blades-base', ['blades-child']);
  replaceFiles('blades-child', filesFor('blades-child'));
  expect(gameById('blades-child')).toMatchObject({ productType: 'dlc', parentProduct: { id: 'blades-base' }, status: 'Vaulted', completion: { main: 100 }, localSize: content.length });
  expect(gameById('blades-base')).toMatchObject({ status: 'Vaulted', completion: { dlc: 100 }, localSize: 3 });
  expect(filesFor('blades-base').map(file => file.key)).toEqual(['blades-main']);
  expect(db.query('SELECT COUNT(*) AS count FROM vault_local_files WHERE relative_path=?').get(filename)).toEqual({ count: 1 });
  const duplicateSource = join(directory, 'blades-duplicate-source');
  await mkdir(join(duplicateSource, '.gog-vault'), { recursive: true });
  await writeFile(join(duplicateSource, '.gog-vault', 'metadata.json'), JSON.stringify({ id: 'blades-child' }));
  await writeFile(join(duplicateSource, filename), content);
  const duplicatePreview = (await importPreview(duplicateSource))[0]!;
  expect(duplicatePreview.candidates.find(candidate => candidate.id === 'blades-child')?.existingFolder).toBe(true);
  await expect(importGame(duplicatePreview.source, 'blades-child', duplicatePreview.signature, 'copy')).rejects.toThrow('existing folder');
  selectDlcProduct('blades-base', 'blades-child', false);
  expect(gameById('blades-base')).toMatchObject({ status: 'Vaulted', availability: { dlc: 'off' }, completion: { dlc: null } });
  expect(gameById('blades-child')?.status).toBe('Vaulted');
  selectDlcProduct('blades-base', 'blades-child', true);
  expect(gameById('blades-base')?.completion.dlc).toBe(100);
  setHiddenGames(['blades-child'], true);
  expect(gameById('blades-base')?.hiddenFromLibrary).toBe(false);
  expect(gameById('blades-child')?.hiddenFromLibrary).toBe(true);
  expect(await scanGame('blades-base')).toMatchObject({ completion: { dlc: 100 } });
  expect(await scanGame('blades-child', true)).toMatchObject({ completion: { main: 100 } });
  const parentVerify = enqueueVerification('blades-base');
  const childVerify = verificationJobs().find(job => job.gameId === 'blades-child' && job.state === 'queued');
  expect(childVerify).toBeDefined();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DLC verification timed out')), 5000);
    const poll = setInterval(() => {
      if ([parentVerify.id, childVerify!.id].every(id => verificationJobs().find(job => job.id === id)?.state === 'complete')) {
        clearInterval(poll); clearTimeout(timeout); resolve();
      }
    }, 10);
  });
  expect(db.query('SELECT COUNT(*) AS count FROM vault_local_files WHERE vault_id=? AND relative_path=?').get(activeVault()!.id, filename))
    .toEqual({ count: 1 });
  replaceFiles('blades-child', [{ key: 'blades-child:installers:1:1', gameId: 'blades-child', name: filename,
    category: 'main', platform: 'windows', language: 'English', version: '2', size: content.length,
    downlink: 'https://api.gog.com/child', selected: true, verified: false }]);
  expect(gameById('blades-child')).toMatchObject({ status: 'Vaulted', completion: { main: 100 }, archive: { updateState: 'manifest_changed' } });
  expect(gameById('blades-base')).toMatchObject({ status: 'Vaulted', completion: { dlc: 100 }, archive: { updateState: 'manifest_changed' } });
  await scanGame('blades-child', true);
  expect(filesFor('blades-child')[0]?.verified).toBe(false);
  expect(gameById('blades-base')).toMatchObject({ status: 'Vaulted', archive: { updateState: 'manifest_changed' } });
  const secondVault = join(directory, 'blades-other-vault');
  await mkdir(secondVault);
  saveSettings({ vaultPath: secondVault });
  expect(gameById('blades-child')).toMatchObject({ status: 'Not Downloaded', completion: { main: 0 } });
  expect(gameById('blades-base')).toMatchObject({ completion: { dlc: 0 } });
  saveSettings({ vaultPath: root });
  expect(gameById('blades-base')?.completion.dlc).toBe(100);
});
test('a base game adopts verified DLC after its child was linked to another edition', async () => {
  const root = join(directory, 'blasphemous-vault');
  const folder = join(root, 'Blasphemous');
  await mkdir(folder, { recursive: true });
  const filename = 'setup_blasphemous_alloy_of_sin.exe';
  const content = Buffer.from('Alloy of Sin installer');
  await writeFile(join(folder, filename), content);
  await writeFile(join(folder, 'blasphemous.exe'), 'base');
  const info = await import('node:fs/promises').then(fs => fs.lstat(join(folder, filename)));
  const baseInfo = await import('node:fs/promises').then(fs => fs.lstat(join(folder, 'blasphemous.exe')));
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'blasphemous-base', title: 'Blasphemous' });
  upsertGame({ id: 'blasphemous-deluxe', title: 'Blasphemous Digital Deluxe Edition' });
  upsertGame({ id: 'alloy-skin', title: 'Alloy of Sin Character Skin', productType: 'dlc' });
  const childFile = { key: 'alloy-skin:installers:1:1', gameId: 'alloy-skin', name: filename,
    category: 'main' as const, platform: 'windows' as const, language: 'English', version: '1', size: content.length,
    downlink: 'https://api.gog.com/child', selected: true, verified: false, provenance: { sourceProductId: 'alloy-skin' } };
  replaceFiles('alloy-skin', [childFile]);
  linkDlcProducts('blasphemous-deluxe', ['alloy-skin']);
  const parentFile = { ...childFile, gameId: 'blasphemous-base', category: 'dlc' as const };
  const baseFile = { ...childFile, key: 'blasphemous-base:installers:1:1', gameId: 'blasphemous-base', name: 'blasphemous.exe' };
  replaceFiles('blasphemous-base', [baseFile, parentFile]);
  mapVaultGame('blasphemous-base', 'Blasphemous');
  saveLocalGame('blasphemous-base', { localSize: content.length + 4 });
  saveFileState('blasphemous-base', baseFile.key, { name: 'blasphemous.exe', matched: true, verified: true, verifiedSize: 4 });
  saveFileState('blasphemous-base', parentFile.key, { name: filename, matched: true, verified: true, verifiedSize: content.length });
  db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?)')
    .run(activeVault()!.id, 'blasphemous-base', filename, content.length, Math.round(info.mtimeMs), createHash('sha256').update(content).digest('hex'), 'now');
  db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (?,?,?,?,?,?,?)')
    .run(activeVault()!.id, 'blasphemous-base', 'blasphemous.exe', 4, Math.round(baseInfo.mtimeMs), createHash('sha256').update('base').digest('hex'), 'now');
  replaceFiles('blasphemous-base', [baseFile, parentFile]);
  expect(db.query('SELECT parent_product_id FROM product_relationships WHERE child_product_id=? ORDER BY parent_product_id').all('alloy-skin'))
    .toEqual([{ parent_product_id: 'blasphemous-base' }, { parent_product_id: 'blasphemous-deluxe' }]);
  expect(gameById('alloy-skin')).toMatchObject({ parentProduct: { id: 'blasphemous-base' }, status: 'Vaulted', completion: { main: 100 } });
  expect(filesFor('alloy-skin')[0]?.provenance?.parentProductId).toBe('blasphemous-base');
  expect(gameById('blasphemous-base')).toMatchObject({ status: 'Vaulted', completion: { dlc: 100 } });
  expect(filesFor('blasphemous-base').map(file => file.key)).toEqual([baseFile.key]);
  expect(db.query('SELECT storage_game_id FROM vault_child_file_locations WHERE child_product_id=? AND file_key=?')
    .get('alloy-skin', childFile.key)).toEqual({ storage_game_id: 'blasphemous-base' });
});
test('an existing DLC-only bundle reports its archived components without inventing a base-game parent', async () => {
  const root = join(directory, 'sacrament-vault');
  await mkdir(join(root, 'Mea Culpa'), { recursive: true });
  await writeFile(join(root, 'Mea Culpa', 'mea-culpa.exe'), 'dlc');
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'sacrament-bundle', title: 'Complete Sacrament Edition Bundle', slug: 'blasphemous_2_complete_sacrament_edition_bundle' });
  upsertGame({ id: 'sacrament-dlc', title: 'Mea Culpa', productType: 'dlc' });
  replaceFiles('sacrament-dlc', [{ key: 'sacrament-dlc:installers:1:1', gameId: 'sacrament-dlc', name: 'mea-culpa.exe',
    category: 'main', platform: 'windows', language: 'English', version: '1', size: 3,
    downlink: 'https://api.gog.com/dlc', selected: true, verified: false }]);
  mapVaultGame('sacrament-dlc', 'Mea Culpa');
  saveLocalGame('sacrament-dlc', { localSize: 3 });
  saveFileState('sacrament-dlc', 'sacrament-dlc:installers:1:1', { matched: true, verified: true, name: 'mea-culpa.exe', verifiedSize: 3 });
  upsertGame({ id: 'sacrament-soundtrack', title: 'Original Soundtrack', productType: 'dlc' });
  replaceFiles('sacrament-soundtrack', [{ key: 'sacrament-soundtrack:extra:1', gameId: 'sacrament-soundtrack', name: 'soundtrack.zip',
    category: 'extras', platform: 'windows', language: 'English', version: '1', size: 5,
    downlink: 'https://api.gog.com/soundtrack', selected: false, verified: false }]);
  linkDlcProducts('sacrament-bundle', ['sacrament-dlc', 'sacrament-soundtrack']);
  expect(gameById('sacrament-bundle')).toMatchObject({ productType: 'bundle', parentProduct: undefined,
    status: 'Vaulted', completion: { main: null, dlc: 100 }, dlcChildren: [{ id: 'sacrament-dlc', selected: true, pending: false },
      { id: 'sacrament-soundtrack', selected: true, pending: false }] });
  db.query('UPDATE remote_files SET selected=1 WHERE game_id=?').run('sacrament-soundtrack');
  expect(gameById('sacrament-bundle')).toMatchObject({ status: 'Incomplete', completion: { dlc: 38 },
    dlcChildren: [{ id: 'sacrament-dlc', pending: false }, { id: 'sacrament-soundtrack', pending: true }] });
});
test('importing a child DLC updates its parent without a second local installer', async () => {
  const root = join(directory, 'dlc-import-vault');
  const source = join(directory, 'dlc-import-source', 'Imported DLC');
  await mkdir(root);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'installer.bin'), 'child installer');
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'import-dlc-parent', title: 'Import Parent' });
  upsertGame({ id: 'import-dlc-child', title: 'Imported DLC' });
  replaceFiles('import-dlc-parent', [{ key: 'parent', gameId: 'import-dlc-parent', name: 'parent.exe', category: 'main', platform: 'windows', language: 'English', version: '1', size: 3, downlink: 'https://api.gog.com/parent', selected: true, verified: true }]);
  replaceFiles('import-dlc-child', [{ key: 'child', gameId: 'import-dlc-child', name: 'installer.bin', category: 'main', platform: 'windows', language: 'English', version: '1', size: 15, downlink: 'https://api.gog.com/child', selected: true, verified: false }]);
  mapVaultGame('import-dlc-parent', 'Import Parent');
  saveFileState('import-dlc-parent', 'parent', { name: 'parent.exe', matched: true, verified: true });
  linkDlcProducts('import-dlc-parent', ['import-dlc-child']);
  expect(gameById('import-dlc-parent')).toMatchObject({ completion: { dlc: 0 }, status: 'Incomplete' });
  const preview = (await importPreview(source))[0]!;
  await importGame(preview.source, 'import-dlc-child', preview.signature, 'copy');
  expect(gameById('import-dlc-child')).toMatchObject({ status: 'Vaulted', completion: { main: 100 } });
  expect(gameById('import-dlc-parent')).toMatchObject({ status: 'Vaulted', completion: { dlc: 100 } });
  expect(db.query('SELECT game_id,COUNT(*) AS count FROM vault_local_files WHERE vault_id=? AND relative_path=? GROUP BY game_id').all(activeVault()!.id, 'installer.bin'))
    .toEqual([{ game_id: 'import-dlc-child', count: 1 }]);
});

test('scan retains size-only Extra verification when advertised checksum XML is missing', async () => {
  const root = join(directory, 'bonus-vault');
  const folder = join(root, 'Music Game');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'track.flac'), 'music');
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'bonus-scan', title: 'Music Game' });
  replaceFiles('bonus-scan', [{ key: 'bonus-missing', gameId: 'bonus-scan', name: 'track.flac', category: 'extras', platform: 'windows', language: 'English', version: '1', size: 5,
    downlink: 'https://api.gog.com/products/bonus-scan/downlink/product_bonus/1', selected: true, verified: false }]);
  mapVaultGame('bonus-scan', 'Music Game');
  await scanGame('bonus-scan');
  db.query('UPDATE vault_local_files SET sha256=?,verified_at=? WHERE vault_id=? AND game_id=?').run(createHash('sha256').update('music').digest('hex'), new Date().toISOString(), activeVault()!.id, 'bonus-scan');
  saveFileState('bonus-scan', 'bonus-missing', { matched: true, verified: true, name: 'track.flac', verifiedSize: 5, verificationSource: 'local-sha256', checksumUrl: '' });
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: previousFetch.preconnect });
    expect((await scanGame('bonus-scan', true)).completion.extras).toBe(100);
    expect(filesFor('bonus-scan')[0]).toMatchObject({ verified: true, verificationSource: 'local-sha256', verifiedSize: 5 });
    globalThis.fetch = Object.assign(async () => new Response('<file md5="00000000000000000000000000000000" total_size="5"/>'), { preconnect: previousFetch.preconnect });
    await scanGame('bonus-scan', true);
    expect(filesFor('bonus-scan')[0]).toMatchObject({ verified: false, verificationSource: '' });
  } finally { globalThis.fetch = previousFetch; }
});

test('ownership refresh removes unowned DLC content but preserves local archive records', async () => {
  const root = join(directory, 'ownership-vault');
  const folder = join(root, 'Old soundtrack');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'soundtrack.zip'), 'saved bytes');
  saveSettings({ vaultPath: root });
  upsertGame({ id: 'owned-base', title: 'Owned Game' });
  upsertGame({ id: 'unowned-child', title: 'Separate Soundtrack', productType: 'dlc' });
  const manual = { key: 'owned-base:bonus_content:1993:1993', gameId: 'owned-base', name: 'manual (55 pages)', category: 'extras' as const,
    platform: 'windows' as const, language: 'Neutral', version: '', size: 1048576,
    downlink: 'https://api.gog.com/products/owned-base/downlink/product_bonus/1993', selected: true, verified: false,
    provenance: { sourceProductId: 'owned-base', bonusContentId: '1993', bonusType: 'manuals', bonusTotalSize: 1048576, fileId: '1993' } };
  replaceFiles('owned-base', [manual]);
  db.query('UPDATE remote_files SET unavailable=1 WHERE game_id=?').run('owned-base');
  replaceFiles('unowned-child', [{ key: 'unowned-child:bonus_content:1:1', gameId: 'unowned-child', name: 'soundtrack.zip', category: 'extras',
    platform: 'windows', language: 'Neutral', version: '', size: 11, downlink: 'https://api.gog.com/products/123/downlink/product_bonus/1', selected: true, verified: false,
    provenance: { sourceProductId: 'unowned-child', bonusContentId: '1', bonusType: 'audio', bonusTotalSize: 11, fileId: '1' } }]);
  linkDlcProducts('owned-base', ['unowned-child']);
  expect(filesFor('unowned-child')[0]?.provenance).toMatchObject({ sourceProductId: 'unowned-child', parentProductId: 'owned-base', bonusType: 'audio' });
  mapVaultGame('unowned-child', 'Old soundtrack');
  db.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms) VALUES (?,?,?,?,?)')
    .run(activeVault()!.id, 'unowned-child', 'soundtrack.zip', 11, 1);
  saveOwnedProducts(new Set(['owned-base']));
  expect(filesFor('owned-base')[0]).toMatchObject({ selected: true, unavailable: true, provenance: manual.provenance });
  expect(db.query('SELECT selected FROM remote_files WHERE game_id=?').all('unowned-child')).toEqual([]);
  expect(db.query('SELECT child_product_id FROM product_relationships WHERE parent_product_id=?').all('owned-base')).toEqual([]);
  expect(games().some(game => game.id === 'unowned-child')).toBe(false);
  expect(db.query('SELECT relative_path FROM vault_local_files WHERE game_id=?').get('unowned-child')).toEqual({ relative_path: 'soundtrack.zip' });
  expect(await readFile(join(folder, 'soundtrack.zip'), 'utf8')).toBe('saved bytes');
  replaceFiles('owned-base', [manual]);
  expect(filesFor('owned-base')[0]).toMatchObject({ selected: true, unavailable: false, provenance: manual.provenance });
});