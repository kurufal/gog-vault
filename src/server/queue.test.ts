import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredFingerprint, type RemoteFile } from '../shared/domain';

test('a queued download uses its saved manifest after refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-snapshot-'));
  process.env.GOG_VAULT_DATA_DIR = dir;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const downloaded: RemoteFile[] = [];
  const scanned: string[] = [];
  let secondStarted = false;
  mock.module('./storage', () => ({
    folderName: () => 'Game', vaultPath: async () => { await ready; return dir; },
    gameFolder: async () => dir, scanGame: async (gameId: string) => { scanned.push(gameId); }, writeOfflineMetadata: async () => {}
  }));
  mock.module('./transfer', () => ({ downloadFile: async (file: RemoteFile, _folder: string, signal: AbortSignal, _progress: unknown, _verify: unknown, _resume: unknown, _verified: unknown, onStage?: (stage: string, status: number) => void) => {
    if (file.gameId === '44') { onStage?.('http_response', 416); throw new Error('Download failed at https://cdn.gog.com/file?token=secret'); }
    if (file.key === '45:bonus') { onStage?.('resolve_downlink', 404); throw new Error('GOG /products/42/downlink/product_bonus/90287 returned HTTP 404'); }
    if (file.gameId === '43') await new Promise<void>((_resolve, reject) => {
      secondStarted = true;
      if (signal.aborted) { reject(new Error('Interrupted')); return; }
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
    downloaded.push(file);
    return file.name;
  } }));
  mock.module('./gog/client', () => ({ endpoints: { api: 'https://api.gog.com', embed: 'https://embed.gog.com' },
    gogRequest: async (url: string) => {
      expect(url).toBe('https://embed.gog.com/user/data/games');
      return { owned: ['42', '43', '44', '45', '46', '47', '50', '51', '60', '61'] };
    } }));
  const { activeVault, db, filesFor, upsertGame, replaceFiles, saveSettings, linkDlcProducts } = await import('./db');
  const { command, enqueue, enqueueWithChildren, shutdownQueue } = await import('./queue');
  const { refreshOwnedProducts, saveProductManifest } = await import('./gog/library');
  try {
    saveSettings({ vaultPath: dir });
    upsertGame({ id: '42', title: 'Game' });
    const original: RemoteFile = { key: '42:installer', gameId: '42', name: 'Game (Part 1 of 11)', category: 'main',
      platform: 'windows', language: 'English', version: '1', size: 12, downlink: 'https://api.gog.com/products/42/v1', selected: true, verified: false };
    replaceFiles('42', [original, { ...original, key: '42:part10', name: 'Game (Part 10 of 11)' }, { ...original, key: '42:part2', name: 'Game (Part 2 of 11)' }]);
    const id = enqueue('42');
    replaceFiles('42', [{ ...original, version: '2', size: 20, downlink: 'https://api.gog.com/products/42/v2' }]);
    expect(JSON.parse((db.query('SELECT snapshot FROM download_files WHERE job_id=?').get(id) as { snapshot: string }).snapshot)).toMatchObject(original);
    release();
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Queue did not finish')), 5000);
      const poll = setInterval(() => {
        if ((db.query('SELECT state FROM download_jobs WHERE id=?').get(id) as { state: string }).state === 'complete') {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    await done;
    expect(scanned).toContain('42');
    expect(downloaded.map(file => file.name)).toEqual(['Game (Part 1 of 11)', 'Game (Part 2 of 11)', 'Game (Part 10 of 11)']);
    expect(downloaded[0]?.downlink).toBe(original.downlink);
    expect(downloaded[0]?.version).toBe('1');
    expect(db.query('SELECT verified FROM remote_files WHERE game_id=? AND key=?').get('42', original.key)).toEqual({ verified: 0 });
    upsertGame({ id: '44', title: 'Broken Game' });
    replaceFiles('44', [{ ...original, gameId: '44', key: '44:installer' }]);
    const failed = enqueue('44');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Failure was not recorded')), 5000);
      const poll = setInterval(() => {
        if ((db.query('SELECT state FROM download_jobs WHERE id=?').get(failed) as { state: string }).state === 'error') {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    const failure = db.query('SELECT error,error_details FROM download_jobs WHERE id=?').get(failed) as { error: string; error_details: string };
    expect(failure.error).not.toContain('token=secret');
    expect(JSON.parse(failure.error_details)).toMatchObject({ stage: 'http_response', httpStatus: 416, productId: '44', partNumber: 1 });
    upsertGame({ id: '45', title: 'Game with unavailable bonus' });
    replaceFiles('45', [{ ...original, gameId: '45', key: '45:main' },
      { ...original, gameId: '45', key: '45:bonus', name: 'soundtrack (WAV)', category: 'extras', size: 100, selected: true }]);
    const bonusJob = enqueue('45');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bonus failure was not recorded')), 5000);
      const poll = setInterval(() => {
        if ((db.query('SELECT state FROM download_jobs WHERE id=?').get(bonusJob) as { state: string }).state === 'error') {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    expect(db.query('SELECT file_key,state FROM download_files WHERE job_id=? ORDER BY file_key').all(bonusJob)).toEqual([
      { file_key: '45:bonus', state: 'queued' }, { file_key: '45:main', state: 'complete' }
    ]);
    expect(filesFor('45').find(file => file.key === '45:bonus')?.unavailable).toBe(true);
    expect(() => command(bonusJob, 'resume')).toThrow('Refresh GOG metadata');
    db.query('UPDATE remote_files SET selected=0 WHERE game_id=? AND key=?').run('45', '45:bonus');
    command(bonusJob, 'resume');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Skipped bonus did not finish')), 5000);
      const poll = setInterval(() => {
        if ((db.query('SELECT state FROM download_jobs WHERE id=?').get(bonusJob) as { state: string }).state === 'complete') {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    expect(db.query('SELECT file_key,state FROM download_files WHERE job_id=?').all(bonusJob)).toEqual([{ file_key: '45:main', state: 'complete' }]);
    expect(db.query('SELECT bytes,total FROM download_jobs WHERE id=?').get(bonusJob)).toEqual({ bytes: 12, total: 12 });
    expect(db.query('SELECT desired_hash FROM download_jobs WHERE id=?').get(bonusJob)).toEqual({ desired_hash: desiredFingerprint(filesFor('45')) });
    expect(downloaded.filter(file => file.gameId === '45').map(file => file.key)).toEqual(['45:main']);
    upsertGame({ id: '46', title: 'Old bonus manifest' });
    const retained = { ...original, gameId: '46', key: '46:main' };
    const stale = { ...retained, key: '1438925691:bonus_content:90287:90287', name: 'soundtrack (WAV)', category: 'extras' as const, selected: true };
    replaceFiles('46', [retained, stale]);
    await writeFile(join(dir, 'archived.exe'), 'already archived');
    const staleJob = db.query("INSERT INTO download_jobs(game_id,state,created_at,updated_at,vault_id) VALUES ('46','error','now','now',?) RETURNING id")
      .get(activeVault()!.id) as { id: number };
    db.query("INSERT INTO download_files(job_id,file_key,state) VALUES (?,?,'complete')").run(staleJob.id, retained.key);
    db.query('INSERT INTO download_files(job_id,file_key,snapshot) VALUES (?,?,?)').run(staleJob.id, stale.key, JSON.stringify(stale));
    saveProductManifest('46', [retained], []);
    expect(db.query('SELECT state FROM download_jobs WHERE id=?').get(staleJob.id)).toEqual({ state: 'cancelled' });
    expect(db.query('SELECT file_key,state FROM download_files WHERE job_id=? ORDER BY file_key').all(staleJob.id)).toEqual([
      { file_key: stale.key, state: 'queued' }, { file_key: retained.key, state: 'complete' }
    ]);
    expect(filesFor('46').map(file => file.key)).toEqual([retained.key]);
    expect(await readFile(join(dir, 'archived.exe'), 'utf8')).toBe('already archived');
    upsertGame({ id: '47', title: 'Owned parent' });
    upsertGame({ id: '48', title: 'Unowned bonus DLC', productType: 'dlc' });
    const childFile = { ...stale, gameId: '48', key: '48:bonus' };
    replaceFiles('48', [childFile]);
    linkDlcProducts('47', ['48']);
    const childJob = db.query("INSERT INTO download_jobs(game_id,state,created_at,updated_at,vault_id) VALUES ('48','paused','now','now',?) RETURNING id")
      .get(activeVault()!.id) as { id: number };
    db.query('INSERT INTO download_files(job_id,file_key,snapshot) VALUES (?,?,?)').run(childJob.id, childFile.key, JSON.stringify(childFile));
    await refreshOwnedProducts();
    expect(db.query('SELECT state FROM download_jobs WHERE id=?').get(childJob.id)).toEqual({ state: 'cancelled' });
    expect(filesFor('48')).toEqual([]);
    expect(db.query('SELECT child_product_id FROM product_relationships WHERE parent_product_id=?').all('47')).toEqual([]);
    expect(await readFile(join(dir, 'archived.exe'), 'utf8')).toBe('already archived');
    upsertGame({ id: '50', title: 'Blades of Time' });
    upsertGame({ id: '51', title: 'Blades of Time - Dismal Swamp DLC' });
    replaceFiles('50', [{ ...original, gameId: '50', key: '50:main' }]);
    replaceFiles('51', [{ ...original, gameId: '51', key: '51:installer' }]);
    linkDlcProducts('50', ['51']);
    const dlcJobs = enqueueWithChildren('50');
    expect(dlcJobs).toHaveLength(2);
    expect(db.query('SELECT game_id FROM download_jobs WHERE id IN (?,?) ORDER BY id').all(...dlcJobs)).toEqual([{ game_id: '50' }, { game_id: '51' }]);
    expect(db.query('SELECT file_key FROM download_files WHERE job_id=?').get(dlcJobs[1])).toEqual({ file_key: '51:installer' });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child download did not finish')), 5000);
      const poll = setInterval(() => {
        if (dlcJobs.every(job => (db.query('SELECT state FROM download_jobs WHERE id=?').get(job) as { state: string }).state === 'complete')) {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    expect(downloaded.filter(file => file.gameId === '51')).toHaveLength(1);
    upsertGame({ id: '60', title: 'Legacy base game' });
    upsertGame({ id: '61', title: 'Legacy queued DLC' });
    replaceFiles('61', [{ ...original, gameId: '61', key: '61:installer' }]);
    const legacy = db.query("INSERT INTO download_jobs(game_id,state,created_at,updated_at,vault_id) VALUES ('60','error','now','now',?) RETURNING id")
      .get(activeVault()!.id) as { id: number };
    db.query('INSERT INTO download_files(job_id,file_key) VALUES (?,?)').run(legacy.id, '61:installer');
    expect(() => enqueue('61')).toThrow('legacy parent download');
    upsertGame({ id: '43', title: 'Second Game' });
    replaceFiles('43', [{ ...original, gameId: '43', key: '43:installer' }]);
    const interrupted = enqueue('43');
    const active = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Second download did not start')), 5000);
      const poll = setInterval(() => {
        if (secondStarted && (db.query('SELECT state FROM download_jobs WHERE id=?').get(interrupted) as { state: string }).state === 'downloading') {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    await active;
    await shutdownQueue();
    expect(db.query('SELECT state FROM download_jobs WHERE id=?').get(interrupted)).toEqual({ state: 'queued' });
    expect(db.query('SELECT state FROM download_files WHERE job_id=?').get(interrupted)).toEqual({ state: 'queued' });
  } finally {
    release();
    await shutdownQueue();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});