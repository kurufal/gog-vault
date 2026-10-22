import { accountShelf, activity, db, linkDlcProducts, recordInclusionError, replaceFiles, replaceMedia, saveAccountShelf, saveOwnedProducts, saveProductInclusions, unownedDlcProductIds, upsertGame } from '../db';
import { cancelObsoleteSnapshots } from '../queue';
import { endpoints, gogRequest } from './client';
import { product, parseProduct } from './products';
import { accountInfo } from './auth';
import { accountShelfIds } from './shelf';

export const refreshState = { running: false, done: 0, total: 0, error: '', shelfError: '' };
let packRefresh: Promise<void> | undefined;
const packAttempts = new Map<string, number>();
export function refreshIncompletePacks(): Promise<void> {
  if (refreshState.running) return Promise.resolve();
  if (packRefresh) return packRefresh;
  const candidates = db.query(`SELECT id,inclusions_refreshed_at FROM games WHERE owned=1
    AND (product_type='bundle' OR gog_game_type='pack')
    AND (inclusions_refreshed_at='' OR inclusions_error!='' OR manifest_hash='')
    AND NOT EXISTS (SELECT 1 FROM remote_files WHERE game_id=games.id)`).all() as { id: string; inclusions_refreshed_at: string }[];
  if (!candidates.length) return Promise.resolve();
  packRefresh = (async () => {
    if (!(await accountInfo()).connected) return;
    const ownedIds = new Set((db.query('SELECT id FROM games WHERE owned=1').all() as { id: string }[]).map(game => game.id));
    for (const candidate of candidates) {
      if (refreshState.running) break;
      if (Date.now() - (packAttempts.get(candidate.id) || 0) < 300000) continue;
      packAttempts.set(candidate.id, Date.now());
      try {
        const result = await product(candidate.id, ownedIds);
        const current = db.query('SELECT owned,inclusions_refreshed_at FROM games WHERE id=?').get(candidate.id) as { owned: number; inclusions_refreshed_at: string } | null;
        if (!current?.owned || current.inclusions_refreshed_at !== candidate.inclusions_refreshed_at) continue;
        upsertGame(result.info);
        saveProductManifest(candidate.id, result.files, result.childIds, result.inclusionIds, result.inclusionError);
      } catch {
        recordInclusionError(candidate.id, 'Pack relationships could not be refreshed; retry metadata refresh when GOG is available');
      }
    }
  })().finally(() => { packRefresh = undefined; });
  return packRefresh;
}
export async function cachedAccountShelf() {
  const account = await accountInfo();
  return accountShelf(account.userId);
}
export async function refreshAccountShelf() {
  const account = await accountInfo();
  if (!account.connected || !account.userId) throw new Error('Connect a GOG account first');
  const ids = await accountShelfIds();
  if ((await accountInfo()).userId !== account.userId) throw new Error('GOG account changed during shelf refresh');
  const saved = saveAccountShelf(account.userId, ids);
  refreshState.shelfError = '';
  return saved;
}
export async function ownedProductIds(): Promise<Set<string>> {
  const response = await gogRequest<{ owned?: unknown }>(`${endpoints.embed}/user/data/games`);
  if (!Array.isArray(response.owned)) throw new Error('GOG library response missing owned IDs');
  return new Set(response.owned.map(String).filter(id => /^\d+$/.test(id)));
}
export async function refreshOwnedProducts(): Promise<Set<string>> {
  const ownedIds = await ownedProductIds();
  for (const id of unownedDlcProductIds(ownedIds)) cancelObsoleteSnapshots(id, new Set());
  saveOwnedProducts(ownedIds);
  return ownedIds;
}
export function saveProductManifest(id: string, files: Awaited<ReturnType<typeof product>>['files'], childIds: string[], inclusionIds?: string[], inclusionError = '') {
  cancelObsoleteSnapshots(id, new Set(files.map(file => file.key)));
  linkDlcProducts(id, childIds);
  replaceFiles(id, files);
  if (inclusionIds !== undefined) saveProductInclusions(id, inclusionIds);
  else if (inclusionError) recordInclusionError(id, inclusionError);
}
export async function refreshLibrary() {
  if (refreshState.running) return;
  refreshState.running = true; refreshState.done = 0; refreshState.error = ''; refreshState.shelfError = '';
  try {
    const ownedIds = await refreshOwnedProducts();
    try { await refreshAccountShelf(); }
    catch (error) { refreshState.shelfError = error instanceof Error ? error.message : 'Account shelf refresh failed'; }
    const ids = [...ownedIds];
    refreshState.total = ids.length;
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = await gogRequest<unknown>(`${endpoints.api}/products?ids=${ids.slice(offset, offset + 50).join(',')}`);
      for (const raw of Array.isArray(batch) ? batch : []) {
        try { upsertGame(parseProduct(raw)); } catch { console.warn('Skipping invalid GOG product metadata'); }
      }
    }
    for (const id of ids) {
      try {
        const { info, files, media, childIds, inclusionIds, inclusionError } = await product(id, ownedIds);
        upsertGame(info);
        saveProductManifest(id, files, childIds, inclusionIds, inclusionError);
        replaceMedia(id, media);
      } catch (error) {
        console.warn(`Product ${id}: ${error instanceof Error ? error.message : 'unavailable'}`);
      }
      refreshState.done++;
    }
    activity(`Library refreshed: ${refreshState.done} products`);
  } catch (error) {
    refreshState.error = error instanceof Error ? error.message : 'Library refresh failed';
    activity('Library refresh failed');
  } finally { refreshState.running = false; }
}