import { createReadStream } from 'node:fs';
import { mkdir, open, stat, rename, lstat, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { XMLParser } from 'fast-xml-parser';
import { safeName, type RemoteFile } from '../shared/domain';
import { secureLink } from './gog/products';
import { settings } from './db';

type Checksum = { md5?: string; size?: number; chunks: { from: number; to: number; md5: string }[] };
export type DownloadVerification = { filename: string; size: number; sha256: string; source: 'gog-checksum' | 'local-sha256'; checksumUrl?: string };
async function checksumData(url?: string, signal?: AbortSignal): Promise<Checksum | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 2_000_000) throw new Error('Checksum metadata unavailable');
    const xml = await response.text();
    if (xml.length > 2_000_000) throw new Error('Checksum metadata too large');
    const file = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml)?.file;
    if (!file) throw new Error('Invalid checksum metadata');
    const chunks = (Array.isArray(file.chunk) ? file.chunk : file.chunk ? [file.chunk] : []).map((chunk: any) => ({ from: Number(chunk.from), to: Number(chunk.to), md5: String(chunk['#text'] || '').toLowerCase() }));
    const md5 = /^[a-f0-9]{32}$/i.test(file.md5) ? file.md5.toLowerCase() : undefined;
    if (!md5 && !chunks.length) throw new Error('Checksum metadata has no hashes');
    return { md5, size: Number(file.total_size) || undefined, chunks };
  } catch { throw new Error('Checksum metadata unavailable'); }
}
async function hashFile(path: string, start = 0, end?: number, signal?: AbortSignal, algorithm = 'md5') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path, { start, end, signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyDownloaded(path: string, size: number, checksumUrl?: string, signal?: AbortSignal, preloaded?: Checksum | null): Promise<boolean> {
    const info = await lstat(path);
    if (!info.isFile() || size > 0 && info.size !== size) return false;
    if (!checksumUrl) return info.size > 0 && (!size || info.size === size);
    const checksum = preloaded === undefined ? await checksumData(checksumUrl, signal) : preloaded;
    if (checksum?.size && info.size !== checksum.size) return false;
    if (checksum?.md5) return await hashFile(path, 0, undefined, signal) === checksum.md5;
    if (checksum?.chunks.length) {
      let covered = 0;
      for (const chunk of checksum.chunks) {
        if (!Number.isSafeInteger(chunk.from) || !Number.isSafeInteger(chunk.to) || chunk.from !== covered || chunk.to >= info.size || chunk.to < chunk.from || !/^[a-f0-9]{32}$/.test(chunk.md5) || await hashFile(path, chunk.from, chunk.to, signal) !== chunk.md5) return false;
        covered = chunk.to + 1;
      }
      if (covered !== info.size) return false;
    }
    return true;
}
export async function verifyFile(path: string, size: number, checksumUrl?: string, useOfficialSize = false, signal?: AbortSignal): Promise<boolean> {
  if (!checksumUrl) return false;
  try {
    const checksum = await checksumData(checksumUrl, signal);
    return await verifyDownloaded(path, useOfficialSize && checksum?.size ? checksum.size : size, checksumUrl, signal, checksum);
  } catch { if (signal?.aborted) throw new Error('Verification cancelled'); return false; }
}
export async function localSha256(path: string, signal?: AbortSignal) {
  return hashFile(path, 0, undefined, signal, 'sha256');
}
async function preservePrevious(folder: string, filename: string, final: string, partial: string) {
  const previous = join(folder, '.gog-vault', 'previous');
  await mkdir(previous, { recursive: true });
  if (await realpath(previous) !== previous) throw new Error('Unsafe previous versions directory');
  let backup = join(previous, `${filename}.${Date.now()}`);
  while (await Bun.file(backup).exists()) backup += '.old';
  await rename(final, backup);
  try { await rename(partial, final); }
  catch (error) { await rename(backup, final); throw error; }
}
export async function downloadFile(file: RemoteFile, folder: string, signal: AbortSignal, progress: (bytes: number, total: number) => void,
  onVerifying: (expectedSize?: number) => void = () => {}, onDownloading: () => void = () => {}, onVerified: (result: DownloadVerification) => void = () => {},
  onStage: (stage: string, httpStatus?: number) => void = () => {}) {
  const config = settings();
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal.aborted) throw new Error('Download interrupted');
    try {
    onStage('resolve_downlink');
    const link = await secureLink(file);
      let official: Checksum | null = null;
      for (let verification = 0; link.checksum && verification <= config.retries; verification++) {
      onStage('resolve_checksum');
        try { official = await checksumData(link.checksum, signal); break; }
        catch (error) {
          if (verification === config.retries || signal.aborted) throw error;
          await sleep(Math.min(30000, 1000 * 2 ** verification), undefined, { signal });
        }
      }
      let expectedSize = official?.size || file.size;
      const filename = safeName(link.filename);
      if (!link.filename || filename !== link.filename || filename.startsWith('.')) throw new Error('Unsafe remote filename');
      const final = join(folder, filename);
      const partial = final + '.part';
      onStage('open_destination');
      if (await lstat(partial).then(info => info.isSymbolicLink() || !info.isFile()).catch(() => false)) throw new Error('Unsafe partial file');
      const oldExists = await lstat(final).then(info => { if (!info.isFile()) throw new Error('Unsafe existing installer'); return true; }).catch(error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (oldExists && link.checksum) {
        for (let verification = 0; verification <= config.retries; verification++) {
          if (signal.aborted) throw new Error('Download interrupted');
          try {
            onStage('checksum_verification');
            if (await verifyDownloaded(final, expectedSize, link.checksum, signal, official)) {
              onStage('local_sha256');
              onVerified({ filename, size: (await stat(final)).size, sha256: await hashFile(final, 0, undefined, signal, 'sha256'), source: 'gog-checksum', checksumUrl: link.checksum });
              return filename;
            }
            break;
          } catch (error) {
            if (verification === config.retries || signal.aborted) throw error;
            await sleep(Math.min(30000, 1000 * 2 ** verification), undefined, { signal });
          }
        }
      }
      let offset = await stat(partial).then(info => info.size).catch(() => 0);
      onStage('range_setup');
      if (expectedSize > 0 && offset > expectedSize) throw new Error('Partial file exceeds expected size');
      if (!expectedSize || offset !== expectedSize) {
      onDownloading();
      try {
      const inactivity = new AbortController();
      let timer = setTimeout(() => inactivity.abort(), config.timeout * 1000);
      try {
        const response = await fetch(link.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.any([signal, inactivity.signal]) });
        onStage('http_response', response.status);
        if (response.status === 416 && offset && response.headers.get('content-range') === `bytes */${offset}`) {
          if (expectedSize && offset !== expectedSize) throw new Error('Incomplete CDN range');
        } else {
        if (response.status !== 200 && response.status !== 206 || !response.body) throw new Error(`CDN returned HTTP ${response.status}`);
        if (offset && response.status === 200) offset = 0;
        if (!expectedSize && response.status === 200) {
          const length = Number(response.headers.get('content-length'));
          if (Number.isSafeInteger(length) && length > 0) expectedSize = length;
        }
        if (offset && response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Unexpected CDN range response');
        const handle = await open(partial, offset ? 'a' : 'w', 0o600);
        try {
        onStage('download_bytes', response.status);
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) throw new Error('Download interrupted');
          await handle.write(value);
          offset += value.byteLength;
          progress(offset, expectedSize);
          clearTimeout(timer);
          timer = setTimeout(() => inactivity.abort(), config.timeout * 1000);
        }
        } finally { onStage('close_file'); await handle.close(); }
        }
      } finally { clearTimeout(timer); }
      } catch (error) {
        if (signal.aborted || attempt === config.retries) throw error;
        await sleep(Math.min(30000, 1000 * 2 ** attempt), undefined, { signal });
        continue;
      }
      }
      progress(offset, expectedSize);
      onVerifying(expectedSize);
      let verified = false;
      for (let verification = 0; verification <= config.retries; verification++) {
        if (signal.aborted) throw new Error('Download interrupted');
        onStage(link.checksum ? 'checksum_verification' : 'local_size_verification');
        try { verified = await verifyDownloaded(partial, expectedSize, link.checksum, signal, official); break; }
        catch (error) {
          if (verification === config.retries || signal.aborted) throw error;
          await sleep(Math.min(30000, 1000 * 2 ** verification), undefined, { signal });
        }
      }
      if (verified) {
        onStage('rename_part');
        if (oldExists) await preservePrevious(folder, filename, final, partial);
        else await rename(partial, final);
        onStage('local_sha256');
        onVerified({ filename, size: (await stat(final)).size, sha256: await hashFile(final, 0, undefined, signal, 'sha256'), source: link.checksum ? 'gog-checksum' : 'local-sha256', checksumUrl: link.checksum });
        return filename;
      }
      if (attempt === config.retries) throw new Error('Installer checksum mismatch');
      await unlink(partial);
      onDownloading();
    } catch (error) {
      if (error instanceof Error && /Checksum metadata unavailable|Installer checksum mismatch/.test(error.message)) throw error;
      if (signal.aborted || attempt === config.retries) throw error;
      await sleep(Math.min(30000, 1000 * 2 ** attempt), undefined, { signal });
    }
  }
  throw new Error('Download failed');
}