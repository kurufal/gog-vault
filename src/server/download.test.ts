import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFile } from '../shared/domain';

mock.module('./db', () => ({ settings: () => ({ retries: 1, timeout: 10 }) }));
mock.module('./gog/products', () => ({ secureLink: async (file: RemoteFile) => ({
  filename: 'installer.exe', url: 'https://cdn.gog.com/installer.exe', checksum: file.key === 'no-checksum' ? undefined : 'https://cdn.gog.com/hash.xml'
}) }));
const { downloadFile } = await import('./transfer');
const file = (size: number): RemoteFile => ({ key: 'installer', gameId: '42', name: 'installer.exe', category: 'main',
  platform: 'windows', language: 'English', version: '1', size, downlink: 'https://api.gog.com/products/42/downlink/installer/1', selected: true, verified: false });
const xml = (bytes: string) => `<file md5="${new Bun.CryptoHasher('md5').update(bytes).digest('hex')}" total_size="${Buffer.byteLength(bytes)}"/>`;

test('complete partial retries checksum metadata without fetching installer bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-verify-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'offline installer';
  let checks = 0, downloads = 0, verifying = 0;
  try {
    await writeFile(join(dir, 'installer.exe.part'), bytes);
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes('hash.xml')) return ++checks === 1 ? new Response('', { status: 503 }) : new Response(xml(bytes));
      downloads++;
      throw new Error('Complete partial was redownloaded');
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile(file(Buffer.byteLength(bytes)), dir, new AbortController().signal, () => {}, () => verifying++)).toBe('installer.exe');
    expect(checks).toBe(2);
    expect(downloads).toBe(0);
    expect(verifying).toBe(1);
    expect(await readFile(join(dir, 'installer.exe'), 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('HTTP 416 on a complete unknown-size range verifies the existing partial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-range-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'offline installer';
  let requests = 0;
  try {
    await writeFile(join(dir, 'installer.exe.part'), bytes);
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('hash.xml')) return new Response(`<file md5="${new Bun.CryptoHasher('md5').update(bytes).digest('hex')}"/>`);
      requests++;
      expect(new Headers(init?.headers).get('Range')).toBe(`bytes=${Buffer.byteLength(bytes)}-`);
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${Buffer.byteLength(bytes)}` } });
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile(file(0), dir, new AbortController().signal, () => {})).toBe('installer.exe');
    expect(requests).toBe(1);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('same-name replacement retains the previous installer after verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-update-'));
  const previousFetch = globalThis.fetch;
  const oldBytes = 'original installer', newBytes = 'replacement installer';
  try {
    await writeFile(join(dir, 'installer.exe'), oldBytes);
    globalThis.fetch = Object.assign(async (input: string | URL | Request) =>
      new Response(String(input).includes('hash.xml') ? xml(newBytes) : newBytes), { preconnect: previousFetch.preconnect });
    expect(await downloadFile(file(Buffer.byteLength(newBytes)), dir, new AbortController().signal, () => {})).toBe('installer.exe');
    expect(await readFile(join(dir, 'installer.exe'), 'utf8')).toBe(newBytes);
    const archived = await readdir(join(dir, '.gog-vault', 'previous'));
    expect(archived).toHaveLength(1);
    expect(await readFile(join(dir, '.gog-vault', 'previous', archived[0]!), 'utf8')).toBe(oldBytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('existing installer survives a temporary checksum metadata outage without a CDN download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-existing-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'offline installer';
  let checks = 0;
  try {
    await writeFile(join(dir, 'installer.exe'), bytes);
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes('hash.xml')) return ++checks === 1 ? new Response('', { status: 503 }) : new Response(xml(bytes));
      throw new Error('Existing installer was redownloaded');
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile(file(Buffer.byteLength(bytes)), dir, new AbortController().signal, () => {})).toBe('installer.exe');
    expect(checks).toBe(2);
    expect(await readFile(join(dir, 'installer.exe'), 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('missing GOG checksum archives a complete file with expected size and local SHA-256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-no-hash-'));
  const previousFetch = globalThis.fetch;
  try {
    const bytes = 'offline installer';
    globalThis.fetch = Object.assign(async () => new Response(bytes), { preconnect: previousFetch.preconnect });
    let result: { sha256: string; source: string; size: number } | undefined;
    expect(await downloadFile({ ...file(Buffer.byteLength(bytes)), key: 'no-checksum' }, dir, new AbortController().signal, () => {}, () => {}, () => {}, info => { result = info; })).toBe('installer.exe');
    expect(result).toMatchObject({ size: Buffer.byteLength(bytes), source: 'local-sha256', sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') });
    expect(await readFile(join(dir, 'installer.exe'), 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('official checksum size outranks a smaller manifest placeholder for an existing first part', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-beyond-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'x'.repeat(1_517_168);
  try {
    await writeFile(join(dir, 'installer.exe.part'), bytes);
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes('hash.xml')) return new Response(xml(bytes));
      throw new Error('A complete, checksum-matching partial must not be downloaded again');
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile(file(1_048_576), dir, new AbortController().signal, () => {})).toBe('installer.exe');
    expect((await readFile(join(dir, 'installer.exe'))).byteLength).toBe(1_517_168);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});