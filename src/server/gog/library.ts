import { activity, linkDlcProducts, replaceFiles, replaceMedia, saveOwnedProducts, unownedDlcProductIds, upsertGame } from '../db';
import { cancelObsoleteSnapshots } from '../queue';
import { endpoints, gogRequest } from './client';
import { product, parseProduct } from './products';

export const refreshState = { running: false, done: 0, total: 0, error: '' };
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
export function saveProductManifest(id: string, files: Awaited<ReturnType<typeof product>>['files'], childIds: string[]) {
  cancelObsoleteSnapshots(id, new Set(files.map(file => file.key)));
  linkDlcProducts(id, childIds);
  replaceFiles(id, files);
}
export async function refreshLibrary() {
  if (refreshState.running) return;
  refreshState.running = true; refreshState.done = 0; refreshState.error = '';
  try {
    const ownedIds = await refreshOwnedProducts();
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
        const { info, files, media, childIds } = await product(id, ownedIds);
        upsertGame(info);
        saveProductManifest(id, files, childIds);
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