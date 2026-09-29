import { mkdir, open, realpath, lstat, rename, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import { db, gameById, mediaFor } from './db';
import { trustedGogUrl } from './gog/products';
import { gameFolder, writeOfflineMetadata } from './storage';

export function selectMedia(gameId: string, files: { key: string; selected: boolean }[]) {
  const update = db.query("UPDATE media_assets SET selected=? WHERE game_id=? AND key=? AND (role IN ('screenshot','additionalArtwork') OR role='video' AND external=0)");
  db.transaction(() => { for (const file of files) update.run(Number(file.selected), gameId, file.key); })();
  return mediaFor(gameId);
}

export async function archiveMedia(gameId: string) {
  const game = gameById(gameId);
  if (!game?.folder) throw new Error('Link a game folder before archiving media');
  const folder = await gameFolder(game);
  const root = join(folder, '.gog-vault');
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error('Unsafe media directory');
  let downloaded = 0;
  for (const asset of mediaFor(gameId).filter(item => item.selected && !item.external && !item.localPath)) {
    if (!trustedGogUrl(asset.url, true)) continue;
    const kind = asset.role === 'video' ? 'videos' : 'screenshots';
    const directory = join(root, kind);
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error('Unsafe media directory');
    const ext = new URL(asset.url).pathname.match(/\.(jpe?g|png|webp|mp4|webm)$/i)?.[1]?.toLowerCase();
    if (!ext) continue;
    const filename = `${asset.key}.${ext}`;
    const destination = join(directory, filename);
    if (await lstat(destination).then(() => true).catch(() => false)) throw new Error('Media destination already exists; no file was overwritten');
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body || !trustedGogUrl(response.url, true)) throw new Error('Media download unavailable');
    const contentType = response.headers.get('content-type') || '';
    if (kind === 'videos' ? !/^video\/(mp4|webm)/i.test(contentType) : !/^image\/(jpeg|png|webp)/i.test(contentType)) throw new Error('Unsupported media response');
    const limit = kind === 'videos' ? 2_000_000_000 : 30_000_000;
    if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('Media file exceeds archive size limit');
    const partial = destination + '.part';
    const handle = await open(partial, 'wx');
    try {
      let bytes = 0;
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error('Media file exceeds archive size limit');
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.close();
      const dimensions = kind === 'screenshots' ? imageSize(await readFile(partial)) : null;
      if (await lstat(destination).then(() => true).catch(() => false)) throw new Error('Media destination already exists');
      await rename(partial, destination);
      db.query('UPDATE media_assets SET local_path=?,size=?,width=?,height=?,mime_type=?,sha256=? WHERE game_id=? AND key=?').run(`.gog-vault/${kind}/${filename}`, bytes,
        dimensions?.width || 0, dimensions?.height || 0, contentType.split(';')[0], hash.digest('hex'), gameId, asset.key);
      if (process.env.GOG_VAULT_DEBUG_MEDIA === '1') console.log(JSON.stringify({ role: asset.role, url: new URL(asset.url).origin + new URL(asset.url).pathname, width: dimensions?.width || 0, height: dimensions?.height || 0, mimeType: contentType.split(';')[0] }));
      downloaded++;
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(partial).catch(() => {});
      throw error;
    }
  }
  if (downloaded) await writeOfflineMetadata(gameId);
  return { downloaded, media: mediaFor(gameId) };
}