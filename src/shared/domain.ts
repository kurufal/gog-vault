export type Category = 'main' | 'dlc' | 'extras' | 'patches' | 'languagePacks' | 'other';
export type Platform = 'windows' | 'linux' | 'mac';
export type JobState = 'queued' | 'downloading' | 'paused' | 'verifying' | 'complete' | 'error' | 'cancelled';
export type VaultStatus = 'Not Downloaded' | 'Queued' | 'Downloading' | 'Paused' | 'Verifying' | 'Vaulted' | 'Update Available' | 'Needs Verification' | 'Incomplete' | 'Error';
export interface RemoteFile {
  key: string; gameId: string; name: string; category: Category; platform: Platform;
  language: string; version: string; size: number; downlink: string; checksumUrl?: string;
  dlc?: string; selected: boolean; verified: boolean; matched?: boolean;
  verificationSource?: 'gog-checksum' | 'local-sha256' | ''; verifiedSize?: number;
}
export interface DownloadFailure {
  stage: string; productId: string; fileId: string; filename: string; partNumber: number | null;
  httpStatus: number | null; errorCode: string; safeMessage: string; technicalMessage: string;
  timestamp: string; retryable: boolean;
}
export interface Game {
  id: string; title: string; slug: string; cover: string; background: string; logo?: string;
  releaseDate: string; platforms: Platform[]; languages: string[]; firstSeen: string;
  refreshedAt: string; scannedAt: string; folder: string; localSize: number;
  remoteSize: number; status: VaultStatus; manifestHash: string; archivedHash: string;
  completion: Record<Category, number | null>;
}
export interface Job {
  id: number; gameId: string; state: JobState; createdAt: string; updatedAt: string;
  error: string; currentFile: string; bytes: number; total: number; speed: number;
  errorDetails?: DownloadFailure | null;
}
export const defaults = {
  vaultPath: '', concurrency: 2, platform: 'windows' as Platform, language: 'English',
  platforms: ['windows'] as Platform[], languages: ['English'], dlc: true, extras: false, patches: false, languagePacks: false,
  storeImages: false, storeVideos: false, autoRefresh: false, autoScan: false, retries: 3, timeout: 60, view: 'tiles', reducedMotion: false
};
export type Settings = typeof defaults;

export function usedCapacity(total: number | null, free: number | null): number | null {
  if (total === null || free === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(free) || free < 0 || free > total) return null;
  return total - free;
}

export function safeName(value: string): string {
  const name = value.replace(/^[\\/]+|[\\/]+$/g, '').replace(/\s*[/\\]\s*/g, ' - ').replace(/[:<>"|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  const clean = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
  return clean.slice(0, 180) || 'Untitled';
}
export function normalizeTitle(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function completion(files: RemoteFile[], category: Category): number | null {
  const selected = files.filter(file => file.category === category && file.selected);
  if (!selected.length) return null;
  const total = selected.reduce((sum, file) => sum + Math.max(1, file.size), 0);
  return Math.round(100 * selected.reduce((sum, file) => sum + (file.verified || file.matched ? Math.max(1, file.size) : 0), 0) / total);
}
export function manifestFingerprint(files: RemoteFile[]): string {
  const entries = files.map(({ key, size, version, category, platform, language }) =>
    [key, size, version, category, platform, language].join('|')).sort().join('\n');
  return new Bun.CryptoHasher('sha256').update(entries).digest('hex');
}
export function desiredFingerprint(files: RemoteFile[]): string {
  return manifestFingerprint(files.filter(file => file.selected));
}
export function statusFor(files: RemoteFile[], jobs: Job[], changed: boolean, hasFolder: boolean): VaultStatus {
  const active = jobs.find(job => ['queued', 'downloading', 'paused', 'verifying'].includes(job.state));
  if (active) return ({ queued: 'Queued', downloading: 'Downloading', paused: 'Paused', verifying: 'Verifying' } as const)[active.state as 'queued'];
  if (jobs[0]?.state === 'error') return 'Error';
  const main = completion(files, 'main');
  const selected = files.filter(file => file.selected);
  if (changed && hasFolder) return 'Update Available';
  if (main === 100 && selected.every(file => file.verified)) return 'Vaulted';
  if (main === 100 && selected.every(file => file.verified || file.matched)) return 'Needs Verification';
  if (hasFolder || files.some(file => file.verified)) return 'Incomplete';
  return 'Not Downloaded';
}
export function transition(from: JobState, to: JobState): boolean {
  const allowed: Record<JobState, JobState[]> = {
    queued: ['downloading', 'paused', 'cancelled', 'error'],
    downloading: ['paused', 'verifying', 'error', 'cancelled'],
    verifying: ['downloading', 'complete', 'error', 'cancelled'],
    paused: ['queued', 'cancelled'], error: ['queued', 'cancelled'],
    complete: [], cancelled: []
  };
  return allowed[from].includes(to);
}
export type MediaRole = 'hero' | 'card' | 'logo' | 'icon' | 'videoPoster' | 'screenshot' | 'additionalArtwork' | 'video';
export interface MediaAsset {
  key: string; gameId: string; role: MediaRole; url: string; poster: string;
  sourceUrl?: string; localPath: string; size: number; selected: boolean; external: boolean;
  width?: number; height?: number; mimeType?: string;
  sha256?: string; provider?: string; videoId?: string; embedUrl?: string; title?: string;
}

export function removeUnresolvedFolder(folders: string[], folder: string): string[] {
  return folders.filter(item => item !== folder);
}