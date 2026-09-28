import { credentials } from './credentials';
import { endpoints } from './types';

const clientId = '46899977096215655';
const clientSecret = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const redirect = 'https://embed.gog.com/on_login_success?origin=client';
let access = '';
let expires = 0;
let pending: Promise<string> | null = null;

export const loginUrl = `${endpoints.auth}/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', layout: 'client2' })}`;
export function parseCode(input: string): string {
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    const url = new URL(code);
    if (url.origin !== 'https://embed.gog.com' || url.username || url.password || url.pathname !== '/on_login_success' || url.searchParams.get('origin') !== 'client') throw new Error('Not a GOG login success URL');
    code = url.searchParams.get('code') || '';
  }
  if (!/^[A-Za-z0-9_-]{12,512}$/.test(code)) throw new Error('Invalid authorization code');
  return code;
}
async function exchange(grant: 'authorization_code' | 'refresh_token', value: string) {
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: grant });
  if (grant === 'authorization_code') { params.set('code', value); params.set('redirect_uri', redirect); }
  else params.set('refresh_token', value);
  const response = await fetch(`${endpoints.auth}/token?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GOG token exchange failed (HTTP ${response.status})`);
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') throw new Error('Invalid token response');
  access = data.access_token;
  expires = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
  return data.refresh_token;
}
export async function connect(input: string) {
  await credentials.getGogRefreshToken();
  try {
    const refresh = await exchange('authorization_code', parseCode(input));
    const response = await fetch(`${endpoints.embed}/userData.json`, { headers: { Authorization: `Bearer ${access}` } });
    if (!response.ok) throw new Error('GOG account verification failed');
    const user = await response.json() as Record<string, unknown>;
    if (user.isLoggedIn !== true || typeof user.username !== 'string') throw new Error('GOG account verification failed');
    await credentials.setGogRefreshToken({ refresh, username: user.username, userId: String(user.userId || '') });
    return { connected: true, username: user.username, userId: String(user.userId || '') };
  } catch (error) {
    invalidateAccessToken();
    throw error;
  }
}
export async function accountInfo() {
  try {
    const account = await credentials.getGogRefreshToken();
    return { connected: !!account, username: account?.username || '', userId: account?.userId || '' };
  } catch (error) {
    return { connected: false, username: '', userId: '', credentialError: error instanceof Error ? error.message : 'OS credential store unavailable' };
  }
}
export async function disconnect() {
  await credentials.deleteGogRefreshToken();
  access = ''; expires = 0;
}
export function invalidateAccessToken() { access = ''; expires = 0; }
export async function accessToken(): Promise<string> {
  if (access && Date.now() < expires - 60000) return access;
  if (pending) return pending;
  pending = (async () => {
    const account = await credentials.getGogRefreshToken();
    if (!account) throw new Error('Connect a GOG account first');
    let refresh: string;
    try { refresh = await exchange('refresh_token', account.refresh); }
    catch (error) {
      if (error instanceof Error && /HTTP (400|401)\)/.test(error.message)) {
        await disconnect();
        throw new Error('GOG session expired. Reconnect your account.');
      }
      throw error;
    }
    await credentials.setGogRefreshToken({ ...account, refresh });
    return access;
  })();
  try { return await pending; } catch (error) { invalidateAccessToken(); throw error; } finally { pending = null; }
}