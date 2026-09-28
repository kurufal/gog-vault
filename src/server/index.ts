import { Elysia, t } from 'elysia';
import { join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { startupConfig, validSession } from './startup';
import { accountInfo, connect, disconnect, loginUrl } from './gog/auth';
import { product } from './gog/products';
import { refreshLibrary, refreshState } from './gog/library';
import { activity, configDir, db, filesFor, gameById, games, jobsFor, replaceFiles, saveSettings, settings, upsertGame } from './db';
import { mapFolder, scanGame, scanVault, scanState, selectVault, storageInfo, vaultPath } from './storage';
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
    dlc: t.Optional(t.Boolean()), extras: t.Optional(t.Boolean()), retries: t.Optional(t.Number({ minimum: 0, maximum: 10 })),
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
  .get('/api/games/:id', ({ params }) => { const game = gameById(params.id); if (!game) throw new Error('Game not found'); return { game, files: filesFor(params.id) }; })
  .post('/api/games/:id/downloads', async ({ params }) => {
    if (!gameById(params.id)) throw new Error('Game not found');
    const { info, files } = await product(params.id);
    upsertGame(info); replaceFiles(params.id, files);
    return { game: gameById(params.id), files: filesFor(params.id) };
  })
  .patch('/api/games/:id/selections', ({ params, body }) => {
    if (!gameById(params.id)) throw new Error('Game not found');
    const update = db.query('UPDATE remote_files SET selected=? WHERE game_id=? AND key=?');
    db.transaction(() => { for (const file of body.files) update.run(Number(file.selected), params.id, file.key); })();
    return { game: gameById(params.id), files: filesFor(params.id) };
  }, { body: t.Object({ files: t.Array(t.Object({ key: t.String(), selected: t.Boolean() })) }) })
  .post('/api/games/:id/link', async ({ params, body }) => { await mapFolder(params.id, body.folder); return gameById(params.id); }, { body: t.Object({ folder: t.String() }) })
  .post('/api/games/:id/scan', async ({ params }) => scanGame(params.id))
  .post('/api/games/:id/verify', async ({ params }) => scanGame(params.id))
  .post('/api/storage/scan', () => { void scanVault(); return { started: true }; })
  .get('/api/storage/scan', () => scanState)
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
    const disk = await storageInfo().catch(() => ({ free: 0 }));
    return { counts: { owned: all.length, vaulted: all.filter(g => g.status === 'Vaulted').length,
      missing: all.filter(g => g.status === 'Not Downloaded').length, incomplete: all.filter(g => g.status === 'Incomplete').length,
      updates: all.filter(g => g.status === 'Update Available').length, downloading: queue.filter(j => j.state === 'downloading').length,
      errors: all.filter(g => g.status === 'Error').length, size: all.reduce((sum, g) => sum + g.localSize, 0), free: disk.free },
      activity: db.query('SELECT at,message FROM activity ORDER BY id DESC LIMIT 12').all() };
  })
  .get('/api/art/:id/:kind', async ({ params, set }) => {
    if (!['cover', 'background'].includes(params.kind) || !/^\d+$/.test(params.id)) throw new Error('Invalid artwork');
    const game = gameById(params.id);
    if (!game?.folder) throw new Error('Artwork not found');
    const dir = join(await vaultPath(), game.folder, '.gog-vault');
    const { realpath } = await import('node:fs/promises');
    if (await realpath(dir) !== dir) throw new Error('Artwork not found');
    for (const ext of ['jpg', 'png']) {
      const file = join(dir, `${params.kind}.${ext}`);
      if (await Bun.file(file).exists()) { set.headers['Cache-Control'] = 'private, max-age=3600'; return Bun.file(file); }
    }
    throw new Error('Artwork not found');
  })
  .ws('/ws/queue', {
    open(ws) { const unsubscribe = subscribe(jobs => ws.send(JSON.stringify({ type: 'queue', jobs }))); (ws.data as any).unsubscribe = unsubscribe; ws.send(JSON.stringify({ type: 'queue', jobs: jobsFor() })); },
    close(ws) { (ws.data as any).unsubscribe?.(); }
  });

startQueue();
app.listen({ hostname: host, port });
console.log(JSON.stringify({ ready: true, port: app.server?.port }));