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
  let downloaded: RemoteFile | undefined;
  let secondStarted = false;
  mock.module('./storage', () => ({
    folderName: () => 'Game', vaultPath: async () => { await ready; return dir; },
    gameFolder: async () => dir, writeOfflineMetadata: async () => {}
  }));
  mock.module('./transfer', () => ({ downloadFile: async (file: RemoteFile, _folder: string, signal: AbortSignal) => {
    if (file.gameId === '43') await new Promise<void>((_resolve, reject) => {
      secondStarted = true;
      if (signal.aborted) { reject(new Error('Interrupted')); return; }
      signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
    });
    downloaded = file;
    return file.name;
  } }));
  const { db, upsertGame, replaceFiles, saveSettings } = await import('./db');
  const { enqueue, shutdownQueue } = await import('./queue');
  try {
    saveSettings({ vaultPath: dir });
    upsertGame({ id: '42', title: 'Game' });
    const original: RemoteFile = { key: '42:installer', gameId: '42', name: 'installer.exe', category: 'main',
      platform: 'windows', language: 'English', version: '1', size: 12, downlink: 'https://api.gog.com/products/42/v1', selected: true, verified: false };
    replaceFiles('42', [original]);
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
    expect(downloaded?.downlink).toBe(original.downlink);
    expect(downloaded?.version).toBe('1');
    expect(db.query('SELECT verified FROM remote_files WHERE game_id=? AND key=?').get('42', original.key)).toEqual({ verified: 0 });
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