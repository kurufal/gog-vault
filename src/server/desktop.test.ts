import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc.exe' : 'x86_64-unknown-linux-gnu';
const binary = join('src-tauri', 'binaries', `gog-vault-sidecar-${target}`);
for (const entry of ['src/server/index.ts', ...(existsSync(binary) ? [binary] : [])]) test(`${entry} only serves authenticated local requests and queue sockets`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gog-vault-desktop-'));
  const token = 'ab'.repeat(32);
  const child = Bun.spawn(entry === binary ? [binary] : [process.execPath, entry], {
    env: { ...process.env, GOG_VAULT_DATA_DIR: dataDir, GOG_VAULT_SESSION_TOKEN: token },
    stdout: 'pipe', stderr: 'pipe'
  });
  let socket: WebSocket | undefined;
  try {
    const reader = child.stdout.getReader();
    const { value } = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Sidecar startup timed out')), 10000))]);
    const { ready, port } = JSON.parse(new TextDecoder().decode(value).trim()) as { ready: boolean; port: number };
    expect(ready).toBe(true);
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;
    expect(existsSync(join(dataDir, 'vault'))).toBe(false);
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/ws/queue`)).status).toBe(401);
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/ws/queue`);
    const rejected = await Promise.race([new Promise<boolean>(resolve => {
      unauthorized.onopen = () => resolve(false);
      unauthorized.onerror = () => resolve(true);
    }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Unauthorized socket timed out')), 5000))]);
    expect(rejected).toBe(true);
    unauthorized.close();
    expect((await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.org' } })).status).toBe(403);
    const response = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://tauri.localhost' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');
    const unconfigured = await (await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(unconfigured.vaultAccessible).toBe(false);
    expect((await fetch(`${base}/api/games/42/queue`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(400);
    const selected = join(dataDir, 'selected');
    await mkdir(selected);
    await mkdir(join(selected, 'Installers'));
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/api/storage/select`, { method: 'POST', headers, body: JSON.stringify({ path: selected }) })).status).toBe(200);
    const storage = await (await fetch(`${base}/api/storage`, { headers })).json();
    expect(storage.free).toBeGreaterThan(0);
    expect(storage.dirs).toBeUndefined();
    const childPath = join(selected, 'Installers');
    const database = new Database(join(dataDir, 'vault.sqlite'));
    try { database.query('INSERT INTO games(id,title,first_seen) VALUES (?,?,?)').run('42', 'Game', new Date().toISOString()); }
    finally { database.close(); }
    const outside = await mkdir(join(dataDir, 'outside'), { recursive: true }).then(() => join(dataDir, 'outside'));
    expect((await fetch(`${base}/api/games/42/link`, { method: 'POST', headers, body: JSON.stringify({ folder: outside }) })).status).toBe(400);
    const linked = await (await fetch(`${base}/api/games/42/link`, { method: 'POST', headers, body: JSON.stringify({ folder: childPath }) })).json();
    expect(linked.folder).toBe('Installers');
    expect((await fetch(`${base}/api/storage/select`, { method: 'POST', headers, body: JSON.stringify({ path: childPath }) })).status).toBe(200);
    await rename(selected, join(dataDir, 'disconnected'));
    const health = await (await fetch(`${base}/api/health`, { headers })).json();
    expect(health.healthy).toBe(true);
    expect(health.vaultAccessible).toBe(false);
    const saved = await (await fetch(`${base}/api/settings`, { headers })).json();
    expect(saved.vaultPath).toBe(join(selected, 'Installers'));
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/queue?session=${token}`);
    const message = await Promise.race([new Promise<string>((resolve, reject) => {
      socket!.onmessage = event => resolve(String(event.data));
      socket!.onerror = () => reject(new Error('Queue socket rejected'));
    }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Queue socket timed out')), 5000))]);
    expect(JSON.parse(message).type).toBe('queue');
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST', headers })).status).toBe(200);
    expect(await Promise.race([child.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Sidecar shutdown timed out')), 5000))])).toBe(0);
  } finally {
    socket?.close();
    child.kill();
    await child.exited;
    await rm(dataDir, { recursive: true, force: true });
  }
});