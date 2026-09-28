import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

type Session = { port: number; token: string };
let pending: Promise<Session> | undefined;

export function session(): Promise<Session> {
  pending ??= (async () => {
    if (!('__TAURI_INTERNALS__' in window)) {
      throw new Error('Open GOG Vault in its Tauri desktop window; a standalone Vite tab has no native backend.');
    }
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

export async function localArtwork(gameId: string, type: 'cover' | 'background' | 'logo' | 'icon' | 'videoPoster'): Promise<string> {
  const { port, token } = await session();
  const response = await fetch(`http://127.0.0.1:${port}/api/art/${encodeURIComponent(gameId)}/${type}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error('No local artwork');
  return URL.createObjectURL(await response.blob());
}

export async function localMedia(gameId: string, key: string): Promise<string> {
  const { port, token } = await session();
  const response = await fetch(`http://127.0.0.1:${port}/api/media/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error('Media not archived');
  return URL.createObjectURL(await response.blob());
}

export async function pickVault(): Promise<string | null> {
  return open({ directory: true, multiple: false });
}

export function startGogLogin(loginUrl: string): Promise<void> {
  return invoke('start_gog_login', { loginUrl });
}

export function cancelGogLogin(): Promise<void> {
  return invoke('cancel_gog_login');
}

export function diskCapacity(path: string): Promise<{ totalBytes: number; freeBytes: number; availableBytes: number }> {
  return invoke('disk_capacity', { path });
}

export function onGogAuthStatus(handler: (status: 'connected' | 'cancelled' | 'expired' | 'error') => void): Promise<() => void> {
  return listen('gog-auth-status', event => handler(event.payload as 'connected' | 'cancelled' | 'expired' | 'error'));
}

export { openUrl };