export type Category = 'main' | 'dlc' | 'extras' | 'patches' | 'languagePacks' | 'other';
export type ProductType = 'game' | 'dlc' | 'bundle' | 'standalone_expansion' | 'bonus_content';
export type Platform = 'windows' | 'linux' | 'mac';
export type JobState = 'queued' | 'downloading' | 'paused' | 'verifying' | 'complete' | 'error' | 'cancelled';
export type VaultStatus = 'Not Downloaded' | 'Queued' | 'Downloading' | 'Paused' | 'Verifying' | 'Vaulted' | 'Update Available' | 'Needs Verification' | 'Incomplete' | 'Error';
export interface RemoteFile {
  key: string; gameId: string; name: string; category: Category; platform: Platform;
  language: string; version: string; size: number; downlink: string; checksumUrl?: string;
  dlc?: string; selected: boolean; verified: boolean; matched?: boolean;
  verificationSource?: 'gog-checksum' | 'local-sha256' | 'import-identified' | ''; verifiedSize?: number;
}
export interface DownloadFailure {
  stage: string; productId: string; fileId: string; filename: string; partNumber: number | null;
  httpStatus: number | null; errorCode: string; safeMessage: string; technicalMessage: string;
  timestamp: string; retryable: boolean;
}
export interface Game {
  id: string; title: string; slug: string; cover: string; background: string; logo?: string;
  productType?: ProductType;
  parentProduct?: { id: string; title: string };
  dlcChildren?: { id: string; title: string; selected: boolean; files: number; bytes: number; completion: number | null;
    status: VaultStatus; cover: string; platform: Platform[]; updateAvailable: boolean }[];
  availability?: Partial<Record<Category, 'none' | 'off' | 'selected'>>;
  folderPath?: string;
  linkedFiles?: boolean;
  hiddenFromLibrary?: boolean;
  releaseDate: string; platforms: Platform[]; languages: string[]; firstSeen: string;
  refreshedAt: string; scannedAt: string; folder: string; localSize: number;
  remoteSize: number; status: VaultStatus; manifestHash: string; archivedHash: string;
  platformState?: Partial<Record<Platform, 'available' | 'selected' | 'vaulted'>>;
  completion: Record<Category, number | null>;
  archive?: LocalGameState;
  previousInstallerParts?: number;
}
export interface LocalGameState {
  vaultId: number; productId: string; main: number | null; dlc: number | null; extras: number | null;
  selectedCompletion: number | null; availableContentCoverage: number | null;
  verificationState: 'verified' | 'identified' | 'missing';
  updateState: 'manifest_changed' | 'unknown' | 'unchanged'; overallStatus: VaultStatus;
  localBytes: number; remoteSelectedBytes: number;
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
export function committedNumber(draft: string, minimum: number, maximum: number, fallback: number) {
  if (!draft.trim()) return fallback;
  const parsed = Number(draft);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}
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
export function statusFor(files: RemoteFile[], jobs: Job[], changed: boolean, hasFolder: boolean, previousInstallerParts = 0): VaultStatus {
  const active = jobs.find(job => ['queued', 'downloading', 'paused', 'verifying'].includes(job.state));
  if (active) return ({ queued: 'Queued', downloading: 'Downloading', paused: 'Paused', verifying: 'Verifying' } as const)[active.state as 'queued'];
  if (jobs[0]?.state === 'error') return 'Error';
  const main = completion(files, 'main');
  const selected = files.filter(file => file.selected);
  if (!hasFolder || !selected.some(file => file.verified || file.matched) && !previousInstallerParts) return 'Not Downloaded';
  if (previousInstallerParts && !selected.some(file => file.category === 'main' && file.verified)) {
    const other = selected.filter(file => file.category !== 'main');
    if (other.every(file => file.verified)) return 'Vaulted';
    return other.every(file => file.verified || file.matched) ? 'Needs Verification' : 'Incomplete';
  }
  if (selected.some(file => !file.verified && !file.matched)) return 'Incomplete';
  if (main === 100 && selected.length && selected.every(file => file.verified)) return 'Vaulted';
  if (main === 100 && selected.length && selected.every(file => file.verified || file.matched)) return 'Needs Verification';
  return 'Incomplete';
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
export function visibilityMatches(game: Pick<Game, 'title' | 'hiddenFromLibrary'>, visibility: 'Visible' | 'Hidden' | 'All', search: string) {
  return (visibility === 'All' || !!game.hiddenFromLibrary === (visibility === 'Hidden')) &&
    game.title.toLowerCase().includes(search.toLowerCase());
}
export const bulkDownloadWarningBytes = 100 * 1024 ** 3;
export function scopedDownloadPreview<T extends { id: string; bytes: number }>(items: readonly T[], visibleSelectedIds: ReadonlySet<string>, updateIds: ReadonlySet<string>, includeUpdates: boolean): T[] {
  return items.filter(item => visibleSelectedIds.has(item.id) && (includeUpdates || !updateIds.has(item.id)));
}
export function platformStates(files: RemoteFile[], platforms: Platform[], hasFolder: boolean, previousInstallerParts = 0): Game['platformState'] {
  return Object.fromEntries(platforms.flatMap(platform => {
    const available = files.filter(file => file.platform === platform && file.category === 'main');
    if (!available.length) return [];
    const selected = available.filter(file => file.selected);
    return [[platform, !selected.length ? 'available' : hasFolder && (selected.every(file => file.verified) ||
      previousInstallerParts > 0 && selected.length === previousInstallerParts && selected.every(file => file.category === 'main') && !selected.some(file => file.verified)) ? 'vaulted' : 'selected']];
  })) as Game['platformState'];
}
export function previousInstallerSet(files: RemoteFile[], local: { name: string; size: number; sha256: string; verifiedAt?: string }[]): number {
  const main = files.filter(file => file.selected && file.category === 'main');
  if (main.length < 2 || main.some(file => file.verified)) return 0;
  const installers = local.filter(file => file.verifiedAt && /^[a-f0-9]{64}$/i.test(file.sha256) && !file.name.includes('/') && /\.(exe|bin)$/i.test(file.name));
  if (installers.length !== main.length) return 0;
  const executable = installers.filter(file => /^setup_.+\.exe$/i.test(file.name));
  if (executable.length !== 1) return 0;
  const stem = executable[0]!.name.slice(0, -4);
  const parts = installers.filter(file => file.name.startsWith(`${stem}-`) && /-\d+\.bin$/i.test(file.name))
    .map(file => Number(file.name.slice(stem.length + 1, -4)));
  return parts.length === main.length - 1 && parts.sort((a, b) => a - b).every((part, index) => part === index + 1) ? main.length : 0;
}
export function reconcileLocalGameState(vaultId: number, productId: string, files: RemoteFile[], jobs: Job[],
  changed: boolean, hasFolder: boolean, previousInstallerParts: number, localBytes: number): LocalGameState {
  const selected = files.filter(file => file.selected);
  const progress = (entries: RemoteFile[]) => entries.length ? Math.round(100 * entries.reduce((sum, file) =>
    sum + (file.verified || file.matched ? Math.max(1, file.size) : 0), 0) /
    entries.reduce((sum, file) => sum + Math.max(1, file.size), 0)) : null;
  const verified = selected.length > 0 && selected.every(file => file.verified) ||
    previousInstallerParts > 0 && selected.filter(file => file.category !== 'main').every(file => file.verified);
  return { vaultId, productId, main: completion(files, 'main'), dlc: completion(files, 'dlc'), extras: completion(files, 'extras'),
    selectedCompletion: progress(selected), availableContentCoverage: progress(files),
    verificationState: verified ? 'verified' : selected.some(file => file.matched) ? 'identified' : 'missing',
    updateState: changed ? 'manifest_changed' : previousInstallerParts ? 'unknown' : 'unchanged',
    overallStatus: statusFor(files, jobs, changed, hasFolder, previousInstallerParts), localBytes,
    remoteSelectedBytes: selected.reduce((sum, file) => sum + file.size, 0) };
}
export function contentAvailability(files: RemoteFile[], category: Category): 'none' | 'off' | 'selected' {
  const available = files.filter(file => file.category === category);
  return !available.length ? 'none' : available.some(file => file.selected) ? 'selected' : 'off';
}
export function selectedChildCompletion(children: { selected: boolean; files: RemoteFile[] }[]): number | null {
  const selected = children.filter(child => child.selected).flatMap(child => child.files.filter(file => file.category === 'main' && file.selected));
  if (!selected.length) return null;
  const total = selected.reduce((sum, file) => sum + Math.max(1, file.size), 0);
  return Math.round(100 * selected.reduce((sum, file) => sum + (file.verified || file.matched ? Math.max(1, file.size) : 0), 0) / total);
}