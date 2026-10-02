import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCode } from './auth';
import { createCredentialStore } from './credentials';
import { catalogCover, parseDownloads, parseMedia, parseProduct, trustedGogUrl } from './products';
import { defaults } from '../../shared/domain';

describe('GOG auth callback', () => {
  test('accepts a code or a GOG redirect URL', () => {
    expect(parseCode('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(parseCode('https://embed.gog.com/on_login_success?origin=client&code=abcdefghijklmnop')).toBe('abcdefghijklmnop');
  });
  test('rejects unrelated redirects and malformed codes', () => {
    expect(() => parseCode('https://example.com/on_login_success?code=abcdefghijklmnop')).toThrow();
    expect(() => parseCode('https://embed.gog.com/on_login_success?code=oops')).toThrow();
    for (const url of [
      'https://embed.gog.com.evil.example/on_login_success?origin=client&code=abcdefghijklmnop',
      'https://embed.gog.com@evil.example/on_login_success?origin=client&code=abcdefghijklmnop',
      'http://embed.gog.com/on_login_success?origin=client&code=abcdefghijklmnop',
      'https://embed.gog.com:8443/on_login_success?origin=client&code=abcdefghijklmnop',
      'https://embed.gog.com/other?origin=client&code=abcdefghijklmnop',
      'https://embed.gog.com/on_login_success?origin=other&code=abcdefghijklmnop',
      'https://embed.gog.com/on_login_success?origin=client'
    ]) expect(() => parseCode(url)).toThrow();
  });
});
describe('GOG OS credential migration', () => {
  test('removes legacy plaintext only after keyring read-back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gog-credentials-'));
    const path = join(directory, 'account.json');
    const account = { refresh: 'legacy-refresh', username: 'Tester', userId: '42' };
    let saved: string | undefined;
    try {
      await writeFile(path, JSON.stringify(account));
      const store = createCredentialStore({
        getPassword: async () => saved,
        setPassword: async value => { saved = value; },
        deletePassword: async () => { saved = undefined; return true; }
      }, path);
      expect(await store.getGogRefreshToken()).toEqual(account);
      expect(saved as string | undefined).toBe(JSON.stringify(account));
      await expect(readFile(path)).rejects.toHaveProperty('code', 'ENOENT');
      await store.deleteGogRefreshToken();
      expect(await store.getGogRefreshToken()).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('keeps the legacy file if keyring storage cannot be verified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gog-credentials-'));
    const path = join(directory, 'account.json');
    const account = { refresh: 'legacy-refresh', username: 'Tester', userId: '42' };
    try {
      await writeFile(path, JSON.stringify(account));
      const store = createCredentialStore({
        getPassword: async () => undefined,
        setPassword: async () => {},
        deletePassword: async () => true
      }, path);
      await expect(store.getGogRefreshToken()).rejects.toThrow('verify');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(account);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('migrates encrypted legacy credentials with the original key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gog-credentials-'));
    const path = join(directory, 'account.json');
    const account = { refresh: 'encrypted-refresh', username: 'Tester', userId: '42' };
    const previousKey = process.env.GOG_VAULT_SECRET_KEY;
    process.env.GOG_VAULT_SECRET_KEY = 'migration-test-key';
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(process.env.GOG_VAULT_SECRET_KEY));
      const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(account)));
      await writeFile(path, JSON.stringify({ encrypted: true, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') }));
      let saved: string | undefined;
      const store = createCredentialStore({
        getPassword: async () => saved,
        setPassword: async value => { saved = value; },
        deletePassword: async () => { saved = undefined; return true; }
      }, path);
      expect(await store.getGogRefreshToken()).toEqual(account);
      await expect(readFile(path)).rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      if (previousKey === undefined) delete process.env.GOG_VAULT_SECRET_KEY;
      else process.env.GOG_VAULT_SECRET_KEY = previousKey;
      await rm(directory, { recursive: true, force: true });
    }
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
  test('prefers a product card image and never promotes a small icon over the hero', () => {
    const images = { icon: '//images.gog.com/icon.png', logo: '//images.gog.com/logo.png', background: '//images.gog.com/hero.jpg' };
    expect(parseProduct({ ...response, coverHorizontal: 'https://images.gog-statics.com/landscape.jpg', images: { ...images, cover: '//images.gog.com/portrait.jpg' } }).cover)
      .toBe('https://images.gog-statics.com/landscape.jpg');
    expect(parseProduct({ ...response, image: '//images.gog.com/card.jpg', images }).cover).toBe('https://images.gog.com/card.jpg');
    expect(parseProduct({ ...response, image: '//images.gog.com/thumb.jpg', images: { ...images, cover: '//images.gog.com/card.jpg' } }).cover).toBe('https://images.gog.com/card.jpg');
    const fallback = parseProduct({ ...response, images });
    expect(fallback.cover).toBe('https://images.gog.com/hero.jpg');
    expect(fallback.background).toBe('https://images.gog.com/hero.jpg');
  });
  test('discovers distinct official media roles without including untrusted URLs', () => {
    const assets = parseMedia({ image: '//images.gog.com/card.jpg', images: { background: '//images.gog.com/hero.jpg', logo2x: '//images.gog.com/logo.png', icon: '//images.gog.com/icon.png' },
      screenshots: [{ formatted_images: [{ url: '//images.gog.com/screen.jpg' }] }, { url: 'https://evil.example/image.jpg' }],
      videos: [{ provider: 'youtube', video_id: 'abcdefghijk' }, { url: 'https://cdn.gog.com/video.mp4', thumbnail: '//images.gog.com/poster.jpg', size: 123 }] }, '42');
    expect(assets.map(asset => asset.role)).toEqual(['hero', 'card', 'logo', 'icon', 'screenshot', 'video', 'videoPoster', 'video']);
    expect(assets.every(asset => !asset.selected)).toBe(true);
    expect(assets.find(asset => asset.external)?.poster).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  });
  test('selects a catalog card by product ID and keeps large screenshots and YouTube videos separate', () => {
    expect(catalogCover({ products: [{ id: 5, coverHorizontal: 'https://images.gog-statics.com/wrong.png' }, { id: 42, coverHorizontal: 'https://images.gog-statics.com/card.png' }] }, '42')).toBe('https://images.gog-statics.com/card.png');
    const media = parseMedia({ images: { background: '//images.gog.com/hero.jpg', logo2x: '//images.gog.com/logo.jpg' }, image: 'https://images.gog-statics.com/card.png',
      screenshots: [{ formatted_images: [{ formatter_name: 'ggvgt', image_url: 'https://images.gog-statics.com/thumb.jpg' }, { formatter_name: 'ggvgl_2x', image_url: 'https://images.gog-statics.com/full.jpg' }] }],
      videos: [{ provider: 'youtube', video_url: 'https://www.youtube.com/embed/abcdefghijk?rel=0', thumbnail_url: 'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg' }] }, '42');
    expect(media.find(asset => asset.role === 'card')?.url).toBe('https://images.gog-statics.com/card.png');
    expect(media.find(asset => asset.role === 'hero')?.url).toBe('https://images.gog.com/hero.jpg');
    expect(media.find(asset => asset.role === 'logo')?.url).toBe('https://images.gog.com/logo.jpg');
    expect(media.find(asset => asset.role === 'screenshot')?.url).toBe('https://images.gog-statics.com/full.jpg');
    expect(media.find(asset => asset.role === 'video')?.url).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    const resolved = parseMedia({ coverHorizontal: 'https://images.gog-statics.com/full-size.png', images: { cover: 'https://images.gog-statics.com/full-size.png', background: '//images.gog.com/hero.jpg', logo2x: '//images.gog.com/small-logo.png' } }, '42');
    expect(resolved.find(asset => asset.role === 'card')?.url).toBe('https://images.gog-statics.com/full-size.png');
    expect(resolved.find(asset => asset.role === 'logo')?.url).toBe('https://images.gog.com/small-logo.png');
  });
  test('classifies Agony-shaped YouTube entries and direct media without enabling video archives', () => {
    const media = parseMedia({ videos: [
      { provider: 'youtube', video_url: 'https://www.youtube.com/embed/GZ5ZjtNPkiE?wmode=opaque&rel=0', thumbnail_url: 'https://img.youtube.com/vi/GZ5ZjtNPkiE/hqdefault.jpg' },
      { provider: 'youtube', video_url: 'https://www.youtube.com/embed/DEhZBfF-mxI?wmode=opaque&rel=0', thumbnail_url: 'https://img.youtube.com/vi/DEhZBfF-mxI/hqdefault.jpg' },
      { video_url: 'https://cdn.gog.com/trailer.mp4', thumbnail_url: 'https://images.gog.com/poster.jpg' }
    ] }, '42').filter(asset => asset.role === 'video');
    expect(media).toHaveLength(3);
    expect(media.slice(0, 2).map(asset => [asset.provider, asset.videoId, asset.poster, asset.external, asset.selected])).toEqual([
      ['youtube', 'GZ5ZjtNPkiE', 'https://img.youtube.com/vi/GZ5ZjtNPkiE/hqdefault.jpg', true, false],
      ['youtube', 'DEhZBfF-mxI', 'https://img.youtube.com/vi/DEhZBfF-mxI/hqdefault.jpg', true, false]
    ]);
    expect(media[2]).toMatchObject({ provider: 'direct', external: false, selected: false });
  });
  test('preserves all platforms, multipart installers and bonus content', () => {
    const files = parseDownloads(response, '42');
    expect(files).toHaveLength(5);
    expect(files.filter(file => file.category === 'main')).toHaveLength(4);
    expect(files.filter(file => file.selected)).toHaveLength(2);
    expect(files.find(file => file.platform === 'mac')).toBeDefined();
    expect(files.find(file => file.category === 'extras')?.selected).toBe(false);
  });
  test('unowned expanded DLC stays available but is not selected for download', () => {
    const soundtrack = { downloads: { bonus_content: [{ id: '90287', name: 'soundtrack (WAV)', os: 'windows', files: [
      { id: '90287', size: 912261120, downlink: 'https://api.gog.com/products/1438925691/downlink/product_bonus/90287' }
    ] }] } };
    const config = { ...defaults, extras: true };
    expect(parseDownloads(soundtrack, '2028023186', 'Agony Soundtrack', '1438925691', config, false)).toMatchObject([
      { gameId: '2028023186', category: 'extras', selected: false }
    ]);
    expect(parseDownloads(soundtrack, '2028023186', 'Agony Soundtrack', '1438925691', config, true)[0]?.selected).toBe(true);
  });
  test('selects the intersection of multiple systems, English, and enabled categories', () => {
    const config = { ...defaults, platforms: ['windows', 'linux'] as (typeof defaults.platforms), languages: ['English'], extras: false };
    const files = parseDownloads(response, '42', '', '', config);
    expect(files.filter(file => file.selected).map(file => file.platform)).toEqual(['windows', 'windows']);
    const englishLinux = structuredClone(response);
    englishLinux.downloads.installers[1]!.language_full = 'English';
    const selected = parseDownloads(englishLinux, '42', '', '', config).filter(file => file.selected);
    expect(selected.map(file => file.platform)).toEqual(['windows', 'windows', 'linux']);
    expect(selected.some(file => file.platform === 'mac' || file.category === 'extras')).toBe(false);
  });
  test('ignores untrusted download links', () => {
    const malicious = structuredClone(response);
    malicious.downloads.installers[0]!.files[0]!.downlink = 'https://example.com/evil';
    expect(parseDownloads(malicious, '42')).toHaveLength(4);
  });
  test('trusts only HTTPS GOG hosts without URL userinfo', () => {
    expect(trustedGogUrl('https://cdn.gog.com/installer.xml')).toBe(true);
    expect(trustedGogUrl('https://images.gog-statics.com/cover.jpg', true)).toBe(true);
    expect(trustedGogUrl('https://cdn.gog.com@evil.example/installer.xml')).toBe(false);
    expect(trustedGogUrl('https://cdn.gog.com.evil.example/installer.xml')).toBe(false);
    expect(trustedGogUrl('http://cdn.gog.com/installer.xml')).toBe(false);
    expect(trustedGogUrl('https://images.gog-statics.com/cover.jpg')).toBe(false);
  });
});