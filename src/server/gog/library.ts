import { activity, db, replaceFiles, replaceMedia, upsertGame } from '../db';
import { endpoints, gogRequest } from './client';
import { product, parseProduct } from './products';

export const refreshState = { running: false, done: 0, total: 0, error: '' };
export async function refreshLibrary() {
  if (refreshState.running) return;
  refreshState.running = true; refreshState.done = 0; refreshState.error = '';
  try {
    const owned = await gogRequest<{ owned?: unknown }>(`${endpoints.embed}/user/data/games`);
    const ids = Array.isArray(owned.owned) ? [...new Set(owned.owned.map(String).filter(id => /^\d+$/.test(id)))] : [];
    refreshState.total = ids.length;
    if (!Array.isArray(owned.owned)) throw new Error('GOG library response missing owned IDs');
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = await gogRequest<unknown>(`${endpoints.api}/products?ids=${ids.slice(offset, offset + 50).join(',')}`);
      for (const raw of Array.isArray(batch) ? batch : []) {
        try { upsertGame(parseProduct(raw)); } catch { console.warn('Skipping invalid GOG product metadata'); }
      }
    }
    for (const id of ids) {
      try {
        const { info, files, media } = await product(id);
        upsertGame(info);
        replaceFiles(id, files);
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