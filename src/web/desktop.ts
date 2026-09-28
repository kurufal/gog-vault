import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

type Session = { port: number; token: string };
let pending: Promise<Session> | undefined;

export function session(): Promise<Session> {
  pending ??= (async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = await invoke<Session | null>('backend_session');
      if (current) return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The GOG Vault backend did not start');
  })();
  return pending;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { port, token } = await session();
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

export async function queueSocket(): Promise<WebSocket> {
  const { port, token } = await session();
  return new WebSocket(`ws://127.0.0.1:${port}/ws/queue?session=${token}`);
}

export async function localArtwork(gameId: string, type: 'cover' | 'background'): Promise<string> {
  const { port, token } = await session();
  const response = await fetch(`http://127.0.0.1:${port}/api/art/${encodeURIComponent(gameId)}/${type}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error('No local artwork');
  return URL.createObjectURL(await response.blob());
}

export async function pickVault(): Promise<string | null> {
  return open({ directory: true, multiple: false });
}

export { openUrl };