import type { Game, MediaAsset, MediaRole } from './domain';

export type GalleryAsset = MediaAsset & { roles: MediaRole[] };

export function playableVideoSource(asset: MediaAsset, archivedUrl = ''): string | null {
  if (asset.role !== 'video' || asset.external) return null;
  if (archivedUrl) return archivedUrl;
  return /\.(?:mp4|webm)(?:[?#]|$)/i.test(asset.url) ? asset.url : null;
}

export function mediaIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const hash = /^(?:\/?)([a-f0-9]{64})(?:_[^/]*)?\.(?:jpe?g|png|webp)$/i.exec(parsed.pathname);
    if (/(^|\.)gog-statics\.com$/.test(parsed.hostname) && hash) return `gog:${hash[1]!.toLowerCase()}`;
    return `${parsed.origin.toLowerCase()}${parsed.pathname}`;
  } catch { return url; }
}

export function uniqueMedia(assets: MediaAsset[]): GalleryAsset[] {
  const gallery: GalleryAsset[] = [];
  for (const asset of assets.filter(item => item.role !== 'videoPoster')) {
    const identity = mediaIdentity(asset.sourceUrl || asset.url);
    const existing = gallery.find(item => item.role === 'video' === (asset.role === 'video') &&
      (item.sha256 && asset.sha256 ? item.sha256 === asset.sha256 : mediaIdentity(item.sourceUrl || item.url) === identity));
    if (existing) {
      if (!existing.roles.includes(asset.role)) existing.roles.push(asset.role);
    } else gallery.push({ ...asset, roles: [asset.role] });
  }
  return gallery;
}

export function resolveLibraryLandscapeArtwork(game: Pick<Game, 'cover' | 'background' | 'logo'>): string {
  if (game.cover && game.cover !== game.background) return game.cover;
  const logo = game.logo || '';
  try {
    const url = new URL(logo);
    const family = /^\/([a-f0-9]{64})_glx_logo_2x\.(?:jpg|png)$/i.exec(url.pathname);
    if (url.protocol === 'https:' && /(^|\.)gog-statics\.com$/.test(url.hostname) && family)
      return `https://images.gog-statics.com/${family[1]}.png`;
  } catch {}
  return game.cover || game.background;
}

export function isLibraryLandscape(width: number, height: number): boolean {
  return width >= 400 && height >= 200 && width / height >= 1.35 && width / height <= 2.7;
}

export function progressColor(percent: number | null): string {
  if (percent === null || percent <= 0) return '#415059';
  const stops = [[235, 13, 249], [130, 53, 248], [80, 149, 249]];
  const position = Math.min(100, percent) / 50;
  const start = stops[Math.min(2, Math.floor(position))];
  const end = stops[Math.min(2, Math.floor(position) + 1)];
  const blend = position - Math.floor(position);
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index] - channel) * blend)).join(', ')})`;
}