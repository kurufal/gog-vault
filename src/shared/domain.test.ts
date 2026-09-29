import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { completion, desiredFingerprint, manifestFingerprint, normalizeTitle, removeUnresolvedFolder, safeName, statusFor, transition, usedCapacity, type RemoteFile } from './domain';
import { withinRoot } from '../server/paths';
import { scoreFolder } from '../server/matching';
import { playableVideoSource, uniqueMedia } from './media';

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
  test('detects manifest changes using file IDs, sizes and versions', () => {
    expect(manifestFingerprint([file()])).not.toBe(manifestFingerprint([file({ size: 101 })]));
    expect(manifestFingerprint([file()])).not.toBe(manifestFingerprint([file({ key: 'next' })]));
    expect(manifestFingerprint([file()])).toBe(manifestFingerprint([file({ name: 'resolved-filename.exe' })]));
    expect(statusFor([file()], [], true, true)).toBe('Update Available');
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