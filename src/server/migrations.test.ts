import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './migrations';

test('initial migration creates schema once and is safe to rerun', () => {
  const database = new Database(':memory:');
  try {
    migrate(database);
    migrate(database);
    expect(database.query('SELECT version FROM migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }]);
    expect(database.query("SELECT name FROM sqlite_master WHERE name='download_files'").get()).toEqual({ name: 'download_files' });
  } finally { database.close(); }
});