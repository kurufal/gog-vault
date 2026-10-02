import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

const migrations = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT '', release_date TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '[]', languages TEXT NOT NULL DEFAULT '[]', first_seen TEXT NOT NULL, refreshed_at TEXT NOT NULL DEFAULT '', scanned_at TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', local_size INTEGER NOT NULL DEFAULT 0, manifest_hash TEXT NOT NULL DEFAULT '', archived_hash TEXT NOT NULL DEFAULT '');
   CREATE TABLE remote_files (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, platform TEXT NOT NULL, language TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, downlink TEXT NOT NULL, checksum_url TEXT NOT NULL DEFAULT '', dlc TEXT NOT NULL DEFAULT '', selected INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(game_id,key));
   CREATE TABLE download_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL REFERENCES games(id), state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', current_file TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, speed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE download_files (job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE, file_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,file_key));
   CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, message TEXT NOT NULL);
  CREATE INDEX idx_jobs_state ON download_jobs(state);`,
  `ALTER TABLE games ADD COLUMN archived_selected_hash TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE download_files ADD COLUMN snapshot TEXT NOT NULL DEFAULT '';
   ALTER TABLE download_files ADD COLUMN destination TEXT NOT NULL DEFAULT '';
    ALTER TABLE download_jobs ADD COLUMN desired_hash TEXT NOT NULL DEFAULT '';`,
    `ALTER TABLE remote_files ADD COLUMN matched INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE local_files (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT '', verified_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(game_id, relative_path));`,
    `CREATE TABLE media_assets (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, key TEXT NOT NULL, role TEXT NOT NULL, url TEXT NOT NULL, poster TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0, external INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(game_id,key));`,
    `CREATE TABLE unlinked_folders (vault_path TEXT NOT NULL, folder TEXT NOT NULL, discovered_at TEXT NOT NULL, PRIMARY KEY(vault_path,folder));`,
    `ALTER TABLE media_assets ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE media_assets ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE media_assets ADD COLUMN mime_type TEXT NOT NULL DEFAULT '';`,
      `CREATE TABLE ignored_folders (vault_path TEXT NOT NULL, folder TEXT NOT NULL, ignored_at TEXT NOT NULL, PRIMARY KEY(vault_path,folder));`,
      `ALTER TABLE media_assets ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
       ALTER TABLE media_assets ADD COLUMN provider TEXT NOT NULL DEFAULT '';
       ALTER TABLE media_assets ADD COLUMN video_id TEXT NOT NULL DEFAULT '';
       ALTER TABLE media_assets ADD COLUMN embed_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE media_assets ADD COLUMN title TEXT NOT NULL DEFAULT '';`,
          `ALTER TABLE remote_files ADD COLUMN verification_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE remote_files ADD COLUMN verified_size INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE download_jobs ADD COLUMN error_details TEXT NOT NULL DEFAULT '';`,
      `CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, game_id TEXT NOT NULL REFERENCES games(id), source TEXT NOT NULL,
        signature TEXT NOT NULL, mode TEXT NOT NULL, destination TEXT NOT NULL, staged_path TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        speed REAL NOT NULL DEFAULT 0, current_file TEXT NOT NULL DEFAULT '', files_done INTEGER NOT NULL DEFAULT 0,
        files_total INTEGER NOT NULL DEFAULT 0, error_details TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE import_files (
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'queued',
        PRIMARY KEY(job_id,name)
      );
      CREATE INDEX idx_import_jobs_state ON import_jobs(state);`,
      `ALTER TABLE games ADD COLUMN hidden_from_library INTEGER NOT NULL DEFAULT 0;`,
      `CREATE TABLE vaults (id INTEGER PRIMARY KEY, root_path TEXT NOT NULL, normalized_root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, last_scanned_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'online');
       CREATE TABLE vault_games (vault_id INTEGER NOT NULL REFERENCES vaults(id), game_id TEXT NOT NULL REFERENCES games(id),
        folder TEXT NOT NULL DEFAULT '', local_size INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL DEFAULT '',
        archived_hash TEXT NOT NULL DEFAULT '', archived_selected_hash TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(vault_id,game_id));
       CREATE UNIQUE INDEX idx_vault_folder ON vault_games(vault_id,folder COLLATE NOCASE) WHERE folder!='';
       CREATE TABLE vault_local_files (vault_id INTEGER NOT NULL, game_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT '', verified_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(vault_id,game_id,relative_path), FOREIGN KEY(vault_id,game_id) REFERENCES vault_games(vault_id,game_id));
       CREATE TABLE vault_file_state (vault_id INTEGER NOT NULL, game_id TEXT NOT NULL, file_key TEXT NOT NULL,
        matched INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, verification_source TEXT NOT NULL DEFAULT '',
        verified_size INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', checksum_url TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(vault_id,game_id,file_key), FOREIGN KEY(vault_id,game_id) REFERENCES vault_games(vault_id,game_id));
       CREATE TABLE vault_media (vault_id INTEGER NOT NULL, game_id TEXT NOT NULL, media_key TEXT NOT NULL,
        local_path TEXT NOT NULL, PRIMARY KEY(vault_id,game_id,media_key),
        FOREIGN KEY(vault_id,game_id) REFERENCES vault_games(vault_id,game_id));
       ALTER TABLE download_jobs ADD COLUMN vault_id INTEGER REFERENCES vaults(id);
      ALTER TABLE import_jobs ADD COLUMN vault_id INTEGER REFERENCES vaults(id);`,
          `ALTER TABLE unlinked_folders ADD COLUMN vault_id INTEGER REFERENCES vaults(id);
      ALTER TABLE ignored_folders ADD COLUMN vault_id INTEGER REFERENCES vaults(id);
      CREATE INDEX idx_unlinked_vault ON unlinked_folders(vault_id);
      CREATE INDEX idx_ignored_vault ON ignored_folders(vault_id);`
];

export function migrate(db: Database, databasePath?: string) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
  const upgradingExisting = (db.query('SELECT COUNT(*) AS count FROM migrations').get() as { count: number }).count > 0;
  let backedUp = false;
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (db.query('SELECT version FROM migrations WHERE version=?').get(version)) continue;
    if (version >= 13 && upgradingExisting && !backedUp && databasePath && existsSync(databasePath)) {
      const backupPath = `${databasePath}.pre-vault-scope-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      db.query('VACUUM INTO ?').run(backupPath);
      console.log(JSON.stringify({ event: 'vault_migration_backup', path: backupPath }));
      backedUp = true;
    }
    if (version === 14) {
      db.transaction(() => {
        for (const table of ['unlinked_folders', 'ignored_folders']) {
          const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
          if (!columns.some(column => column.name === 'vault_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN vault_id INTEGER REFERENCES vaults(id)`);
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_unlinked_vault ON unlinked_folders(vault_id); CREATE INDEX IF NOT EXISTS idx_ignored_vault ON ignored_folders(vault_id)');
        db.query('INSERT INTO migrations(version) VALUES (?)').run(version);
      })();
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.query('INSERT INTO migrations(version) VALUES (?)').run(version);
    })();
  }
}