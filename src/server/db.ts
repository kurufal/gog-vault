import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaults, completion, manifestFingerprint, statusFor, type Game, type Job, type RemoteFile, type Settings, type JobState } from '../shared/domain';
import { migrate } from './migrations';

export const configDir = process.env.CONFIG_DIR || './config';
export const vaultRoot = process.env.VAULT_ROOT || './vault';
mkdirSync(configDir, { recursive: true });
mkdirSync(vaultRoot, { recursive: true });
export const db = new Database(join(configDir, 'vault.sqlite'), { create: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
migrate(db);

type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export function activity(message: string) {
  db.query('INSERT INTO activity(at,message) VALUES (?,?)').run(now(), message);
}
export function settings(): Settings {
  const rows = db.query('SELECT key,value FROM settings').all() as { key: string; value: string }[];
  return { ...defaults, ...Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)])) };
}
export function saveSettings(input: Partial<Settings>): Settings {
  const write = db.query('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => { for (const [key, value] of Object.entries(input)) if (key in defaults) write.run(key, JSON.stringify(value)); })();
  return settings();
}
export function filesFor(gameId: string): RemoteFile[] {
  return (db.query('SELECT * FROM remote_files WHERE game_id=? ORDER BY category,name').all(gameId) as Row[]).map(row => ({
    key: row.key, gameId: row.game_id, name: row.name, category: row.category, platform: row.platform,
    language: row.language, version: row.version, size: row.size, downlink: row.downlink,
    checksumUrl: row.checksum_url, dlc: row.dlc, selected: !!row.selected, verified: !!row.verified
  }));
}
export function jobsFor(gameId?: string): Job[] {
  const rows = (gameId ? db.query('SELECT * FROM download_jobs WHERE game_id=? ORDER BY id DESC').all(gameId) : db.query('SELECT * FROM download_jobs ORDER BY id DESC').all()) as Row[];
  return rows.map(row => ({ id: row.id, gameId: row.game_id, state: row.state, createdAt: row.created_at,
    updatedAt: row.updated_at, error: row.error, currentFile: row.current_file, bytes: row.bytes, total: row.total, speed: row.speed }));
}
export function gameById(id: string): Game | null {
  const row = db.query('SELECT * FROM games WHERE id=?').get(id) as Row | null;
  if (!row) return null;
  const files = filesFor(id);
  const manifestHash = manifestFingerprint(files);
  return { id, title: row.title, slug: row.slug, cover: row.cover, background: row.background,
    releaseDate: row.release_date, platforms: JSON.parse(row.platforms), languages: JSON.parse(row.languages),
    firstSeen: row.first_seen, refreshedAt: row.refreshed_at, scannedAt: row.scanned_at, folder: row.folder,
    localSize: row.local_size, remoteSize: files.filter(file => file.selected).reduce((n, f) => n + f.size, 0),
    manifestHash: row.manifest_hash, archivedHash: row.archived_hash,
    status: statusFor(files, jobsFor(id), !!row.archived_hash && row.archived_hash !== manifestHash, !!row.folder),
    completion: { main: completion(files, 'main'), dlc: completion(files, 'dlc'), extras: completion(files, 'extras'), other: completion(files, 'other') }
  };
}
export function games(): Game[] {
  return (db.query('SELECT id FROM games ORDER BY title COLLATE NOCASE').all() as { id: string }[]).map(row => gameById(row.id)!);
}
export function upsertGame(input: Partial<Game> & { id: string; title: string }) {
  db.query(`INSERT INTO games(id,title,slug,cover,background,release_date,platforms,languages,first_seen,refreshed_at)
    VALUES ($id,$title,$slug,$cover,$background,$release,$platforms,$languages,$now,$now)
    ON CONFLICT(id) DO UPDATE SET title=$title,slug=$slug,cover=$cover,background=$background,release_date=$release,platforms=$platforms,languages=$languages,refreshed_at=$now`)
    .run({ $id: input.id, $title: input.title, $slug: input.slug || '', $cover: input.cover || '', $background: input.background || '',
      $release: input.releaseDate || '', $platforms: JSON.stringify(input.platforms || []), $languages: JSON.stringify(input.languages || []), $now: now() });
}
export function replaceFiles(gameId: string, files: RemoteFile[]) {
  const old = new Map(filesFor(gameId).map(file => [file.key, file]));
  const insert = db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,checksum_url,dlc,selected,verified)
    VALUES ($game,$key,$name,$category,$platform,$language,$version,$size,$downlink,$checksum,$dlc,$selected,$verified)`);
  db.transaction(() => {
    db.query('DELETE FROM remote_files WHERE game_id=?').run(gameId);
    for (const file of files) insert.run({ $game: gameId, $key: file.key, $name: file.name, $category: file.category, $platform: file.platform,
      $language: file.language, $version: file.version, $size: file.size, $downlink: file.downlink, $checksum: file.checksumUrl || '',
      $dlc: file.dlc || '', $selected: Number(old.get(file.key)?.selected ?? file.selected),
      $verified: Number(old.get(file.key)?.size === file.size && old.get(file.key)?.version === file.version && old.get(file.key)?.verified) });
    db.query('UPDATE games SET manifest_hash=? WHERE id=?').run(manifestFingerprint(files), gameId);
  })();
}
export function changeJob(id: number, state: JobState, error = '') {
  db.query('UPDATE download_jobs SET state=?,error=?,updated_at=? WHERE id=?').run(state, error, now(), id);
}