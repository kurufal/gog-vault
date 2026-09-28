import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { StoredAccount } from './credentials';

let saved: StoredAccount | null = null;
mock.module('./credentials', () => ({ credentials: {
  getGogRefreshToken: async () => saved,
  setGogRefreshToken: async (account: StoredAccount) => { saved = account; },
  deleteGogRefreshToken: async () => { saved = null; }
} }));

const { connect, invalidateAccessToken, accessToken, disconnect } = await import('./auth');
const { gogRequest } = await import('./client');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  saved = null;
  invalidateAccessToken();
});

describe('GOG token lifecycle', () => {
  test('verifies the user before saving the refresh token', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname === '/token') {
        expect(url.searchParams.get('grant_type')).toBe('authorization_code');
        return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      }
      return Response.json({ isLoggedIn: true, username: 'Tester', userId: 42 });
    }) as typeof fetch;
    expect(await connect('abcdefghijklmnop')).toEqual({ connected: true, username: 'Tester', userId: '42' });
    expect(requests).toEqual(['/token', '/userData.json']);
    expect(saved).toEqual({ refresh: 'refresh', username: 'Tester', userId: '42' });
    await disconnect();
    expect(saved).toBeNull();
  });

  test('rejects an unverified account without saving credentials', async () => {
    globalThis.fetch = (async input => String(input).includes('/token?')
      ? Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
      : Response.json({ isLoggedIn: false, username: 'Tester' })) as typeof fetch;
    await expect(connect('abcdefghijklmnop')).rejects.toThrow('verification failed');
    expect(saved).toBeNull();
    await expect(accessToken()).rejects.toThrow('Connect a GOG account first');
  });

  test('rotates refresh tokens and retries an authenticated 401 only once', async () => {
    saved = { refresh: 'old', username: 'Tester', userId: '42' };
    let exchanges = 0;
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/token') {
        exchanges++;
        expect(url.searchParams.get('refresh_token')).toBe(exchanges === 1 ? 'old' : 'rotated-1');
        return Response.json({ access_token: `access-${exchanges}`, refresh_token: `rotated-${exchanges}`, expires_in: 3600 });
      }
      requests++;
      expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer access-${requests}` });
      return requests === 1 ? new Response('', { status: 401 }) : Response.json({ ok: true });
    }) as typeof fetch;
    expect(await gogRequest<{ ok: boolean }>('https://api.gog.com/products')).toEqual({ ok: true });
    expect({ exchanges, requests }).toEqual({ exchanges: 2, requests: 2 });
    expect(saved?.refresh).toBe('rotated-2');
    expect(await accessToken()).toBe('access-2');
  });
});