import type { MediaAsset, MediaRole } from './domain';

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