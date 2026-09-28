import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyFile } from './transfer';

test('verifies checksum XML against local bytes and rejects unavailable checksum data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gog-vault-test-'));
  const path = join(dir, 'installer.bin');
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(path, 'offline installer');
    const hash = new Bun.CryptoHasher('md5').update('offline installer').digest('hex');
    globalThis.fetch = Object.assign(async () => new Response(`<file md5="${hash}" total_size="17"/>`), { preconnect: originalFetch.preconnect });
    expect(await verifyFile(path, 17, 'https://cdn.gog.com/test.xml')).toBe(true);
    expect(await verifyFile(path, 18, 'https://cdn.gog.com/test.xml')).toBe(false);
    globalThis.fetch = Object.assign(async () => new Response('unavailable', { status: 503 }), { preconnect: originalFetch.preconnect });
    expect(await verifyFile(path, 17, 'https://cdn.gog.com/test.xml')).toBe(false);
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});