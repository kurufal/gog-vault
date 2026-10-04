import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { defaults, completion, contentAvailability, selectedChildCompletion, desiredFingerprint, manifestFingerprint, platformStates, previousInstallerSet, reconcileLocalGameState, statusFor, type Game, type Job, type RemoteFile, type MediaAsset, type Settings, type JobState } from '../shared/domain';
import { resolveLibraryLandscapeArtwork } from '../shared/media';
import { migrate, reconcileDlcRecords } from './migrations';

export const configDir = process.env.GOG_VAULT_DATA_DIR || './config';
mkdirSync(configDir, { recursive: true });
const databasePath = join(configDir, 'vault.sqlite');
export const db = new Database(databasePath, { create: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
migrate(db, databasePath);

type Row = Record<string, any>;
export const now = () => new Date().toISOString();
const normalizedRoot = (path: string) => {
  const root = normalize(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
let currentVaultPath = '';
let currentVault: { id: number; rootPath: string } | null = null;
export function vaultFor(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid vault root');
  const root = normalizedRoot(path);
  if (!db.query('SELECT 1 FROM vaults WHERE normalized_root_path=?').get(root))
    db.query('INSERT OR IGNORE INTO vaults(root_path,normalized_root_path,created_at) VALUES (?,?,?)').run(path, root, now());
  const vault = db.query('SELECT id,root_path AS rootPath FROM vaults WHERE normalized_root_path=?').get(root) as { id: number; rootPath: string };
  db.query('UPDATE unlinked_folders SET vault_id=? WHERE vault_id IS NULL AND vault_path=?').run(vault.id, path);
  db.query('UPDATE ignored_folders SET vault_id=? WHERE vault_id IS NULL AND vault_path=?').run(vault.id, path);
  return vault;
}
export function activeVault() {
  const path = settings().vaultPath;
  if (path !== currentVaultPath) { currentVaultPath = path; currentVault = path ? vaultFor(path) : null; }
  return currentVault;
}
export function localGameRow(gameId: string, vaultId = activeVault()?.id) {
  return vaultId ? db.query('SELECT * FROM vault_games WHERE vault_id=? AND game_id=?').get(vaultId, gameId) as Row | null : null;
}
export function hasIndexedLinkedFile(gameId: string, vaultId = activeVault()?.id) {
  return !!vaultId && !!db.query(`SELECT 1 FROM vault_child_file_locations location JOIN vault_local_files physical
    ON physical.vault_id=location.vault_id AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
    WHERE location.vault_id=? AND location.child_product_id=? LIMIT 1`).get(vaultId, gameId);
}
export function mapVaultGame(gameId: string, folder: string, vaultId = activeVault()?.id) {
  if (!vaultId) throw new Error('Select a vault directory first');
  db.query('INSERT INTO vault_games(vault_id,game_id,folder) VALUES (?,?,?) ON CONFLICT(vault_id,game_id) DO UPDATE SET folder=excluded.folder').run(vaultId, gameId, folder);
}
export function saveFileState(gameId: string, fileKey: string, fields: { matched?: boolean; verified?: boolean; verificationSource?: string; verifiedSize?: number; name?: string; checksumUrl?: string }, vaultId = activeVault()?.id) {
  if (!vaultId) throw new Error('Select a vault directory first');
  mapVaultGame(gameId, localGameRow(gameId, vaultId)?.folder || '', vaultId);
  db.query(`INSERT INTO vault_file_state(vault_id,game_id,file_key,matched,verified,verification_source,verified_size,name,checksum_url)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(vault_id,game_id,file_key) DO UPDATE SET matched=excluded.matched,verified=excluded.verified,
    verification_source=excluded.verification_source,verified_size=excluded.verified_size,name=excluded.name,checksum_url=excluded.checksum_url`)
    .run(vaultId, gameId, fileKey, Number(fields.matched), Number(fields.verified), fields.verificationSource || '', fields.verifiedSize || 0, fields.name || '', fields.checksumUrl || '');
}
export function saveLocalGame(gameId: string, fields: { folder?: string; localSize?: number; scannedAt?: string; archivedHash?: string; archivedSelectedHash?: string }, vaultId = activeVault()?.id) {
  if (!vaultId) throw new Error('Select a vault directory first');
  const old = localGameRow(gameId, vaultId);
  mapVaultGame(gameId, fields.folder ?? old?.folder ?? '', vaultId);
  db.query('UPDATE vault_games SET local_size=?,scanned_at=?,archived_hash=?,archived_selected_hash=? WHERE vault_id=? AND game_id=?')
    .run(fields.localSize ?? old?.local_size ?? 0, fields.scannedAt ?? old?.scanned_at ?? '', fields.archivedHash ?? old?.archived_hash ?? '', fields.archivedSelectedHash ?? old?.archived_selected_hash ?? '', vaultId, gameId);
}
function migrateLegacyLocalState() {
  const vault = activeVault();
  if (!vault) return;
  if (db.query('SELECT 1 FROM vault_games LIMIT 1').get()) return;
  let migrated = 0; let unassigned = 0;
  for (const game of db.query("SELECT * FROM games WHERE folder!=''").all() as Row[]) {
    const metadata = join(vault.rootPath, game.folder, '.gog-vault', 'metadata.json');
    let verified = false;
    if (existsSync(metadata)) try { verified = String(JSON.parse(readFileSync(metadata, 'utf8')).id) === game.id; } catch {}
    if (!verified) { unassigned++; continue; }
    saveLocalGame(game.id, { folder: game.folder, localSize: game.local_size, scannedAt: game.scanned_at,
      archivedHash: game.archived_hash, archivedSelectedHash: game.archived_selected_hash }, vault.id);
    db.query(`INSERT INTO vault_local_files SELECT ?,game_id,relative_path,size,mtime_ms,sha256,verified_at FROM local_files WHERE game_id=?`).run(vault.id, game.id);
    for (const file of db.query('SELECT * FROM remote_files WHERE game_id=?').all(game.id) as Row[])
      saveFileState(game.id, file.key, { matched: !!file.matched, verified: !!file.verified, verificationSource: file.verification_source,
        verifiedSize: file.verified_size, name: file.name, checksumUrl: file.checksum_url }, vault.id);
    for (const media of db.query("SELECT key,local_path FROM media_assets WHERE game_id=? AND local_path!=''").all(game.id) as { key: string; local_path: string }[])
      db.query('INSERT INTO vault_media(vault_id,game_id,media_key,local_path) VALUES (?,?,?,?)').run(vault.id, game.id, media.key, media.local_path);
    migrated++;
  }
  console.log(JSON.stringify({ event: 'vault_legacy_mapping', migrated, unassigned }));
}
function reconcileLinkedArchiveState() {
  const vaultId = activeVault()?.id;
  if (!vaultId) return;
  const parents = db.query('SELECT DISTINCT parent_product_id AS id FROM product_relationships').all() as { id: string }[];
  for (const parent of parents) {
    const children = db.query('SELECT child_product_id AS id FROM product_relationships WHERE parent_product_id=?').all(parent.id) as { id: string }[];
    for (const { id } of [parent, ...children]) {
      const fileList = filesFor(id);
      const saved = localGameRow(id, vaultId);
      if (id === parent.id) db.query('UPDATE games SET manifest_hash=? WHERE id=?').run(manifestFingerprint(fileList), id);
      if (!saved || !fileList.some(file => file.selected) || !fileList.filter(file => file.selected).every(file => file.verified)) continue;
      if (saved.archived_selected_hash !== desiredFingerprint(fileList) && (id === parent.id || !saved.archived_selected_hash))
        saveLocalGame(id, { archivedHash: manifestFingerprint(fileList), archivedSelectedHash: desiredFingerprint(fileList) }, vaultId);
    }
  }
}
export function activity(message: string) {
  db.query('INSERT INTO activity(at,message) VALUES (?,?)').run(now(), message);
}
export function settings(): Settings {
  const rows = db.query('SELECT key,value FROM settings').all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]));
  const config = { ...defaults, ...stored };
  if (!('platforms' in stored)) config.platforms = [config.platform];
  if (!('languages' in stored)) config.languages = [config.language];
  return config;
}
export function saveSettings(input: Partial<Settings>): Settings {
  if (input.vaultPath && input.vaultPath !== settings().vaultPath) {
    if (db.query("SELECT 1 FROM download_jobs WHERE state IN ('queued','downloading','verifying','paused') LIMIT 1").get() ||
      db.query("SELECT 1 FROM import_jobs WHERE state IN ('queued','analyzing','copying','hashing','verifying','finalizing','deleting_source') LIMIT 1").get())
      throw new Error('Finish or cancel active filesystem jobs before switching vaults');
  }
  const write = db.query('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => { for (const [key, value] of Object.entries(input)) if (key in defaults) write.run(key, JSON.stringify(value)); })();
  if (input.vaultPath) { currentVaultPath = ''; activeVault(); }
  return settings();
}
function preferredDlcParent(gameId: string, vaultId: number): { id: string; title: string } | null {
  return db.query(`SELECT parent.id,parent.title FROM product_relationships relation JOIN games parent ON parent.id=relation.parent_product_id
    WHERE relation.child_product_id=? AND relation.relationship_type='dlc'
    ORDER BY EXISTS (SELECT 1 FROM vault_child_file_locations location JOIN vault_local_files physical
      ON physical.vault_id=location.vault_id AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
      WHERE location.vault_id=? AND location.child_product_id=relation.child_product_id AND location.storage_game_id=parent.id) DESC, parent.id LIMIT 1`)
    .get(gameId, vaultId) as { id: string; title: string } | null;
}
export function filesFor(gameId: string): RemoteFile[] {
  const vaultId = activeVault()?.id;
  const parent = preferredDlcParent(gameId, vaultId || -1);
  return (db.query('SELECT * FROM remote_files WHERE game_id=? ORDER BY category,name').all(gameId) as Row[]).map(row => {
    const local = vaultId ? db.query('SELECT * FROM vault_file_state WHERE vault_id=? AND game_id=? AND file_key=?').get(vaultId, gameId, row.key) as Row | null : null;
    const borrowed = vaultId ? db.query(`SELECT physical.size,physical.mtime_ms,physical.verified_at,physical.sha256,storage.folder
      FROM vault_child_file_locations location JOIN vault_local_files physical ON physical.vault_id=location.vault_id
        AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
      JOIN vault_games storage ON storage.vault_id=location.vault_id AND storage.game_id=location.storage_game_id
      WHERE location.vault_id=? AND location.child_product_id=? AND location.file_key=? AND storage.folder!=''`)
      .get(vaultId, gameId, row.key) as Row | null : null;
    const linked = !db.query('SELECT 1 FROM vault_child_file_locations WHERE vault_id=? AND child_product_id=? AND file_key=?').get(vaultId || -1, gameId, row.key) ||
      !!borrowed && (!local?.verified_size || borrowed.size === local.verified_size) && !!borrowed.sha256 && !!borrowed.verified_at;
    return { key: row.key, gameId: row.game_id, name: local?.name || row.name, category: row.category, platform: row.platform,
    language: row.language, version: row.version, size: row.size, downlink: row.downlink,
    checksumUrl: local?.checksum_url || row.checksum_url, dlc: row.dlc, selected: !!row.selected, unavailable: !!row.unavailable,
    provenance: row.provenance && row.provenance !== '{}' ? { ...JSON.parse(row.provenance), ...(parent ? { parentProductId: parent.id } : {}) } : undefined,
    matched: linked && !!local?.matched, verified: linked && !!local?.verified, verificationSource: local?.verification_source || '', verifiedSize: local?.verified_size || 0 };
  });
}
migrateLegacyLocalState();
reconcileDlcRecords(db);
reconcileLinkedArchiveState();
export function jobsFor(gameId?: string): Job[] {
  const vaultId = activeVault()?.id || -1;
  const rows = (gameId ? db.query('SELECT * FROM download_jobs WHERE game_id=? AND vault_id=? ORDER BY id DESC').all(gameId, vaultId) : db.query('SELECT * FROM download_jobs WHERE vault_id=? ORDER BY id DESC').all(vaultId)) as Row[];
  return rows.map(row => ({ id: row.id, gameId: row.game_id, state: row.state, createdAt: row.created_at,
    updatedAt: row.updated_at, error: row.error, currentFile: row.current_file, bytes: row.bytes, total: row.total, speed: row.speed,
    errorDetails: row.error_details ? JSON.parse(row.error_details) : null }));
}
export function gameById(id: string, includeChildren = true): Game | null {
  const row = db.query('SELECT * FROM games WHERE id=?').get(id) as Row | null;
  if (!row || !row.owned) return null;
  const local = localGameRow(id);
  const files = filesFor(id);
  const vaultId = activeVault()?.id || -1;
  const borrowed = db.query(`SELECT COALESCE(SUM(physical.size),0) AS bytes,COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN physical.sha256!='' AND physical.verified_at!='' THEN 1 ELSE 0 END),0) AS verified FROM vault_child_file_locations location
    JOIN vault_local_files physical ON physical.vault_id=location.vault_id AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
    WHERE location.vault_id=? AND location.child_product_id=?`).get(vaultId, id) as { bytes: number; count: number; verified: number };
  const lent = db.query(`SELECT COALESCE(SUM(physical.size),0) AS bytes FROM vault_child_file_locations location
    JOIN vault_local_files physical ON physical.vault_id=location.vault_id AND physical.game_id=location.storage_game_id AND physical.relative_path=location.relative_path
    WHERE location.vault_id=? AND location.storage_game_id=?`).get(vaultId, id) as { bytes: number };
  const changed = !!local?.archived_selected_hash && local.archived_selected_hash !== desiredFingerprint(files);
  const prior = local?.folder && (changed || !files.some(file => file.selected && file.category === 'main' && (file.matched || file.verified)))
    ? previousInstallerSet(files, (db.query('SELECT relative_path AS name,size,sha256,verified_at AS verifiedAt FROM vault_local_files WHERE vault_id=? AND game_id=?').all(activeVault()?.id || -1, id) as { name: string; size: number; sha256: string; verifiedAt: string }[])) : 0;
  const manifestHash = manifestFingerprint(files);
  const archive = reconcileLocalGameState(activeVault()?.id || -1, id, files, jobsFor(id),
    changed, !!local?.folder || borrowed.count > 0, prior, Math.max(0, (local?.local_size || 0) - lent.bytes) + borrowed.bytes);
  if (row.product_type === 'dlc' && changed && local?.archived_hash && local.archived_hash !== manifestFingerprint(files) &&
    local.archived_selected_hash && (local.local_size > 0 || borrowed.verified > 0) &&
    !['Queued', 'Downloading', 'Paused', 'Verifying', 'Error'].includes(archive.overallStatus)) archive.overallStatus = 'Vaulted';
  if (row.product_type === 'dlc' && changed && archive.overallStatus === 'Vaulted') archive.selectedCompletion = 100;
  const parent = preferredDlcParent(id, vaultId);
  const childRows = includeChildren ? db.query(`SELECT child.id,child.title,relation.selected FROM product_relationships relation
    JOIN games child ON child.id=relation.child_product_id WHERE relation.parent_product_id=? AND relation.relationship_type='dlc' ORDER BY child.title COLLATE NOCASE`)
    .all(id) as { id: string; title: string; selected: number }[] : [];
  const productType = row.product_type === 'game' && childRows.length && /(?:^|[_-])bundle$/i.test(row.slug) ? 'bundle' : row.product_type;
  const bonusOnly = files.length > 0 && files.every(file => file.category === 'extras');
  if (bonusOnly) archive.overallStatus = statusFor(files.map(file => ({ ...file, selected: true })), jobsFor(id), changed,
    !!local?.folder || borrowed.count > 0, prior);
  const filelessBundle = productType === 'bundle' && files.length === 0;
  const childStates = childRows.map(child => ({ ...child, game: gameById(child.id, false)!, files: filesFor(child.id) }));
  const bonusFiles = [...files, ...childStates.flatMap(child => child.files)].filter(file => file.category === 'extras' && !file.unavailable);
  const bonusCoverage = !bonusFiles.length ? null : bonusFiles.every(file => file.verified) ? 100
    : Math.min(99, Math.round(100 * bonusFiles.reduce((sum, file) =>
      sum + (file.verified ? Math.max(1, file.size) : 0), 0) / bonusFiles.reduce((sum, file) => sum + Math.max(1, file.size), 0)));
  const selectedChildren = childStates.filter(child => child.selected);
  const childProgress = childStates.map(child => ({ selected: !!child.selected, files: child.files.map(file =>
    child.game.archive?.updateState === 'manifest_changed' && child.game.status === 'Vaulted' && file.category === 'main' && file.selected
      ? { ...file, verified: true } : file) }));
  const childCompletion = selectedChildCompletion(childProgress);
  const legacyDlc = files.filter(file => file.category === 'dlc');
  const selectedChildFiles = childProgress.filter(child => child.selected).flatMap(child => child.files.filter(file =>
    file.selected && !file.unavailable && (filelessBundle || file.category === 'main')));
  const bundleFiles = filelessBundle ? childProgress.flatMap(child => child.files.filter(file =>
    !file.unavailable && (file.category === 'extras' || child.selected && file.selected))) : [];
  const dlcCompletion = filelessBundle ? selectedChildCompletion([{ selected: true, files: selectedChildFiles.map(file => ({ ...file, category: 'main' as const })) }])
    : childCompletion === null ? completion(files, 'dlc') : selectedChildCompletion([
    ...childProgress, { selected: true, files: legacyDlc.map(file => ({ ...file, category: 'main' as const })) }]);
  const selectedFiles = [...files.filter(file => file.selected && !file.unavailable), ...(filelessBundle ? selectedChildFiles
    : selectedChildren.flatMap(child => child.files.filter(file => file.category === 'main' && file.selected)))];
  if (selectedFiles.length) archive.selectedCompletion = Math.round(100 * selectedFiles.reduce((sum, file) =>
    sum + (file.verified || file.matched ? Math.max(1, file.size) : 0), 0) /
    selectedFiles.reduce((sum, file) => sum + Math.max(1, file.size), 0));
  if (selectedChildren.length && (dlcCompletion === null || dlcCompletion < 100) && archive.overallStatus === 'Vaulted') archive.overallStatus = 'Incomplete';
  if (selectedChildren.length && dlcCompletion === 100 && selectedChildren.some(child => child.game.status === 'Needs Verification') && archive.overallStatus === 'Vaulted') archive.overallStatus = 'Needs Verification';
  if (filelessBundle && bundleFiles.length) {
    const activeChild = selectedChildren.find(child => ['Queued', 'Downloading', 'Paused', 'Verifying', 'Error'].includes(child.game.status));
    archive.overallStatus = activeChild?.game.status || (bundleFiles.every(file => file.verified) ? 'Vaulted'
      : bundleFiles.every(file => file.verified || file.matched) ? 'Needs Verification'
      : bundleFiles.some(file => file.verified || file.matched) ? 'Incomplete' : 'Not Downloaded');
    archive.verificationState = bundleFiles.every(file => file.verified) ? 'verified'
      : bundleFiles.some(file => file.verified || file.matched) ? 'identified' : 'missing';
  }
  if (selectedChildren.some(child => child.game.archive?.updateState === 'manifest_changed' || child.game.status === 'Update Available')) archive.updateState = 'manifest_changed';
  archive.dlc = dlcCompletion;
  archive.remoteSelectedBytes += selectedChildFiles.reduce((sum, file) => sum + file.size, 0);
  const availability = { main: contentAvailability(files, 'main'), dlc: childRows.length
    ? selectedChildren.length || legacyDlc.some(file => file.selected) ? 'selected' as const : 'off' as const
    : contentAvailability(files, 'dlc'), extras: contentAvailability(files, 'extras') };
  const logo = (db.query("SELECT url FROM media_assets WHERE game_id=? AND role='logo' LIMIT 1").get(id) as { url: string } | null)?.url || '';
  return { id, title: row.title, slug: row.slug, productType, bonusOnly, bonusCoverage, parentProduct: parent || undefined,
    dlcChildren: childStates.map(child => ({ id: child.id, title: child.title, selected: !!child.selected,
      files: child.files.length, bytes: child.files.reduce((sum, file) => sum + file.size, 0),
      completion: child.game.completion.main, status: child.game.status, cover: child.game.cover, platform: child.game.platforms,
      updateAvailable: child.game.archive?.updateState === 'manifest_changed', pending: child.files.some(file => file.selected && !file.verified && !file.matched && !file.unavailable),
      bonusOnly: !!child.game.bonusOnly })), availability, background: row.background,
    hiddenFromLibrary: !!row.hidden_from_library,
    logo, cover: resolveLibraryLandscapeArtwork({ cover: row.cover, background: row.background, logo }),
    releaseDate: row.release_date, platforms: JSON.parse(row.platforms), languages: JSON.parse(row.languages),
    firstSeen: row.first_seen, refreshedAt: row.refreshed_at, scannedAt: local?.scanned_at || '', folder: local?.folder || '', linkedFiles: borrowed.count > 0,
    folderPath: local?.folder ? join(activeVault()!.rootPath, local.folder) : '',
    localSize: archive.localBytes, remoteSize: archive.remoteSelectedBytes, archive,
    manifestHash: row.manifest_hash, archivedHash: local?.archived_hash || '', platformState: platformStates(files, JSON.parse(row.platforms), !!local?.folder, archive.overallStatus === 'Vaulted' ? prior : 0),
    status: archive.overallStatus, previousInstallerParts: prior,
    completion: { main: changed && archive.overallStatus === 'Vaulted' && row.product_type === 'dlc' ? 100 : completion(files, 'main'),
      dlc: dlcCompletion, extras: completion(files, 'extras'), patches: completion(files, 'patches'), languagePacks: completion(files, 'languagePacks'), other: completion(files, 'other') }
  };
}
export function games(): Game[] {
  return (db.query('SELECT id FROM games WHERE owned=1 ORDER BY title COLLATE NOCASE').all() as { id: string }[]).map(row => gameById(row.id)!);
}
export function setHiddenGames(ids: string[], hidden: boolean) {
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 1000) throw new Error('Select between 1 and 1000 games');
  db.transaction(() => {
    for (const id of unique) {
      if (!db.query('SELECT 1 FROM games WHERE id=?').get(id)) throw new Error('Game not found');
      db.query('UPDATE games SET hidden_from_library=? WHERE id=?').run(Number(hidden), id);
    }
  })();
  return unique.map(id => gameById(id)!);
}
export function upsertGame(input: Partial<Game> & { id: string; title: string }) {
  db.query(`INSERT INTO games(id,title,slug,cover,background,release_date,platforms,languages,first_seen,refreshed_at,product_type)
    VALUES ($id,$title,$slug,$cover,$background,$release,$platforms,$languages,$now,$now,$type)
    ON CONFLICT(id) DO UPDATE SET title=$title,slug=$slug,
      cover=CASE WHEN $cover='' OR ($cover=$background AND games.cover!='' AND games.cover!=games.background) THEN games.cover ELSE $cover END,
      background=CASE WHEN $background='' THEN games.background ELSE $background END,
      release_date=$release,platforms=$platforms,languages=$languages,refreshed_at=$now,
      product_type=CASE WHEN $type='game' AND games.product_type='dlc' THEN games.product_type ELSE $type END`)
    .run({ $id: input.id, $title: input.title, $slug: input.slug || '', $cover: input.cover || '', $background: input.background || '',
      $release: input.releaseDate || '', $platforms: JSON.stringify(input.platforms || []), $languages: JSON.stringify(input.languages || []), $now: now(), $type: input.productType || 'game' });
}
export function unownedDlcProductIds(ownedIds: ReadonlySet<string>): string[] {
  const candidates = db.query(`SELECT id FROM games WHERE product_type='dlc' UNION SELECT child_product_id AS id FROM product_relationships`)
    .all() as { id: string }[];
  return candidates.map(row => row.id).filter(id => !ownedIds.has(id));
}
export function saveOwnedProducts(ownedIds: ReadonlySet<string>) {
  const children = unownedDlcProductIds(ownedIds);
  db.transaction(() => {
    const setOwned = db.query('UPDATE games SET owned=? WHERE id=?');
    for (const row of db.query('SELECT id FROM games').all() as { id: string }[]) setOwned.run(Number(ownedIds.has(row.id)), row.id);
    for (const id of children) db.query('DELETE FROM remote_files WHERE game_id=?').run(id);
    db.query(`DELETE FROM product_relationships WHERE parent_product_id IN (SELECT id FROM games WHERE owned=0)
      OR child_product_id IN (SELECT id FROM games WHERE owned=0)`).run();
  })();
}
export function linkDlcProducts(parentId: string, childIds: string[]) {
  db.transaction(() => {
    for (const childId of new Set(childIds)) {
      if (childId === parentId || !db.query('SELECT 1 FROM games WHERE id=?').get(childId)) continue;
      const previous = db.query("SELECT MAX(selected) AS selected FROM remote_files WHERE game_id=? AND category='dlc' AND key LIKE ?")
        .get(parentId, `${childId}:%`) as { selected: number | null };
      db.query("INSERT OR IGNORE INTO product_relationships(parent_product_id,child_product_id,relationship_type,selected) VALUES (?,?,'dlc',?)")
        .run(parentId, childId, previous.selected ?? Number(settings().dlc));
    }
    reconcileDlcRecords(db);
  })();
}
export function selectDlcProduct(parentId: string, childId: string, selected: boolean) {
  db.transaction(() => {
    const updated = db.query("UPDATE product_relationships SET selected=? WHERE parent_product_id=? AND child_product_id=? AND relationship_type='dlc'")
      .run(Number(selected), parentId, childId);
    if (!updated.changes) throw new Error('DLC relationship not found');
    if (selected && !filesFor(childId).some(file => file.category === 'main' && file.selected)) {
      const config = settings();
      for (const file of filesFor(childId).filter(file => file.category === 'main' && config.platforms.includes(file.platform) &&
        (file.language === 'Neutral' || config.languages.some(language => language.toLowerCase() === file.language.toLowerCase()))))
        db.query('UPDATE remote_files SET selected=1 WHERE game_id=? AND key=?').run(childId, file.key);
    }
  })();
  return gameById(parentId);
}
export function replaceFiles(gameId: string, files: RemoteFile[]) {
  const old = new Map(filesFor(gameId).map(file => [file.key, file]));
  const insert = db.query(`INSERT INTO remote_files(game_id,key,name,category,platform,language,version,size,downlink,checksum_url,dlc,selected,verified,verification_source,verified_size,provenance)
    VALUES ($game,$key,$name,$category,$platform,$language,$version,$size,$downlink,$checksum,$dlc,$selected,$verified,$source,$verifiedSize,$provenance)`);
  db.transaction(() => {
    for (const file of files) {
      const previous = db.query('SELECT version,size FROM remote_files WHERE game_id=? AND key=?').get(gameId, file.key) as { version: string; size: number } | null;
      if (previous && (previous.version !== file.version || previous.size !== file.size))
        db.query('DELETE FROM vault_file_state WHERE game_id=? AND file_key=?').run(gameId, file.key);
    }
    db.query('DELETE FROM remote_files WHERE game_id=?').run(gameId);
    for (const file of files) insert.run({ $game: gameId, $key: file.key, $name: file.name, $category: file.category, $platform: file.platform,
      $language: file.language, $version: file.version, $size: file.size, $downlink: file.downlink, $checksum: file.checksumUrl || '',
      $dlc: file.dlc || '', $selected: Number(old.get(file.key)?.selected ?? file.selected),
      $provenance: JSON.stringify(file.provenance || old.get(file.key)?.provenance || {}),
      $verified: 0,
      $source: old.get(file.key)?.size === file.size && old.get(file.key)?.version === file.version ? old.get(file.key)?.verificationSource || '' : '',
      $verifiedSize: old.get(file.key)?.size === file.size && old.get(file.key)?.version === file.version ? old.get(file.key)?.verifiedSize || 0 : 0 });
    for (const file of files) {
      const previous = old.get(file.key);
      if (previous?.size === file.size && previous.version === file.version) {
        db.query('UPDATE remote_files SET matched=?,name=?,checksum_url=? WHERE game_id=? AND key=?').run(Number(!!previous.matched),
          previous.verified || previous.matched ? previous.name : file.name, previous.checksumUrl || file.checksumUrl || '', gameId, file.key);
      }
    }
    db.query('UPDATE games SET manifest_hash=? WHERE id=?').run(manifestFingerprint(files), gameId);
    if (db.query('SELECT 1 FROM product_relationships WHERE child_product_id=?').get(gameId) ||
      db.query(`SELECT 1 FROM remote_files parent JOIN remote_files child ON child.game_id=substr(parent.key,1,instr(parent.key,':')-1)
        AND child.key=parent.key WHERE parent.game_id=? AND parent.category IN ('dlc','extras','patches','languagePacks')
        AND parent.game_id!=child.game_id LIMIT 1`).get(gameId)) reconcileDlcRecords(db);
  })();
}
export function changeJob(id: number, state: JobState, error = '') {
  db.query('UPDATE download_jobs SET state=?,error=?,updated_at=? WHERE id=?').run(state, error, now(), id);
}
export function mediaFor(gameId: string): MediaAsset[] {
  const vaultId = activeVault()?.id || -1;
  return (db.query('SELECT * FROM media_assets WHERE game_id=? ORDER BY role,key').all(gameId) as Row[]).map(row => ({
    key: row.key, gameId: row.game_id, role: row.role, url: row.url, sourceUrl: row.url, poster: row.poster,
    localPath: (db.query('SELECT local_path FROM vault_media WHERE vault_id=? AND game_id=? AND media_key=?').get(vaultId, gameId, row.key) as { local_path: string } | null)?.local_path || '',
    size: row.size, width: row.width, height: row.height, mimeType: row.mime_type, sha256: row.sha256,
    provider: row.provider, videoId: row.video_id, embedUrl: row.embed_url, title: row.title, selected: !!row.selected, external: !!row.external
  }));
}
export function replaceMedia(gameId: string, media: MediaAsset[]) {
  const previous = new Map(mediaFor(gameId).map(asset => [asset.key, asset]));
  const config = settings();
  const insert = db.query(`INSERT INTO media_assets(game_id,key,role,url,poster,local_path,size,selected,external,width,height,mime_type,sha256,provider,video_id,embed_url,title) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_id,key) DO UPDATE SET poster=excluded.poster,size=CASE WHEN excluded.size > 0 THEN excluded.size ELSE media_assets.size END,provider=excluded.provider,video_id=excluded.video_id,embed_url=excluded.embed_url,title=excluded.title`);
  db.transaction(() => {
    const incoming = new Set(media.map(asset => asset.key));
    const roles = new Set(media.filter(asset => ['card', 'logo', 'hero', 'icon'].includes(asset.role)).map(asset => asset.role));
    for (const old of previous.values()) {
      if (roles.has(old.role) && !incoming.has(old.key) && !old.localPath)
        db.query('DELETE FROM media_assets WHERE game_id=? AND key=?').run(gameId, old.key);
    }
    for (const asset of media) {
      const old = previous.get(asset.key);
      insert.run(gameId, asset.key, asset.role, asset.url, asset.poster, '', asset.size,
        Number(old?.selected ?? (asset.role === 'screenshot' || asset.role === 'additionalArtwork' ? config.storeImages : asset.role === 'video' && !asset.external ? config.storeVideos : false)), Number(asset.external), old?.width || 0, old?.height || 0, old?.mimeType || '', old?.sha256 || '', asset.provider || '', asset.videoId || '', asset.embedUrl || '', asset.title || '');
    }
  })();
}