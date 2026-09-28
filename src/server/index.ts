import { Elysia, t } from 'elysia';
import { join, sep } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { withinRoot } from '../shared/domain';
import { startupConfig, validSession } from './startup';
import { accountInfo, connect, disconnect, loginUrl } from './gog/auth';
import { product } from './gog/products';
import { refreshLibrary, refreshState } from './gog/library';
import { activity, configDir, db, filesFor, gameById, games, jobsFor, mediaFor, replaceFiles, replaceMedia, saveSettings, settings, upsertGame } from './db';
import { cancelScan, mapFolder, organizeGame, organizePreview, scanGame, scanVault, scanState, selectVault, storageInfo, vaultPath } from './storage';
import { archiveMedia, selectMedia } from './media';
import { broadcast, command, enqueue, schedule, shutdownQueue, startQueue, subscribe } from './queue';

const { token, host, port } = startupConfig();
const allowedOrigins = new Set(['http://tauri.localhost', 'tauri://localhost', ...(process.env.GOG_VAULT_DEV === '1' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [])]);
const app = new Elysia()
  .onRequest(({ request }) => {
    const origin = request.headers.get('origin');
    if (origin && !allowedOrigins.has(origin)) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': origin || '', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    } });
    const url = new URL(request.url);
    const provided = url.pathname === '/ws/queue' ? url.searchParams.get('session') : request.headers.get('authorization')?.replace(/^Bearer /, '') || null;
    if (!validSession(token, provided)) return new Response('Unauthorized', { status: 401 });
  })
  .onAfterHandle(({ request, set }) => {
    const origin = request.headers.get('origin');
    if (origin && allowedOrigins.has(origin)) set.headers['Access-Control-Allow-Origin'] = origin;
  })
  .onError(({ error, code, set }) => {
    const message = code === 'VALIDATION' ? 'Invalid request' : error instanceof Error ? error.message : 'Request failed';
    set.status = code === 'VALIDATION' ? 400 : /not found/i.test(message) ? 404 : /invalid|unsafe|escapes|select|cannot|already|missing|no |stop /i.test(message) ? 400 : 500;
    console.error(`API error: ${code} (HTTP ${set.status})`);
    return { error: message };
  })
  .get('/api/health', async ({ set }) => {
    let configWritable = false, vaultAccessible = false, vaultWritable = false, database = false;
    try { db.query('SELECT 1').get(); database = true; } catch {}
    try { await access(configDir, constants.W_OK); configWritable = true; } catch {}
    try { const path = await vaultPath(); await access(path, constants.R_OK); vaultAccessible = true; await access(path, constants.W_OK); vaultWritable = true; } catch {}
    const healthy = database && configWritable;
    if (!healthy) set.status = 503;
    return { healthy, database, configWritable, vaultAccessible, vaultWritable };
  })
  .get('/api/settings', () => settings())
  .patch('/api/settings', ({ body }) => {
    const next = saveSettings(body);
    schedule(); return next;
  }, { body: t.Object({ concurrency: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    platform: t.Optional(t.Union([t.Literal('windows'), t.Literal('linux'), t.Literal('mac')])), language: t.Optional(t.String()),
    platforms: t.Optional(t.Array(t.Union([t.Literal('windows'), t.Literal('linux'), t.Literal('mac')]))), languages: t.Optional(t.Array(t.String())),
    dlc: t.Optional(t.Boolean()), extras: t.Optional(t.Boolean()), patches: t.Optional(t.Boolean()), languagePacks: t.Optional(t.Boolean()), storeImages: t.Optional(t.Boolean()), storeVideos: t.Optional(t.Boolean()), autoRefresh: t.Optional(t.Boolean()), autoScan: t.Optional(t.Boolean()), retries: t.Optional(t.Number({ minimum: 0, maximum: 10 })),
    timeout: t.Optional(t.Number({ minimum: 10, maximum: 3600 })), view: t.Optional(t.String()), reducedMotion: t.Optional(t.Boolean()) }) })
  .get('/api/storage', () => storageInfo())
  .post('/api/storage/select', async ({ body }) => {
    return saveSettings({ vaultPath: await selectVault(body.path) });
  }, { body: t.Object({ path: t.String() }) })
  .get('/api/gog/auth', async () => ({ ...await accountInfo(), loginUrl }))
  .post('/api/gog/auth', async ({ body }) => { const result = await connect(body.code); activity(`GOG account connected: ${result.username}`); return result; }, { body: t.Object({ code: t.String() }) })
  .delete('/api/gog/auth', async () => { await disconnect(); activity('GOG account disconnected'); return { ok: true }; })
  .get('/api/gog/library', () => refreshState)
  .post('/api/gog/library', () => { void refreshLibrary(); return { started: true }; })
  .get('/api/games', () => games())
  .get('/api/library/download-preview', () => games().flatMap(game => {
    const missing = filesFor(game.id).filter(file => file.selected && !file.matched && !file.verified);
    return missing.length && !jobsFor(game.id).some(job => ['queued', 'downloading', 'verifying', 'paused'].includes(job.state))
      ? [{ id: game.id, title: game.title, files: missing.length, bytes: missing.reduce((sum, file) => sum + file.size, 0) }] : [];
  }))
  .post('/api/library/download-missing', ({ body }) => {
    const started: { id: string; job: number }[] = []; const skipped: { id: string; reason: string }[] = [];
    for (const id of new Set(body.ids)) {
      try { started.push({ id, job: enqueue(id) }); }
      catch (error) { skipped.push({ id, reason: error instanceof Error ? error.message : 'Could not queue' }); }
    }
    return { started, skipped };
  }, { body: t.Object({ ids: t.Array(t.String()) }) })
  .get('/api/games/:id', ({ params }) => { const game = gameById(params.id); if (!game) throw new Error('Game not found'); return { game, files: filesFor(params.id), media: mediaFor(params.id) }; })
  .post('/api/games/:id/downloads', async ({ params }) => {
    if (!gameById(params.id)) throw new Error('Game not found');
    const { info, files, media } = await product(params.id);
    upsertGame(info); replaceFiles(params.id, files); replaceMedia(params.id, media);
    return { game: gameById(params.id), files: filesFor(params.id), media: mediaFor(params.id) };
  })
  .patch('/api/games/:id/selections', ({ params, body }) => {
    if (!gameById(params.id)) throw new Error('Game not found');
    const update = db.query('UPDATE remote_files SET selected=? WHERE game_id=? AND key=?');
    db.transaction(() => { for (const file of body.files) update.run(Number(file.selected), params.id, file.key); })();
    return { game: gameById(params.id), files: filesFor(params.id), media: mediaFor(params.id) };
  }, { body: t.Object({ files: t.Array(t.Object({ key: t.String(), selected: t.Boolean() })) }) })
  .patch('/api/games/:id/media', ({ params, body }) => {
    if (!gameById(params.id)) throw new Error('Game not found');
    selectMedia(params.id, body.files);
    return { game: gameById(params.id), files: filesFor(params.id), media: mediaFor(params.id) };
  }, { body: t.Object({ files: t.Array(t.Object({ key: t.String(), selected: t.Boolean() })) }) })
  .post('/api/games/:id/media/archive', async ({ params }) => archiveMedia(params.id))
  .post('/api/games/:id/link', async ({ params, body }) => { await mapFolder(params.id, body.folder); return gameById(params.id); }, { body: t.Object({ folder: t.String() }) })
  .post('/api/games/:id/scan', async ({ params }) => scanGame(params.id))
  .post('/api/games/:id/verify', async ({ params }) => scanGame(params.id, true))
  .post('/api/storage/scan', () => { void scanVault(); return { started: true }; })
  .get('/api/storage/scan', () => scanState)
  .post('/api/storage/scan/cancel', () => { cancelScan(); return { cancelled: true }; })
  .get('/api/storage/organize', async () => organizePreview())
  .post('/api/storage/organize/:id', async ({ params }) => organizeGame(params.id))
  .post('/api/games/:id/queue', ({ params }) => ({ id: enqueue(params.id) }))
  .get('/api/queue', () => jobsFor())
  .post('/api/queue/:id/:action', ({ params }) => {
    if (!['pause', 'resume', 'cancel', 'remove'].includes(params.action)) throw new Error('Invalid queue action');
    command(Number(params.id), params.action as 'pause' | 'resume' | 'cancel' | 'remove'); return { ok: true };
  })
  .post('/api/shutdown', async () => {
    await shutdownQueue();
    db.close();
    setTimeout(() => process.exit(0), 50).unref();
    return { ok: true };
  })
  .get('/api/dashboard', async () => {
    const all = games(); const queue = jobsFor();
    const disk = await storageInfo().catch(() => ({ available: null }));
    return { counts: { owned: all.length, vaulted: all.filter(g => g.status === 'Vaulted').length,
      missing: all.filter(g => g.status === 'Not Downloaded').length, incomplete: all.filter(g => g.status === 'Incomplete').length,
      updates: all.filter(g => g.status === 'Update Available').length, downloading: queue.filter(j => j.state === 'downloading').length,
      errors: all.filter(g => g.status === 'Error').length, size: all.reduce((sum, g) => sum + g.localSize, 0), free: disk.available },
      activity: db.query('SELECT at,message FROM activity ORDER BY id DESC LIMIT 12').all() };
  })
  .get('/api/art/:id/:kind', async ({ params, set }) => {
    if (!['cover', 'background', 'logo', 'icon', 'videoPoster'].includes(params.kind) || !/^\d+$/.test(params.id)) throw new Error('Invalid artwork');
    const game = gameById(params.id);
    if (!game?.folder) throw new Error('Artwork not found');
    const dir = join(await vaultPath(), game.folder, '.gog-vault');
    const { realpath } = await import('node:fs/promises');
    if (await realpath(dir) !== dir) throw new Error('Artwork not found');
    for (const ext of ['jpg', 'png', 'webp']) {
      const file = join(dir, `${params.kind}.${ext}`);
      if (await Bun.file(file).exists()) { set.headers['Cache-Control'] = 'private, max-age=3600'; return Bun.file(file); }
    }
    throw new Error('Artwork not found');
  })
  .get('/api/media/:id/:key', async ({ params, set }) => {
    if (!/^\d+$/.test(params.id) || !/^[a-f0-9]{20}$/.test(params.key)) throw new Error('Invalid media asset');
    const asset = mediaFor(params.id).find(item => item.key === params.key);
    const game = gameById(params.id);
    if (!asset?.localPath || !game?.folder) throw new Error('Media not archived');
    const root = await vaultPath();
    const folder = join(root, game.folder);
    const path = withinRoot(folder, asset.localPath);
    const { realpath, lstat } = await import('node:fs/promises');
    const resolved = await realpath(path);
    if (!resolved.startsWith(folder + sep) || !(await lstat(resolved)).isFile()) throw new Error('Unsafe media file');
    set.headers['Cache-Control'] = 'private, max-age=3600';
    return Bun.file(resolved);
  })
  .ws('/ws/queue', {
    open(ws) { const unsubscribe = subscribe(jobs => ws.send(JSON.stringify({ type: 'queue', jobs }))); (ws.data as any).unsubscribe = unsubscribe; ws.send(JSON.stringify({ type: 'queue', jobs: jobsFor() })); },
    close(ws) { (ws.data as any).unsubscribe?.(); }
  });

startQueue();
app.listen({ hostname: host, port });
console.log(JSON.stringify({ ready: true, port: app.server?.port }));
const automation = settings();
if (automation.autoScan && automation.vaultPath) void scanVault();
if (automation.autoRefresh) void accountInfo().then(account => { if (account.connected) return refreshLibrary(); }).catch(() => {});