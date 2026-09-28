import { z } from 'zod';
import { type Game, type Platform, type RemoteFile, type Category } from '../../shared/domain';
import { settings } from '../db';
import { endpoints, gogRequest } from './client';

const record = z.object({ id: z.union([z.string(), z.number()]), title: z.string() }).passthrough();
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const image = (value: unknown) => typeof value === 'string' ? (value.startsWith('//') ? 'https:' + value : value.startsWith('https://') ? value : '') : '';
export function trustedGogUrl(value: string, artwork = false): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (/(^|\.)gog\.com$/.test(url.hostname) || artwork && /(^|\.)gog-statics\.com$/.test(url.hostname));
  } catch { return false; }
}
const platform = (value: string): Platform => value === 'osx' || value === 'mac' ? 'mac' : value === 'linux' ? 'linux' : 'windows';

export function parseProduct(raw: unknown): Partial<Game> & { id: string; title: string } {
  const product = record.parse(raw);
  const images = obj(product.images);
  const compatibility = obj(product.content_system_compatibility);
  return { id: String(product.id), title: product.title, slug: String(product.slug || ''),
    cover: image(images.cover || images.icon || images.logo), background: image(images.background),
    releaseDate: typeof product.release_date === 'string' ? product.release_date : '',
    platforms: (['windows', 'linux', 'osx'] as const).filter(os => compatibility[os]).map(platform),
    languages: Object.values(obj(product.languages)).filter((v): v is string => typeof v === 'string') };
}
export function parseDownloads(raw: unknown, gameId: string, dlcName = '', dlcId = ''): RemoteFile[] {
  const downloads = obj(obj(raw).downloads);
  const config = settings();
  const result: RemoteFile[] = [];
  for (const [section, category] of [['installers', dlcName ? 'dlc' : 'main'], ['patches', 'other'], ['language_packs', 'other'], ['bonus_content', 'extras']] as [string, Category][]) {
    for (const group of array(downloads[section])) {
      const language = String(group.language_full || (group.language === 'en' ? 'English' : group.language) || 'Neutral');
      const os = platform(String(group.os || 'windows'));
      for (const [index, part] of array(group.files).entries()) {
        if (typeof part.downlink !== 'string' || !part.downlink.startsWith(`${endpoints.api}/products/`)) continue;
        const key = `${dlcId || gameId}:${section}:${String(group.id || '')}:${String(part.id || index)}`;
        result.push({ key, gameId, name: `${String(group.name || section)}${array(group.files).length > 1 ? ` (Part ${index + 1} of ${group.files.length})` : ''}`,
          category: dlcName && category === 'main' ? 'dlc' : category, platform: os, language,
          version: String(group.version || ''), size: Number(part.size) || 0, downlink: part.downlink,
          dlc: dlcName, selected: (category === 'main' || category === 'dlc' && config.dlc || category === 'extras' && config.extras) && os === config.platform && (language.toLowerCase() === config.language.toLowerCase() || language === 'Neutral'), verified: false });
      }
    }
  }
  return result;
}
export async function product(id: string) {
  const raw = await gogRequest<unknown>(`${endpoints.api}/products/${encodeURIComponent(id)}?expand=downloads,expanded_dlcs,changelog`);
  if (!obj(raw).downloads || typeof obj(raw).downloads !== 'object') throw new Error(`GOG product ${id} has no download manifest`);
  const info = parseProduct(raw);
  let files = parseDownloads(raw, id);
  for (const dlc of array(obj(raw).expanded_dlcs)) {
    const dlcId = String(obj(dlc).id || '');
    if (!/^\d+$/.test(dlcId)) continue;
    const detail = obj(dlc).downloads ? dlc : await gogRequest<unknown>(`${endpoints.api}/products/${dlcId}?expand=downloads`);
    files = files.concat(parseDownloads(detail, id, String(obj(dlc).title || dlcId), dlcId));
  }
  return { info, files };
}
export async function secureLink(file: RemoteFile): Promise<{ url: string; checksum?: string; filename: string }> {
  const data = await gogRequest<Record<string, unknown>>(file.downlink);
  if (typeof data.downlink !== 'string') throw new Error('Missing secure download link');
  const url = new URL(data.downlink);
  if (!trustedGogUrl(url.href)) throw new Error('Untrusted download host');
  const filename = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (data.checksum && (typeof data.checksum !== 'string' || !trustedGogUrl(data.checksum))) throw new Error('Untrusted checksum URL');
  const checksum = typeof data.checksum === 'string' ? data.checksum : undefined;
  return { url: url.href, checksum, filename };
}