import { timingSafeEqual } from 'node:crypto';

export function startupConfig(env: Record<string, string | undefined> = process.env) {
  const token = env.GOG_VAULT_SESSION_TOKEN;
  const dataDir = env.GOG_VAULT_DATA_DIR;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Desktop session token is required');
  if (!dataDir) throw new Error('Application data directory is required');
  return { token, dataDir, host: '127.0.0.1' as const, port: 0 };
}

export function validSession(expected: string, provided: string | null): boolean {
  if (!provided || !/^[a-f0-9]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}