import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFile } from '../shared/domain';

mock.module('./db', () => ({ settings: () => ({ retries: 1, timeout: 10 }) }));
mock.module('./gog/products', () => ({ secureLink: async (file: RemoteFile) => ({
  filename: file.key === 'opaque' ? 'download' : file.category === 'extras' ? file.name : 'installer.exe',
  url: 'https://cdn.gog.com/installer.exe', checksum: file.key === 'no-checksum' || file.key === 'opaque' ? undefined : 'https://cdn.gog.com/hash.xml'
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

test('installer without a GOG checksum fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-no-hash-'));
  const previousFetch = globalThis.fetch;
  try {
    const bytes = 'offline installer';
    globalThis.fetch = Object.assign(async () => new Response(bytes), { preconnect: previousFetch.preconnect });
    expect(downloadFile({ ...file(Buffer.byteLength(bytes)), key: 'no-checksum' }, dir, new AbortController().signal, () => {}))
      .rejects.toThrow('Checksum metadata unavailable');
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

test('installer and Extra with checksums both record official verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-official-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'official soundtrack';
  try {
    globalThis.fetch = Object.assign(async (input: string | URL | Request) =>
      new Response(String(input).includes('hash.xml') ? xml(bytes) : bytes), { preconnect: previousFetch.preconnect });
    for (const entry of [file(Buffer.byteLength(bytes)), { ...file(Buffer.byteLength(bytes)), key: 'music', category: 'extras' as const, name: 'soundtrack.zip' }]) {
      let source = '';
      expect(await downloadFile(entry, dir, new AbortController().signal, () => {}, () => {}, () => {}, info => { source = info.source; }))
        .toBe(entry.category === 'extras' ? 'soundtrack.zip' : 'installer.exe');
      expect(source).toBe('gog-checksum');
    }
    expect(await readFile(join(dir, 'soundtrack.zip'), 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('Extra without checksum verifies expected size and records only local SHA-256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-size-'));
  const previousFetch = globalThis.fetch;
  const bytes = 'offline music';
  try {
    globalThis.fetch = Object.assign(async () => new Response(bytes), { preconnect: previousFetch.preconnect });
    let result: { sha256: string; source: string; size: number; checksumUrl?: string } | undefined;
    const entry = { ...file(Buffer.byteLength(bytes)), key: 'no-checksum', category: 'extras' as const, name: 'track.flac' };
    expect(await downloadFile(entry, dir, new AbortController().signal, () => {}, () => {}, () => {}, info => { result = info; })).toBe('track.flac');
    expect(result).toMatchObject({ size: Buffer.byteLength(bytes), source: 'local-sha256', sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') });
    expect(result?.checksumUrl).toBeUndefined();
    expect(await readFile(join(dir, 'track.flac'), 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('Extra with a missing checksum XML uses size verification but not a transient failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-404-'));
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async (input: string | URL | Request) =>
      String(input).includes('hash.xml') ? new Response(null, { status: 404 }) : new Response('music'), { preconnect: previousFetch.preconnect });
    let source = '';
    expect(await downloadFile({ ...file(5), category: 'extras', name: 'track.mp3' }, dir, new AbortController().signal, () => {}, () => {}, () => {}, info => { source = info.source; })).toBe('track.mp3');
    expect(source).toBe('local-sha256');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('checksum-less Extra uses CDN length when the manifest size is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-stale-size-'));
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async () => new Response('manual', { headers: { 'Content-Length': '6' } }), { preconnect: previousFetch.preconnect });
    let size = 0;
    expect(await downloadFile({ ...file(3), key: 'no-checksum', category: 'extras', name: 'manual.pdf' }, dir,
      new AbortController().signal, () => {}, () => {}, () => {}, info => { size = info.size; })).toBe('manual.pdf');
    expect(size).toBe(6);
    expect(await readFile(join(dir, 'manual.pdf'), 'utf8')).toBe('manual');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('checksum-less Extra can resume an oversized partial after CDN confirms its length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-stale-part-'));
  const previousFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, 'manual.pdf.part'), 'manual');
    globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=6-');
      return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */6' } });
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile({ ...file(3), key: 'no-checksum', category: 'extras', name: 'manual.pdf' }, dir,
      new AbortController().signal, () => {})).toBe('manual.pdf');
    expect(await readFile(join(dir, 'manual.pdf'), 'utf8')).toBe('manual');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('Extra without checksum rejects a size mismatch and preserves an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-mismatch-'));
  const previousFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, 'track.mp3'), 'old song');
    globalThis.fetch = Object.assign(async () => new Response('short'), { preconnect: previousFetch.preconnect });
    await expect(downloadFile({ ...file(10), key: 'no-checksum', category: 'extras', name: 'track.mp3' }, dir, new AbortController().signal, () => {}))
      .rejects.toThrow('Extra size mismatch');
    expect(await readFile(join(dir, 'track.mp3'), 'utf8')).toBe('old song');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('resumes an Extra partial with a CDN range and preserves its music extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-resume-'));
  const previousFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, 'track.flac.part'), 'music ');
    globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=6-');
      return new Response('data', { status: 206, headers: { 'Content-Range': 'bytes 6-9/10' } });
    }, { preconnect: previousFetch.preconnect });
    expect(await downloadFile({ ...file(10), key: 'no-checksum', category: 'extras', name: 'track.flac' }, dir, new AbortController().signal, () => {})).toBe('track.flac');
    expect(await readFile(join(dir, 'track.flac'), 'utf8')).toBe('music data');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('opaque bonus URL takes its actual soundtrack filename from Content-Disposition', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-name-'));
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async () => new Response('music', { headers: {
      'Content-Disposition': "attachment; filename*=UTF-8''Soundtrack%20%28WAV%29.zip", 'Content-Length': '5'
    } }), { preconnect: previousFetch.preconnect });
    expect(await downloadFile({ ...file(0), key: 'opaque', category: 'extras', name: 'soundtrack (WAV)' }, dir, new AbortController().signal, () => {}))
      .toBe('Soundtrack (WAV).zip');
    expect(await readFile(join(dir, 'Soundtrack (WAV).zip'), 'utf8')).toBe('music');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});

test('Extra with no checksum or reliable size cannot complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-bonus-unknown-'));
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async () => new Response('music'), { preconnect: previousFetch.preconnect });
    await expect(downloadFile({ ...file(0), key: 'no-checksum', category: 'extras', name: 'track.mp3' }, dir, new AbortController().signal, () => {}))
      .rejects.toThrow('Extra expected size unavailable');
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});