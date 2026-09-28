import { describe, expect, test } from 'bun:test';
import { parseCode } from './auth';
import { parseDownloads, parseProduct } from './products';

describe('GOG auth callback', () => {
  test('accepts a code or a GOG redirect URL', () => {
    expect(parseCode('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(parseCode('https://embed.gog.com/on_login_success?origin=client&code=abcdefghijklmnop')).toBe('abcdefghijklmnop');
  });
  test('rejects unrelated redirects and malformed codes', () => {
    expect(() => parseCode('https://example.com/on_login_success?code=abcdefghijklmnop')).toThrow();
    expect(() => parseCode('https://embed.gog.com/on_login_success?code=oops')).toThrow();
  });
});
describe('GOG response adapters', () => {
  const response = { id: 42, title: 'Blade Runner', slug: 'blade_runner',
    images: { background: '//images.gog.com/background.jpg', cover: '//images.gog.com/cover.jpg' },
    content_system_compatibility: { windows: true, linux: true, osx: true }, languages: { en: 'English', fr: 'French' },
    downloads: { installers: [
      { id: 'win-en', name: 'Blade Runner', os: 'windows', language_full: 'English', files: [
        { id: 'part1', size: 1024, downlink: 'https://api.gog.com/products/42/downlink/installer/part1' },
        { id: 'part2', size: 4096, downlink: 'https://api.gog.com/products/42/downlink/installer/part2' }] },
      { id: 'linux-fr', name: 'Blade Runner', os: 'linux', language_full: 'French', files: [
        { id: 'linux', size: 2048, downlink: 'https://api.gog.com/products/42/downlink/installer/linux' }] },
      { id: 'mac-en', name: 'Blade Runner', os: 'osx', language_full: 'English', files: [
        { id: 'mac', size: 2048, downlink: 'https://api.gog.com/products/42/downlink/installer/mac' }] }
    ], bonus_content: [{ name: 'Manual', files: [{ id: 9, size: 20, downlink: 'https://api.gog.com/products/42/downlink/product_bonus/9' }] }] } };
  test('validates important product fields without rejecting unknown ones', () => {
    expect(parseProduct({ ...response, unknownNewField: 123 }).platforms).toEqual(['windows', 'linux', 'mac']);
    expect(() => parseProduct({ id: 42 })).toThrow();
  });
  test('preserves all platforms, multipart installers and bonus content', () => {
    const files = parseDownloads(response, '42');
    expect(files).toHaveLength(5);
    expect(files.filter(file => file.category === 'main')).toHaveLength(4);
    expect(files.filter(file => file.selected)).toHaveLength(2);
    expect(files.find(file => file.platform === 'mac')).toBeDefined();
    expect(files.find(file => file.category === 'extras')?.selected).toBe(false);
  });
  test('ignores untrusted download links', () => {
    const malicious = structuredClone(response);
    malicious.downloads.installers[0]!.files[0]!.downlink = 'https://example.com/evil';
    expect(parseDownloads(malicious, '42')).toHaveLength(4);
  });
});