import { z } from 'zod';
import { createHash } from 'node:crypto';
import { type Game, type Platform, type RemoteFile, type Category, type MediaAsset, type MediaRole, type Settings } from '../../shared/domain';
import { gameById, settings } from '../db';
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

export function parseMedia(raw: unknown, gameId: string): MediaAsset[] {
  const product = obj(raw);
  const images = obj(product.images);
  const assets = new Map<string, MediaAsset>();
  const add = (role: MediaRole, source: unknown, poster: unknown = '', external = false, bytes: unknown = 0, video: Partial<MediaAsset> = {}) => {
    const url = image(source);
    if (!url || !external && !trustedGogUrl(url, true)) return;
    const thumbnail = image(poster);
    const key = createHash('sha256').update(`${role}:${url}`).digest('hex').slice(0, 20);
    assets.set(key, { key, gameId, role, url, poster: trustedGogUrl(thumbnail, true) || /^https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\//.test(thumbnail) ? thumbnail : '',
      localPath: '', size: Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Number(bytes) : 0, selected: false, external, ...video });
  };
  add('hero', images.background || images.cover || product.image);
  add('card', images.cover || product.image || images.background || images.sidebarIcon2x || images.icon);
  add('logo', images.logo2x || images.logo);
  add('icon', images.sidebarIcon2x || images.icon || images.sidebarIcon);
  for (const item of array(product.screenshots)) {
    const screenshot = obj(item);
    const formats = array(screenshot.formatted_images).map(obj);
    add('screenshot', formats.find(format => format.formatter_name === 'ggvgl_2x')?.image_url || formats.find(format => format.formatter_name === 'ggvgl')?.image_url || screenshot.url || screenshot.image || screenshot.href || screenshot.full || screenshot.image_url || formats.find(format => format.image_url || format.url)?.image_url || formats.find(format => format.url)?.url, '', false, screenshot.size);
  }
  for (const item of array(product.videos)) {
    const video = obj(item);
    const poster = video.thumbnail || video.thumbnail_url || video.poster || video.image;
    add('videoPoster', poster);
    const direct = image(video.url || video.video_url);
    if (direct && trustedGogUrl(direct, true) && /\.(mp4|webm)(?:[?#]|$)/i.test(direct)) add('video', direct, poster, false, video.size, { provider: 'direct', title: String(video.title || '') });
    else if (String(video.provider).toLowerCase() === 'youtube' && (/^[A-Za-z0-9_-]{11}$/.test(String(video.video_id)) || /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}(?:[?#]|$)/.test(String(video.video_url)))) {
      const id = String(video.video_id || new URL(String(video.video_url)).pathname.split('/')[2]);
      add('video', `https://www.youtube.com/watch?v=${id}`, poster || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, true,
        0, { provider: 'youtube', videoId: id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, title: String(video.title || '') });
    } else if (String(video.provider).toLowerCase() === 'vimeo' && /^https:\/\/(?:player\.)?vimeo\.com\/(?:video\/)?\d+(?:[?#]|$)/.test(String(video.video_url))) {
      const id = new URL(String(video.video_url)).pathname.split('/').filter(Boolean).pop()!;
      add('video', `https://vimeo.com/${id}`, poster, true, 0, { provider: 'vimeo', videoId: id, embedUrl: `https://player.vimeo.com/video/${id}`, title: String(video.title || '') });
    }
  }
  return [...assets.values()];
}

export function parseProduct(raw: unknown): Partial<Game> & { id: string; title: string } {
  const product = record.parse(raw);
  const images = obj(product.images);
  const compatibility = obj(product.content_system_compatibility);
  return { id: String(product.id), title: product.title, slug: String(product.slug || ''),
    cover: image(images.cover) || image(product.image) || image(images.background), background: image(images.background),
    releaseDate: typeof product.release_date === 'string' ? product.release_date : '',
    platforms: (['windows', 'linux', 'osx'] as const).filter(os => compatibility[os]).map(platform),
    languages: Object.values(obj(product.languages)).filter((v): v is string => typeof v === 'string') };
}
export function catalogCover(raw: unknown, id: string): string {
  const match = array(obj(raw).products).map(obj).find(item => String(item.id) === id);
  const url = image(match?.coverHorizontal);
  return trustedGogUrl(url, true) ? url : '';
}
async function productCard(id: string, title: string): Promise<string> {
  try {
    const url = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(title)}&limit=50`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return '';
    return catalogCover(await response.json(), id);
  } catch { return ''; }
}
export function parseDownloads(raw: unknown, gameId: string, dlcName = '', dlcId = '', config: Settings = settings()): RemoteFile[] {
  const downloads = obj(obj(raw).downloads);
  const result: RemoteFile[] = [];
  for (const [section, category] of [['installers', dlcName ? 'dlc' : 'main'], ['patches', 'patches'], ['language_packs', 'languagePacks'], ['bonus_content', 'extras']] as [string, Category][]) {
    for (const group of array(downloads[section])) {
      const language = String(group.language_full || (group.language === 'en' ? 'English' : group.language) || 'Neutral');
      const os = platform(String(group.os || 'windows'));
      for (const [index, part] of array(group.files).entries()) {
        if (typeof part.downlink !== 'string' || !part.downlink.startsWith(`${endpoints.api}/products/`)) continue;
        const key = `${dlcId || gameId}:${section}:${String(group.id || '')}:${String(part.id || index)}`;
        result.push({ key, gameId, name: `${String(group.name || section)}${array(group.files).length > 1 ? ` (Part ${index + 1} of ${group.files.length})` : ''}`,
          category: dlcName && category === 'main' ? 'dlc' : category, platform: os, language,
          version: String(group.version || ''), size: Number(part.size) || 0, downlink: part.downlink,
          dlc: dlcName, selected: (category === 'main' || category === 'dlc' && config.dlc || category === 'extras' && config.extras || category === 'patches' && config.patches || category === 'languagePacks' && config.languagePacks) && config.platforms.includes(os) && (config.languages.some(selected => language.toLowerCase() === selected.toLowerCase()) || language === 'Neutral'), verified: false });
      }
    }
  }
  return result;
}
export async function product(id: string) {
  const raw = await gogRequest<unknown>(`${endpoints.api}/products/${encodeURIComponent(id)}?expand=downloads,expanded_dlcs,description,screenshots,videos,related_products,changelog`);
  if (!obj(raw).downloads || typeof obj(raw).downloads !== 'object') throw new Error(`GOG product ${id} has no download manifest`);
  const info = parseProduct(raw);
  if (info.cover === info.background) {
    const previous = gameById(id);
    info.cover = await productCard(id, info.title) || (previous?.cover !== previous?.background ? previous?.cover : '') || info.background;
  }
  if (!info.cover) info.cover = info.background;
  let files = parseDownloads(raw, id);
  for (const dlc of array(obj(raw).expanded_dlcs)) {
    const dlcId = String(obj(dlc).id || '');
    if (!/^\d+$/.test(dlcId)) continue;
    const detail = obj(dlc).downloads ? dlc : await gogRequest<unknown>(`${endpoints.api}/products/${dlcId}?expand=downloads`);
    files = files.concat(parseDownloads(detail, id, String(obj(dlc).title || dlcId), dlcId));
  }
  return { info, files, media: parseMedia({ ...obj(raw), images: { ...obj(obj(raw).images), cover: info.cover }, image: info.cover }, id) };
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