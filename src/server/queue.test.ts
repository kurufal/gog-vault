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
  let overlapStarted = false;
  let releaseVerification!: () => void;
  let releaseTransfer!: () => void;
  const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
  const transferGate = new Promise<void>(resolve => { releaseTransfer = resolve; });
  let releasePack!: () => void;
  const packGate = new Promise<void>(resolve => { releasePack = resolve; });
  const packMetadataCalls: string[] = [];
  mock.module('./storage', () => ({
    folderName: () => 'Game', vaultPath: async () => { await ready; return dir; },
    gameFolder: async () => dir, scanGame: async (gameId: string) => { scanned.push(gameId); }, writeOfflineMetadata: async () => {}
  }));
  mock.module('./transfer', () => ({ downloadFile: async (file: RemoteFile, _folder: string, signal: AbortSignal, _progress: unknown, onVerify?: (size?: number) => void | Promise<void>, onDownload?: () => void | Promise<void>, _verified?: unknown, onStage?: (stage: string, status: number) => void) => {
    if (file.key === '80:first') { await onVerify?.(file.size); await verificationGate; }
    if (file.gameId === '81') { await onDownload?.(); overlapStarted = true; await transferGate; }
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
  mock.module('./gog/auth', () => ({ accountInfo: async () => ({ connected: true, userId: 'fixture' }) }));
  mock.module('./gog/products', () => ({ product: async (id: string) => {
    packMetadataCalls.push(id);
    if (id !== '90') throw new Error('GOG unavailable');
    await packGate;
    return { info: { id, title: 'Recovered deluxe pack', productType: 'bundle', gogGameType: 'pack' },
      files: [], media: [], childIds: [], inclusionIds: ['72', '73'], inclusionError: '' };
  }, parseProduct: (raw: unknown) => raw, trustedGogUrl: () => false, secureLink: async () => { throw new Error('No live download links in this test'); } }));
  const { activeVault, db, filesFor, gameById, jobsFor, upsertGame, replaceFiles, saveSettings, linkDlcProducts, saveProductInclusions, recordInclusionError } = await import('./db');
  const { command, enqueue, enqueueWithChildren, missingFilesForParent, shutdownQueue } = await import('./queue');
  const { refreshIncompletePacks, refreshOwnedProducts, saveProductManifest } = await import('./gog/library');
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
    const history = jobsFor('42').find(job => job.id === id)!;
    expect(history.startedAt).toBeTruthy();
    expect(history.finishedAt).toBeTruthy();
    expect(Date.parse(history.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(history.startedAt!));
    expect(history.files?.map(file => ({ name: file.name, state: file.state }))).toEqual([
      { name: 'Game (Part 1 of 11)', state: 'complete' }, { name: 'Game (Part 10 of 11)', state: 'complete' }, { name: 'Game (Part 2 of 11)', state: 'complete' }
    ]);
    expect(JSON.stringify(history.files)).not.toContain('https://');
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
    upsertGame({ id: '52', title: 'Bonus bundle', slug: 'bonus_bundle' });
    upsertGame({ id: '53', title: 'Soundtrack', productType: 'dlc' });
    replaceFiles('53', [{ ...original, gameId: '53', key: '53:bonus', category: 'extras', selected: false }]);
    linkDlcProducts('52', ['53']);
    expect(missingFilesForParent(gameById('52')!, '53').map(file => file.key)).toEqual(['53:bonus']);
    expect(missingFilesForParent(gameById('50')!, '53')).toEqual([]);
    const bonusJobs = enqueueWithChildren('52');
    expect(bonusJobs).toHaveLength(1);
    expect(db.query('SELECT game_id FROM download_jobs WHERE id=?').get(bonusJobs[0])).toEqual({ game_id: '53' });
    expect(db.query('SELECT file_key FROM download_files WHERE job_id=?').get(bonusJobs[0])).toEqual({ file_key: '53:bonus' });
    expect(filesFor('53')[0]?.selected).toBe(true);
    upsertGame({ id: '70', title: 'Outer collection', productType: 'bundle' });
    upsertGame({ id: '71', title: 'Premium edition', productType: 'bundle' });
    upsertGame({ id: '72', title: 'Included base game' });
    upsertGame({ id: '73', title: 'Included season pass', productType: 'dlc' });
    replaceFiles('70', []); replaceFiles('71', []);
    replaceFiles('72', [{ ...original, gameId: '72', key: '72:installer' }]);
    replaceFiles('73', [{ ...original, gameId: '73', key: '73:installer' }]);
    saveProductInclusions('71', ['72', '73']); saveProductInclusions('70', ['71', '72']);
    linkDlcProducts('71', ['73']);
    recordInclusionError('71', 'GOG metadata unavailable');
    expect(gameById('71')).toMatchObject({ inclusionWarning: true, includedProducts: expect.arrayContaining([{ id: '72', title: 'Included base game', owned: true, selected: true, status: 'Not Downloaded', completion: 0, pending: true }]) });
    saveProductInclusions('71', ['72', '73']);
    expect(gameById('71')?.inclusionError).toBeUndefined();
    const includedJobs = enqueueWithChildren('70');
    expect(includedJobs).toHaveLength(2);
    expect(db.query("SELECT game_id FROM download_jobs WHERE game_id IN ('70','71','72','73') ORDER BY game_id").all()).toEqual([{ game_id: '72' }, { game_id: '73' }]);
    expect(() => enqueueWithChildren('72')).toThrow('No missing selected files');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Included products did not finish')), 5000);
      const poll = setInterval(() => {
        if (includedJobs.every(job => (db.query('SELECT state FROM download_jobs WHERE id=?').get(job) as { state: string }).state === 'complete')) {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 10);
    });
    expect(downloaded.filter(file => file.gameId === '72')).toHaveLength(1);
    expect(downloaded.filter(file => file.gameId === '73')).toHaveLength(1);
    expect(gameById('70')?.status).toBe('Vaulted');
    expect(gameById('71')?.status).toBe('Vaulted');
    saveSettings({ concurrency: 1 });
    upsertGame({ id: '80', title: 'Verifying game' });
    upsertGame({ id: '81', title: 'Overlapping transfer' });
    replaceFiles('80', [{ ...original, gameId: '80', key: '80:first' }, { ...original, gameId: '80', key: '80:second' }]);
    replaceFiles('81', [{ ...original, gameId: '81', key: '81:installer' }]);
    const verifyingJob = enqueue('80');
    const overlappingJob = enqueue('81');
    expect(jobsFor('81')[0]?.files).toMatchObject([{ state: 'queued', bytes: 0, size: original.size }]);
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Overlapping queue did not advance');
        await Bun.sleep(10);
      }
    };
    await waitFor(() => overlapStarted);
    expect(jobsFor('80')[0]?.state).toBe('verifying');
    expect(jobsFor('81')[0]?.state).toBe('downloading');
    const firstStart = jobsFor('80')[0]?.startedAt;
    releaseVerification();
    await waitFor(() => jobsFor('80')[0]?.state === 'queued');
    expect(downloaded.filter(file => file.key === '80:second')).toHaveLength(0);
    command(verifyingJob, 'pause');
    await waitFor(() => jobsFor('80')[0]?.state === 'paused');
    command(verifyingJob, 'resume');
    releaseTransfer();
    await waitFor(() => jobsFor('80')[0]?.state === 'complete' && jobsFor('81')[0]?.state === 'complete');
    expect(jobsFor('80')[0]?.startedAt).toBe(firstStart);
    expect(downloaded.filter(file => file.key === '80:first')).toHaveLength(1);
    expect(downloaded.filter(file => file.key === '80:second')).toHaveLength(1);
    expect(jobsFor('81')[0]?.id).toBe(overlappingJob);
    const priorDownloads = downloaded.length;
    upsertGame({ id: '90', title: 'Unresolved deluxe pack', productType: 'bundle' });
    const packRepair = refreshIncompletePacks();
    expect(refreshIncompletePacks()).toBe(packRepair);
    await waitFor(() => packMetadataCalls.includes('90'));
    expect(gameById('90')?.status).not.toBe('Vaulted');
    releasePack();
    await packRepair;
    expect(gameById('90')?.status).toBe('Vaulted');
    expect(gameById('90')?.includedProducts?.map(product => product.id)).toEqual(['72', '73']);
    expect(packMetadataCalls.filter(id => id === '90')).toHaveLength(1);
    upsertGame({ id: '94', title: 'Offline unresolved pack', productType: 'bundle' });
    await refreshIncompletePacks();
    await refreshIncompletePacks();
    expect(packMetadataCalls.filter(id => id === '94')).toHaveLength(1);
    expect(gameById('94')?.inclusionError).toContain('could not be refreshed');
    expect(gameById('94')?.status).not.toBe('Vaulted');
    expect(downloaded).toHaveLength(priorDownloads);
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
    releaseVerification(); releaseTransfer();
    releasePack();
    await shutdownQueue();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});