import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFile } from '../shared/domain';

test('a queued download uses its saved manifest after refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-snapshot-'));
  process.env.GOG_VAULT_DATA_DIR = dir;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const downloaded: RemoteFile[] = [];
  let secondStarted = false;
  mock.module('./storage', () => ({
    folderName: () => 'Game', vaultPath: async () => { await ready; return dir; },
    gameFolder: async () => dir, writeOfflineMetadata: async () => {}
  }));
  mock.module('./transfer', () => ({ downloadFile: async (file: RemoteFile, _folder: string, signal: AbortSignal, _progress: unknown, _verify: unknown, _resume: unknown, _verified: unknown, onStage?: (stage: string, status: number) => void) => {
    if (file.gameId === '44') { onStage?.('http_response', 416); throw new Error('Download failed at https://cdn.gog.com/file?token=secret'); }
    if (file.gameId === '43') await new Promise<void>((_resolve, reject) => {
      secondStarted = true;
      if (signal.aborted) { reject(new Error('Interrupted')); return; }
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
    downloaded.push(file);
    return file.name;
  } }));
  const { db, upsertGame, replaceFiles, saveSettings } = await import('./db');
  const { enqueue, shutdownQueue } = await import('./queue');
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