import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './migrations';

test('initial migration creates schema once and is safe to rerun', () => {
  const database = new Database(':memory:');
  try {
    migrate(database);
    migrate(database);
    expect(database.query('SELECT version FROM migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }]);
    expect(database.query("SELECT name FROM sqlite_master WHERE name='download_files'").get()).toEqual({ name: 'download_files' });
    expect(database.query("SELECT name FROM sqlite_master WHERE name='import_files'").get()).toEqual({ name: 'import_files' });
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
    expect(database.query('SELECT version FROM migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 14 });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('schema 13 can gain missing scan columns even if another one already exists', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE vaults(id INTEGER PRIMARY KEY);
      CREATE TABLE unlinked_folders(vault_path TEXT, folder TEXT, vault_id INTEGER);
      CREATE TABLE ignored_folders(vault_path TEXT, folder TEXT);`);
    for (let version = 1; version <= 13; version++) database.query('INSERT INTO migrations VALUES (?)').run(version);
    migrate(database);
    expect((database.query('PRAGMA table_info(ignored_folders)').all() as { name: string }[]).some(column => column.name === 'vault_id')).toBe(true);
    expect(database.query('SELECT MAX(version) AS version FROM migrations').get()).toEqual({ version: 14 });
  } finally { database.close(); }
});