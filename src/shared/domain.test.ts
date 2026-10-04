import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { bulkDownloadWarningBytes, committedNumber, completion, contentAvailability, desiredFingerprint, isNeutralLanguage, manifestFingerprint, matchesManifestFilters, normalizeTitle, platformStates, previousInstallerSet, reconcileLocalGameState, removeUnresolvedFolder, safeName, scopedDownloadPreview, selectedChildCompletion, statusFor, transition, usedCapacity, visibilityMatches, type RemoteFile } from './domain';
import { withinRoot } from '../server/paths';
import { scoreFolder } from '../server/matching';
import { isLibraryLandscape, playableVideoSource, progressColor, resolveLibraryLandscapeArtwork, uniqueMedia } from './media';

test('numeric settings commit only valid values after allowing an empty draft', () => {
  expect(committedNumber('', 1, 8, 2)).toBe(2);
  expect(committedNumber('4', 1, 8, 2)).toBe(4);
  expect(committedNumber('99', 1, 8, 2)).toBe(8);
  expect(committedNumber('-2', 0, 10, 3)).toBe(0);
  expect(committedNumber('bad', 0, 10, 3)).toBe(3);
  expect(committedNumber('NaN', 0, 10, 3)).toBe(3);
});

test('gallery keeps both roles while deduplicating URLs and downloaded bytes', () => {
  const asset = { key: 'card', gameId: '42', role: 'card' as const, url: 'https://images-1.gog-statics.com/' + 'a'.repeat(64) + '.jpg?size=small', poster: '', localPath: '', size: 0, selected: false, external: false };
  const gallery = uniqueMedia([asset, { ...asset, key: 'hero', role: 'hero', url: asset.url.split('?')[0]! },
    { ...asset, key: 'logo', role: 'logo', url: 'https://images.gog.com/logo.png', sha256: 'same' },
    { ...asset, key: 'icon', role: 'icon', url: 'https://images.gog.com/icon.png', sha256: 'same' },
    { ...asset, key: 'video', role: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }]);
  expect(gallery).toHaveLength(3);
  expect(gallery[0]?.roles).toEqual(['card', 'hero']);
  expect(gallery[1]?.roles).toEqual(['logo', 'icon']);
  expect(gallery.filter(item => item.role !== 'video')).toHaveLength(2);
  expect(playableVideoSource({ ...asset, role: 'video', url: 'https://cdn.gog.com/trailer.mp4' })).toBe('https://cdn.gog.com/trailer.mp4');
  expect(playableVideoSource({ ...asset, role: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk', external: true })).toBeNull();
});

test('matching confidence requires corroboration before auto-linking', () => {
  const game = { id: '42', title: 'Neverwinter Nights Diamond', slug: 'neverwinter-nights-diamond' };
  expect(scoreFolder('Neverwinter Nights Diamond', game, { metadataId: '42' })).toMatchObject({ confidence: 100, autoLink: true });
  expect(scoreFolder('Neverwinter Nights Diamond', game, {})).toMatchObject({ confidence: 76, autoLink: false });
  expect(scoreFolder('Neverwinter Night Diamond', game, {})?.autoLink).toBe(false);
  expect(scoreFolder('Neverwinter Nights Diamond', game, { localFiles: [{ name: 'setup.exe', size: 123 }], expectedFiles: [{ name: 'setup.exe', size: 123 }] }))
    .toMatchObject({ confidence: 96, autoLink: true });
  expect(scoreFolder('Neverwinter Nights Diamond', game, { metadataId: '99' })).toBeNull();
});

const file = (partial: Partial<RemoteFile> = {}): RemoteFile => ({
  key: 'one', gameId: '42', name: 'setup.exe', category: 'main', platform: 'windows', language: 'English',
  version: '1', size: 100, downlink: 'https://api.gog.com/products/42/downlink/installer/one', selected: true, verified: false, ...partial
});
test('manifest language filters retain neutral Extras without bypassing platform filters', () => {
  expect(matchesManifestFilters(file({ category: 'extras', language: 'Neutral' }), ['windows'], ['French'])).toBe(true);
  expect(matchesManifestFilters(file({ category: 'extras', language: 'N/A' }), ['windows'], ['English'])).toBe(true);
  expect(matchesManifestFilters(file({ category: 'extras', language: 'Neutral', platform: 'linux' }), ['windows'], ['English'])).toBe(false);
  expect(matchesManifestFilters(file({ language: 'French' }), ['windows'], ['English'])).toBe(false);
  expect(matchesManifestFilters(file({ language: 'French' }), [], [])).toBe(true);
  expect(isNeutralLanguage('All languages')).toBe(true);
});
describe('vault paths and names', () => {
  test('sanitizes Windows and SMB reserved names', () => {
    expect(safeName('Blade: Runner *?<>|". ')).toBe('Blade Runner');
    expect(safeName('Deus Ex: Human Revolution - Director’s Cut')).toBe('Deus Ex Human Revolution - Director’s Cut');
    expect(safeName('Foo / Bar')).toBe('Foo - Bar');
    expect(safeName('Game:   Subtitle')).toBe('Game Subtitle');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('../')).toBe('Untitled');
  });
  test('matches titles independent of punctuation, accents, and case', () => {
    expect(normalizeTitle('Café: The Game!')).toBe(normalizeTitle('CAFE - the game'));
  });
  test('blocks traversal, sibling prefixes, absolute paths and Windows separators', () => {
    expect(withinRoot('/vault', 'Games/GOG')).toBe(resolve('/vault', 'Games/GOG'));
    for (const input of ['../vault2', '../../etc', '/etc/passwd', 'C:/Windows', '..\\secret']) expect(() => withinRoot('/vault', input)).toThrow();
  });
});
describe('archive state', () => {
  test('calculates weighted verified completion and N/A for unselected categories', () => {
    const files = [file({ verified: true }), file({ key: 'two', size: 300 }), file({ key: 'extra', category: 'extras', selected: false })];
    expect(completion(files, 'main')).toBe(25);
    expect(completion(files, 'extras')).toBeNull();
  });
  test('counts identified installers without claiming checksum verification', () => {
    const identified = file({ matched: true });
    expect(completion([identified], 'main')).toBe(100);
    expect(statusFor([identified], [], false, true)).toBe('Needs Verification');
  });
  test('archives products with only bonus downloads without relaxing installer requirements', () => {
    const extra = file({ category: 'extras', verified: true });
    expect(statusFor([extra], [], false, true)).toBe('Vaulted');
    expect(statusFor([{ ...extra, verified: false, matched: true }], [], false, true)).toBe('Needs Verification');
    expect(statusFor([extra], [], false, false)).toBe('Not Downloaded');
    expect(statusFor([{ ...extra, selected: false }], [], false, true)).toBe('Not Downloaded');
    expect(statusFor([file({ selected: false }), extra], [], false, true)).toBe('Incomplete');
  });
  test('identifies only a complete hashed older multipart set', () => {
    const files = [file(), file({ key: 'part-one' }), file({ key: 'part-two' })];
    const hash = 'a'.repeat(64);
    const local = [
      { name: 'setup_game_1.0_(42).exe', size: 35, sha256: hash, verifiedAt: '2026-10-01' },
      { name: 'setup_game_1.0_(42)-1.bin', size: 55, sha256: hash, verifiedAt: '2026-10-01' },
      { name: 'setup_game_1.0_(42)-2.bin', size: 75, sha256: hash, verifiedAt: '2026-10-01' }
    ];
    expect(previousInstallerSet(files, local)).toBe(3);
    expect(statusFor(files, [], false, true, 3)).toBe('Vaulted');
    expect(statusFor(files, [], true, true, 3)).toBe('Vaulted');
    expect(previousInstallerSet(files, local.slice(0, -1))).toBe(0);
    expect(previousInstallerSet(files, local.map(item => ({ ...item, sha256: '' })))).toBe(0);
    expect(previousInstallerSet(files, local.map(item => ({ ...item, verifiedAt: '' })))).toBe(0);
    expect(previousInstallerSet(files, local.map(item => ({ ...item, name: `Previous Versions/${item.name}` })))).toBe(0);
  });
  test('detects manifest changes using file IDs, sizes and versions', () => {
    expect(manifestFingerprint([file()])).not.toBe(manifestFingerprint([file({ size: 101 })]));
    expect(manifestFingerprint([file()])).not.toBe(manifestFingerprint([file({ key: 'next' })]));
    expect(manifestFingerprint([file()])).toBe(manifestFingerprint([file({ name: 'resolved-filename.exe' })]));
    expect(statusFor([file({ verified: true })], [], true, true)).toBe('Vaulted');
    expect(statusFor([file({ verified: true }), file({ key: 'extra', category: 'extras', verified: false })], [], false, true)).toBe('Incomplete');
    expect(statusFor([file({ verified: true }), file({ key: 'extra', category: 'extras', selected: false })], [], false, true)).toBe('Vaulted');
    expect(statusFor([file({ verified: true }), file({ key: 'dlc', category: 'dlc', verified: false })], [], false, true)).toBe('Incomplete');
    expect(statusFor([file()], [], true, true)).toBe('Not Downloaded');
  });
  test('ignores remote changes to unselected platforms and extras', () => {
    const before = [file({ verified: true }), file({ key: 'linux', platform: 'linux', selected: false }), file({ key: 'extra', category: 'extras', selected: false })];
    const after = [before[0]!, { ...before[1]!, version: '2' }, { ...before[2]!, size: 500 }];
    expect(manifestFingerprint(before)).not.toBe(manifestFingerprint(after));
    expect(desiredFingerprint(before)).toBe(desiredFingerprint(after));
    expect(statusFor(after, [], desiredFingerprint(before) !== desiredFingerprint(after), true)).toBe('Vaulted');
  });
  test('requires main and selected DLC but not optional extras', () => {
    expect(statusFor([file({ verified: true }), file({ key: 'extra', category: 'extras', selected: false })], [], false, true)).toBe('Vaulted');
    expect(statusFor([file({ verified: true }), file({ key: 'dlc', category: 'dlc' })], [], false, true)).toBe('Incomplete');
    expect(statusFor([file({ verified: true }), file({ key: 'extra', category: 'extras', selected: true })], [], false, true)).toBe('Incomplete');
    expect(statusFor([file({ verified: true }), file({ key: 'patch', category: 'other', selected: true })], [], false, true)).toBe('Incomplete');
  });
  test('unavailable GOG Extras remain visible without penalizing a verified base archive', () => {
    const files = [file({ verified: true }), file({ key: 'bonus', category: 'extras', unavailable: true })];
    const failure = { id: 1, gameId: '42', state: 'error' as const, createdAt: '', updatedAt: '', error: 'GOG returned HTTP 404',
      currentFile: '', bytes: 0, total: 0, speed: 0, errorDetails: { stage: 'resolve_downlink', productId: '42', fileId: 'bonus', filename: 'soundtrack', partNumber: null,
        httpStatus: 404, errorCode: '', safeMessage: 'GOG returned HTTP 404', technicalMessage: '', timestamp: '', retryable: true } };
    expect(completion(files, 'extras')).toBeNull();
    expect(statusFor(files, [failure], false, true)).toBe('Vaulted');
    expect(reconcileLocalGameState(1, '42', files, [failure], false, true, 0, 100)).toMatchObject({ overallStatus: 'Vaulted', selectedCompletion: 100, remoteSelectedBytes: 100 });
  });
  test('reconciles one vault-scoped archive state for Main, selected Extras and version uncertainty', () => {
    const main = file({ verified: true, size: 100 });
    const extra = file({ key: 'extra', category: 'extras', size: 50 });
    const incomplete = reconcileLocalGameState(7, 'agony', [main, extra], [], false, true, 0, 100);
    expect(incomplete).toMatchObject({ vaultId: 7, productId: 'agony', main: 100, extras: 0,
      selectedCompletion: 67, availableContentCoverage: 67, verificationState: 'missing', overallStatus: 'Incomplete' });
    const optional = reconcileLocalGameState(7, 'agony', [main, { ...extra, selected: false }], [], false, true, 0, 100);
    expect(optional).toMatchObject({ selectedCompletion: 100, availableContentCoverage: 67, overallStatus: 'Vaulted' });
    const changed = reconcileLocalGameState(7, 'agony', [main], [], true, true, 0, 100);
    expect(changed).toMatchObject({ overallStatus: 'Vaulted', updateState: 'manifest_changed' });
  });
  test('enforces queue transitions', () => {
    expect(transition('downloading', 'paused')).toBe(true);
    expect(transition('paused', 'queued')).toBe(true);
    expect(transition('complete', 'downloading')).toBe(false);
    expect(transition('cancelled', 'queued')).toBe(false);
  });
});
test('capacity math stays exact well beyond 4 TB', () => {
  for (const total of [64, 100, 1024].map(terabytes => terabytes * 1024 ** 4)) {
    expect(usedCapacity(total, 31 * 1024 ** 4)).toBe(total - 31 * 1024 ** 4);
  }
  expect(usedCapacity(null, 100)).toBeNull();
  expect(usedCapacity(100, null)).toBeNull();
  expect(usedCapacity(100, 101)).toBeNull();
});

test('review count drops immediately after linking or ignoring a folder', () => {
  const unresolved = ['Agony', 'MODS', 'Dreamfall Chapters', 'Neverwinter Night Diamond'];
  expect(removeUnresolvedFolder(unresolved, 'Agony')).toHaveLength(3);
  expect(removeUnresolvedFolder(removeUnresolvedFolder(unresolved, 'Agony'), 'MODS')).toHaveLength(2);
  expect(unresolved).toHaveLength(4);
});
test('Library visibility scopes search without changing owned game counts', () => {
  const owned = [{ title: 'Agony', hiddenFromLibrary: true }, { title: 'Doom', hiddenFromLibrary: false }];
  expect(owned).toHaveLength(2);
  expect(owned.filter(game => visibilityMatches(game, 'Visible', ''))).toEqual([owned[1]]);
  expect(owned.filter(game => visibilityMatches(game, 'Hidden', 'ago'))).toEqual([owned[0]]);
  expect(owned.filter(game => visibilityMatches(game, 'Visible', 'ago'))).toEqual([]);
  expect(owned.filter(game => visibilityMatches(game, 'All', 'ago'))).toEqual([owned[0]]);
});
test('platform icons distinguish available, selected and vaulted independently', () => {
  const files = (['windows', 'linux', 'mac'] as const).map((platform, index) => ({
    platform, category: 'main' as const, selected: index !== 2, verified: index === 0
  })) as RemoteFile[];
  expect(platformStates(files, ['windows', 'linux', 'mac'], true)).toEqual({ windows: 'vaulted', linux: 'selected', mac: 'available' });
  expect(platformStates(files, ['windows', 'linux', 'mac'], false)).toEqual({ windows: 'selected', linux: 'selected', mac: 'available' });
  expect(platformStates(files, ['windows', 'linux'], true)).toEqual({ windows: 'vaulted', linux: 'selected' });
  const previous = [file(), file({ key: 'second' })];
  expect(platformStates(previous, ['windows'], true, 2)).toEqual({ windows: 'vaulted' });
});
test('Agony resolves library landscape from its GOG image family instead of a stale hero', () => {
  const hero = 'https://images-1.gog-statics.com/bd52ee1e45c606335611cab8e9bcafe545ca7d0d567fded8e966a391d08dfd79.jpg';
  const logo = 'https://images-1.gog-statics.com/5d2b24aa458b27ee85913f4cfdfd6c3368ff28df6d7f525e38296204eaec98c9_glx_logo_2x.jpg';
  const card = 'https://images.gog-statics.com/5d2b24aa458b27ee85913f4cfdfd6c3368ff28df6d7f525e38296204eaec98c9.png';
  expect(resolveLibraryLandscapeArtwork({ cover: hero, background: hero, logo })).toBe(card);
  expect(resolveLibraryLandscapeArtwork({ cover: card, background: hero, logo })).toBe(card);
  expect(resolveLibraryLandscapeArtwork({ cover: hero, background: hero, logo: '' })).toBe(hero);
  expect(isLibraryLandscape(1600, 740)).toBe(true);
  expect(isLibraryLandscape(2560, 655)).toBe(false);
  expect(isLibraryLandscape(200, 120)).toBe(false);
  expect(progressColor(0)).toBe('#415059');
  expect(progressColor(null)).toBe('#415059');
  expect(progressColor(50)).toBe('rgb(130, 53, 248)');
  expect(progressColor(100)).toBe('rgb(80, 149, 249)');
});

test('bulk download scopes to visible selections and asks above 100 GB', () => {
  const proposals = [{ id: 'visible', bytes: bulkDownloadWarningBytes }, { id: 'update', bytes: 1 }, { id: 'filtered-out', bytes: 50 }];
  const visibleIds = new Set(['visible', 'update']);
  const updates = new Set(['update']);
  expect(scopedDownloadPreview(proposals, visibleIds, updates, false).map(item => item.id)).toEqual(['visible']);
  const withUpdates = scopedDownloadPreview(proposals, visibleIds, updates, true);
  expect(withUpdates.map(item => item.id)).toEqual(['visible', 'update']);
  expect(withUpdates.reduce((bytes, item) => bytes + item.bytes, 0)).toBeGreaterThan(bulkDownloadWarningBytes);
  expect(scopedDownloadPreview(proposals, new Set(['filtered-out']), updates, true).map(item => item.id)).toEqual(['filtered-out']);
});
test('selected owned DLC uses only selected children and distinguishes OFF from N/A', () => {
  const children = [
    { selected: true, files: [file({ gameId: 'A', verified: true })] },
    { selected: true, files: [file({ gameId: 'B' })] },
    { selected: false, files: [file({ gameId: 'C' })] },
    { selected: true, files: [file({ gameId: 'D', verified: true })] }
  ];
  expect(selectedChildCompletion(children)).toBe(67);
  expect(selectedChildCompletion(children.map(child => ({ ...child, selected: false })))).toBeNull();
  expect(selectedChildCompletion([{ selected: true, files: [file({ verified: false })] }])).toBe(0);
  expect(contentAvailability([], 'extras')).toBe('none');
  expect(contentAvailability([file({ category: 'extras', selected: false })], 'extras')).toBe('off');
  expect(contentAvailability([file({ category: 'extras', selected: true })], 'extras')).toBe('selected');
});