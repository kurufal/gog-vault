import type { Database } from 'bun:sqlite';

const migrations = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT '', release_date TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '[]', languages TEXT NOT NULL DEFAULT '[]', first_seen TEXT NOT NULL, refreshed_at TEXT NOT NULL DEFAULT '', scanned_at TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', local_size INTEGER NOT NULL DEFAULT 0, manifest_hash TEXT NOT NULL DEFAULT '', archived_hash TEXT NOT NULL DEFAULT '');
   CREATE TABLE remote_files (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, platform TEXT NOT NULL, language TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, downlink TEXT NOT NULL, checksum_url TEXT NOT NULL DEFAULT '', dlc TEXT NOT NULL DEFAULT '', selected INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(game_id,key));
   CREATE TABLE download_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL REFERENCES games(id), state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', current_file TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, speed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE download_files (job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE, file_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,file_key));
   CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, message TEXT NOT NULL);
   CREATE INDEX idx_jobs_state ON download_jobs(state);`
];

export function migrate(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (db.query('SELECT version FROM migrations WHERE version=?').get(version)) continue;
    db.transaction(() => {
      db.exec(sql);
      db.query('INSERT INTO migrations(version) VALUES (?)').run(version);
    })();
  }
}