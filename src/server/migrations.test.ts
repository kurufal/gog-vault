import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, reconcileDlcRecords } from './migrations';

test('initial migration creates schema once and is safe to rerun', () => {
  const database = new Database(':memory:');
  try {
    migrate(database);
    migrate(database);
    expect(database.query('SELECT version FROM migrations').all()).toEqual(Array.from({ length: 17 }, (_, index) => ({ version: index + 1 })));
    expect(database.query("SELECT name FROM sqlite_master WHERE name='download_files'").get()).toEqual({ name: 'download_files' });
    expect(database.query("SELECT name FROM sqlite_master WHERE name='import_files'").get()).toEqual({ name: 'import_files' });
    expect(database.query("SELECT name FROM sqlite_master WHERE name='product_relationships'").get()).toEqual({ name: 'product_relationships' });
  } finally { database.close(); }
});
test('upgrading a disk database backs up legacy records before adding vault scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-migration-'));
  const path = join(directory, 'vault.sqlite');
  const database = new Database(path, { create: true });
  try {
    database.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE games(id TEXT PRIMARY KEY);
      CREATE TABLE download_jobs(id INTEGER PRIMARY KEY);
      CREATE TABLE import_jobs(id TEXT PRIMARY KEY);
      CREATE TABLE unlinked_folders(vault_path TEXT,folder TEXT);
      CREATE TABLE ignored_folders(vault_path TEXT,folder TEXT);`);
    for (let version = 1; version <= 12; version++) database.query('INSERT INTO migrations VALUES (?)').run(version);
    database.query('INSERT INTO games VALUES (?)').run('legacy-owned-game');
    migrate(database, path);
    const backup = readdirSync(directory).find(name => name.includes('pre-vault-scope-migration'));
    expect(backup).toBeDefined();
    const original = new Database(join(directory, backup!), { readonly: true });
    try {
      expect(original.query('SELECT id FROM games').get()).toEqual({ id: 'legacy-owned-game' });
      expect(original.query('SELECT version FROM migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 12 });
    } finally { original.close(); }
    expect(database.query('SELECT version FROM migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 17 });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('schema 13 can gain missing scan columns even if another one already exists', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE games(id TEXT PRIMARY KEY);
      CREATE TABLE vaults(id INTEGER PRIMARY KEY);
      CREATE TABLE unlinked_folders(vault_path TEXT, folder TEXT, vault_id INTEGER);
      CREATE TABLE ignored_folders(vault_path TEXT, folder TEXT);`);
    for (let version = 1; version <= 13; version++) database.query('INSERT INTO migrations VALUES (?)').run(version);
    migrate(database);
    expect((database.query('PRAGMA table_info(ignored_folders)').all() as { name: string }[]).some(column => column.name === 'vault_id')).toBe(true);
    expect(database.query('SELECT MAX(version) AS version FROM migrations').get()).toEqual({ version: 17 });
  } finally { database.close(); }
});
test('upgrading existing DLC relationships permits a second owned parent', () => {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  try {
    migrate(database, undefined, 16);
    database.exec("INSERT INTO games(id,title,first_seen) VALUES ('blasphemous','Blasphemous','now'),('deluxe','Deluxe','now'),('alloy','Alloy of Sin','now');");
    database.exec("INSERT INTO product_relationships(parent_product_id,child_product_id,relationship_type,selected) VALUES ('deluxe','alloy','dlc',1);");
    migrate(database);
    database.exec("INSERT INTO product_relationships(parent_product_id,child_product_id,relationship_type,selected) VALUES ('blasphemous','alloy','dlc',1);");
    expect(database.query('SELECT parent_product_id,selected FROM product_relationships WHERE child_product_id=? ORDER BY parent_product_id').all('alloy'))
      .toEqual([{ parent_product_id: 'blasphemous', selected: 1 }, { parent_product_id: 'deluxe', selected: 1 }]);
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { database.close(); }
});
test('Blades legacy DLC moves logical ownership without moving or duplicating installer bytes', () => {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  try {
    migrate(database, undefined, 14);
    database.exec("INSERT INTO games(id,title,first_seen) VALUES ('1164193173','Blades of Time','now'),('1613811126','Blades of Time - Dismal Swamp DLC','now');");
    const key = '1613811126:installers:installer_windows_en:en1installer0';
    const file = database.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,dlc,selected)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    file.run('1164193173', key, 'Dismal Swamp DLC', 'dlc', 'windows', 'English', '1.0', 273561600, 'https://api.gog.com/child', 'Dismal Swamp DLC', 1);
    file.run('1613811126', key, 'Dismal Swamp DLC', 'main', 'windows', 'English', '1.0', 273561600, 'https://api.gog.com/child', '', 1);
    database.exec("INSERT INTO vaults(id,root_path,normalized_root_path,created_at) VALUES (1,'C:/Vault','c:/vault','now'); INSERT INTO vault_games(vault_id,game_id,folder) VALUES (1,'1164193173','Blades of Time');");
    const filename = 'setup_blades_of_time_-_dismal_swamp_1.0_(39944).exe';
    database.query('INSERT INTO vault_local_files(vault_id,game_id,relative_path,size,mtime_ms,sha256,verified_at) VALUES (1,?,?,?,?,?,?)')
      .run('1164193173', filename, 273561600, 1234, 'a'.repeat(64), 'now');
    database.query('INSERT INTO vault_file_state(vault_id,game_id,file_key,matched,verified,verification_source,verified_size,name) VALUES (1,?,?,1,1,?,?,?)')
      .run('1164193173', key, 'gog-checksum', 273561600, filename);
    migrate(database);
    expect(database.query('SELECT product_type FROM games WHERE id=?').get('1613811126')).toEqual({ product_type: 'dlc' });
    expect(database.query('SELECT parent_product_id,child_product_id,selected FROM product_relationships').all())
      .toEqual([{ parent_product_id: '1164193173', child_product_id: '1613811126', selected: 1 }]);
    expect(database.query('SELECT game_id,category FROM remote_files WHERE key=?').all(key)).toEqual([{ game_id: '1613811126', category: 'main' }]);
    expect(database.query('SELECT game_id,verified FROM vault_file_state WHERE file_key=?').all(key)).toEqual([{ game_id: '1613811126', verified: 1 }]);
    expect(database.query('SELECT storage_game_id,relative_path FROM vault_child_file_locations').all())
      .toEqual([{ storage_game_id: '1164193173', relative_path: filename }]);
    expect(database.query('SELECT game_id,relative_path FROM vault_local_files').all()).toEqual([{ game_id: '1164193173', relative_path: filename }]);
    file.run('1164193173', key, 'Dismal Swamp DLC', 'dlc', 'windows', 'English', '1.0', 273561600, 'https://api.gog.com/child', 'Dismal Swamp DLC', 1);
    const activeJob = database.query("INSERT INTO download_jobs(game_id,state,created_at,updated_at,vault_id) VALUES ('1164193173','error','now','now',1) RETURNING id")
      .get() as { id: number };
    database.query('INSERT INTO download_files(job_id,file_key) VALUES (?,?)').run(activeJob.id, key);
    reconcileDlcRecords(database);
    expect(database.query('SELECT game_id FROM remote_files WHERE game_id=? AND key=?').get('1164193173', key)).toEqual({ game_id: '1164193173' });
    database.query("UPDATE download_jobs SET state='cancelled' WHERE id=?").run(activeJob.id);
    reconcileDlcRecords(database);
    expect(database.query('SELECT game_id FROM remote_files WHERE key=?').all(key)).toEqual([{ game_id: '1613811126' }]);
  } finally { database.close(); }
});