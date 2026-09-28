import { accessToken, invalidateAccessToken } from './auth';
import { endpoints } from './types';

export { endpoints } from './types';
export async function gogRequest<T = unknown>(url: string, authenticated = true): Promise<T> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !Object.values(endpoints).some(base => target.origin === base)) throw new Error('Untrusted GOG endpoint');
  const request = async () => {
    const token = authenticated ? await accessToken() : '';
    return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30000) });
  };
  let response = await request();
  if (authenticated && response.status === 401) {
    invalidateAccessToken();
    response = await request();
  }
  if (!response.ok) throw new Error(`GOG ${target.pathname} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}