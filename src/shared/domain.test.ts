import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { completion, desiredFingerprint, manifestFingerprint, normalizeTitle, safeName, statusFor, transition, withinRoot, type RemoteFile } from './domain';

const file = (partial: Partial<RemoteFile> = {}): RemoteFile => ({
  key: 'one', gameId: '42', name: 'setup.exe', category: 'main', platform: 'windows', language: 'English',
  version: '1', size: 100, downlink: 'https://api.gog.com/products/42/downlink/installer/one', selected: true, verified: false, ...partial
});
describe('vault paths and names', () => {
  test('sanitizes Windows and SMB reserved names', () => {
    expect(safeName('Blade: Runner *?<>|". ')).toBe('Blade_ Runner ______');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('../')).toBe('.._');
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