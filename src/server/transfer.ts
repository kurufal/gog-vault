import { createReadStream } from 'node:fs';
import { open, stat, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { safeName, type RemoteFile } from '../shared/domain';
import { secureLink } from './gog/products';
import { settings } from './db';

type Checksum = { md5?: string; size?: number; chunks: { from: number; to: number; md5: string }[] };
async function checksumData(url?: string): Promise<Checksum | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 2_000_000) throw new Error('Checksum metadata unavailable');
    const xml = await response.text();
    if (xml.length > 2_000_000) throw new Error('Checksum metadata too large');
    const file = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml)?.file;
    if (!file) throw new Error('Invalid checksum metadata');
    const chunks = (Array.isArray(file.chunk) ? file.chunk : file.chunk ? [file.chunk] : []).map((chunk: any) => ({ from: Number(chunk.from), to: Number(chunk.to), md5: String(chunk['#text'] || '').toLowerCase() }));
    return { md5: /^[a-f0-9]{32}$/i.test(file.md5) ? file.md5.toLowerCase() : undefined, size: Number(file.total_size) || undefined, chunks };
  } catch { throw new Error('Checksum metadata unavailable'); }
}
async function hashFile(path: string, start = 0, end?: number) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path, { start, end })) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyFile(path: string, size: number, checksumUrl?: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || size > 0 && info.size !== size || !size && !checksumUrl) return false;
    const checksum = await checksumData(checksumUrl);
    if (checksum?.size && info.size !== checksum.size) return false;
    if (checksum?.md5) return await hashFile(path) === checksum.md5;
    if (checksum?.chunks.length) {
      for (const chunk of checksum.chunks) {
        if (!Number.isSafeInteger(chunk.from) || !Number.isSafeInteger(chunk.to) || chunk.from < 0 || chunk.to >= info.size || chunk.to < chunk.from || !/^[a-f0-9]{32}$/.test(chunk.md5) || await hashFile(path, chunk.from, chunk.to) !== chunk.md5) return false;
      }
    }
    return true;
  } catch { return false; }
}
export async function downloadFile(file: RemoteFile, folder: string, signal: AbortSignal, progress: (bytes: number, total: number) => void) {
  const config = settings();
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) throw new Error('Download interrupted');
    try {
      const link = await secureLink(file);
      const filename = safeName(link.filename);
      if (!link.filename || filename !== link.filename || filename.startsWith('.')) throw new Error('Unsafe remote filename');
      const final = join(folder, filename);
      const partial = final + '.part';
      if (await lstat(partial).then(info => info.isSymbolicLink() || !info.isFile()).catch(() => false)) throw new Error('Unsafe partial file');
      if (await stat(final).then(() => true).catch(() => false)) {
        if (await verifyFile(final, file.size, link.checksum)) return filename;
        throw new Error('Existing installer differs from expected file; refusing to overwrite');
      }
      let offset = await stat(partial).then(info => info.size).catch(() => 0);
      if (file.size > 0 && offset > file.size) throw new Error('Partial file exceeds expected size');
      if (offset && file.size && offset === file.size && await verifyFile(partial, file.size, link.checksum)) {
        await rename(partial, final);
        return filename;
      }
      const inactivity = new AbortController();
      let timer = setTimeout(() => inactivity.abort(), config.timeout * 1000);
      try {
        const response = await fetch(link.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.any([signal, inactivity.signal]) });
        if (response.status !== 200 && response.status !== 206 || !response.body) throw new Error(`CDN returned HTTP ${response.status}`);
        if (offset && response.status === 200) offset = 0;
        if (offset && response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Unexpected CDN range response');
        const handle = await open(partial, offset ? 'a' : 'w', 0o600);
        try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) throw new Error('Download interrupted');
          await handle.write(value);
          offset += value.byteLength;
          progress(offset, file.size);
          clearTimeout(timer);
          timer = setTimeout(() => inactivity.abort(), config.timeout * 1000);
        }
        } finally { await handle.close(); }
      } finally { clearTimeout(timer); }
      if (!await verifyFile(partial, file.size, link.checksum)) throw new Error('Installer size or checksum mismatch');
      await rename(partial, final);
      return filename;
    } catch (error) {
      if (signal.aborted || attempt === config.retries || error instanceof Error && error.message.includes('refusing to overwrite')) throw error;
      await Bun.sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  throw new Error('Download failed');
}