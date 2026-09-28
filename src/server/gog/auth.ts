import { readFile, writeFile, unlink, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../db';
import { endpoints } from './types';

const clientId = '46899977096215655';
const clientSecret = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const redirect = 'https://embed.gog.com/on_login_success?origin=client';
const file = join(configDir, 'account.json');
type Stored = { refresh: string; username: string; userId: string };
let access = '';
let expires = 0;
let pending: Promise<string> | null = null;

export const loginUrl = `${endpoints.auth}/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', layout: 'client2' })}`;
export function parseCode(input: string): string {
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    const url = new URL(code);
    if (url.protocol !== 'https:' || !['www.gog.com', 'embed.gog.com'].includes(url.hostname) || url.pathname !== '/on_login_success') throw new Error('Not a GOG login success URL');
    code = url.searchParams.get('code') || '';
  }
  if (!/^[A-Za-z0-9_-]{12,512}$/.test(code)) throw new Error('Invalid authorization code');
  return code;
}
async function key(): Promise<CryptoKey | null> {
  const secret = process.env.GOG_VAULT_SECRET_KEY;
  if (!secret) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function load(): Promise<Stored | null> {
  try {
    const wrapper = JSON.parse(await readFile(file, 'utf8'));
    const cipher = await key();
    if (wrapper.encrypted) {
      if (!cipher) throw new Error('GOG_VAULT_SECRET_KEY is required to read the saved account');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(wrapper.iv, 'base64') }, cipher, Buffer.from(wrapper.data, 'base64'));
      return JSON.parse(new TextDecoder().decode(plain)) as Stored;
    }
    if (cipher) throw new Error('Saved account is unencrypted; disconnect and reconnect with the secret key');
    return wrapper as Stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function save(account: Stored) {
  const cipher = await key();
  let contents: unknown = account;
  if (cipher) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cipher, new TextEncoder().encode(JSON.stringify(account)));
    contents = { encrypted: true, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') };
  }
  await writeFile(file + '.tmp', JSON.stringify(contents), { mode: 0o600 });
  await chmod(file + '.tmp', 0o600);
  await rename(file + '.tmp', file);
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
  const refresh = await exchange('authorization_code', parseCode(input));
  const response = await fetch(`${endpoints.embed}/userData.json`, { headers: { Authorization: `Bearer ${access}` } });
  if (!response.ok) throw new Error('GOG account verification failed');
  const user = await response.json() as Record<string, unknown>;
  if (user.isLoggedIn !== true || typeof user.username !== 'string') throw new Error('GOG account verification failed');
  await save({ refresh, username: user.username, userId: String(user.userId || '') });
  return { username: user.username };
}
export async function accountInfo() {
  const account = await load();
  return { connected: !!account, username: account?.username || '' };
}
export async function disconnect() {
  access = ''; expires = 0;
  await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
export async function accessToken(): Promise<string> {
  if (access && Date.now() < expires - 60000) return access;
  if (pending) return pending;
  pending = (async () => {
    const account = await load();
    if (!account) throw new Error('Connect a GOG account first');
    const refresh = await exchange('refresh_token', account.refresh);
    await save({ ...account, refresh });
    return access;
  })();
  try { return await pending; } finally { pending = null; }
}