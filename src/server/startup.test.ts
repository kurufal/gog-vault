import { expect, test } from 'bun:test';
import { startupConfig, validSession } from './startup';

const token = 'ab'.repeat(32);
test('desktop backend requires a random-looking session token and app data directory', () => {
  expect(startupConfig({ GOG_VAULT_SESSION_TOKEN: token, GOG_VAULT_DATA_DIR: 'C:\\Users\\Owner\\AppData\\Local\\GOG Vault' })).toMatchObject({ host: '127.0.0.1', port: 0 });
  expect(() => startupConfig({ GOG_VAULT_DATA_DIR: 'data' })).toThrow();
  expect(() => startupConfig({ GOG_VAULT_SESSION_TOKEN: token })).toThrow();
});
test('desktop session comparison rejects missing and altered tokens', () => {
  expect(validSession(token, token)).toBe(true);
  expect(validSession(token, 'cd'.repeat(32))).toBe(false);
  expect(validSession(token, null)).toBe(false);
});