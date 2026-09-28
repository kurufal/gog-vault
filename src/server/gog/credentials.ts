import { AsyncEntry } from '@napi-rs/keyring';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../db';

export type StoredAccount = { refresh: string; username: string; userId: string };
type KeyringEntry = Pick<AsyncEntry, 'getPassword' | 'setPassword' | 'deletePassword'>;
export interface CredentialStore {
  getGogRefreshToken(): Promise<StoredAccount | null>;
  setGogRefreshToken(account: StoredAccount): Promise<void>;
  deleteGogRefreshToken(): Promise<void>;
}

function decode(value: string): StoredAccount {
  const account = JSON.parse(value) as StoredAccount;
  if (typeof account.refresh !== 'string' || !account.refresh || typeof account.username !== 'string' || typeof account.userId !== 'string') {
    throw new Error('Saved GOG account is invalid');
  }
  return account;
}

async function legacyAccount(path: string): Promise<StoredAccount | null> {
  let wrapper: any;
  try { wrapper = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!wrapper.encrypted) return decode(JSON.stringify(wrapper));
  const secret = process.env.GOG_VAULT_SECRET_KEY;
  if (!secret) throw new Error('Set the previous GOG_VAULT_SECRET_KEY once to migrate the saved account');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(wrapper.iv, 'base64') }, key, Buffer.from(wrapper.data, 'base64'));
  return decode(new TextDecoder().decode(plaintext));
}

export function createCredentialStore(entry: KeyringEntry, legacyPath: string): CredentialStore {
  let migration: Promise<StoredAccount | null> | undefined;
  const read = async () => {
    const account = await entry.getPassword();
    return account ? decode(account) : null;
  };
  const migrate = async () => {
    const old = await legacyAccount(legacyPath);
    const current = await read();
    if (old) {
      if (current && current.refresh !== old.refresh) throw new Error('Saved GOG account conflicts with OS credential store');
      if (!current) {
        await entry.setPassword(JSON.stringify(old));
        if ((await read())?.refresh !== old.refresh) throw new Error('Could not verify migrated GOG credential');
      }
      await unlink(legacyPath);
    }
    return current || old;
  };
  const ensure = () => migration ??= migrate().catch(error => { migration = undefined; throw error; });
  return {
    async getGogRefreshToken() { await ensure(); return read(); },
    async setGogRefreshToken(account) {
      await ensure();
      await entry.setPassword(JSON.stringify(account));
      if ((await read())?.refresh !== account.refresh) throw new Error('Could not verify saved GOG credential');
    },
    async deleteGogRefreshToken() {
      await ensure();
      await entry.deletePassword();
    }
  };
}

const options = process.platform === 'linux' ? { linux: { store: 'secret-service' as const } } : undefined;
function osEntry(): AsyncEntry {
  try { return new AsyncEntry('app.gogvault.desktop', 'gog-account', options); }
  catch { throw new Error('OS credential store unavailable. Unlock Windows Credential Manager or a Linux Secret Service and retry.'); }
}
export const credentials = createCredentialStore({
  getPassword: () => osEntry().getPassword(),
  setPassword: value => osEntry().setPassword(value),
  deletePassword: () => osEntry().deletePassword()
}, join(configDir, 'account.json'));