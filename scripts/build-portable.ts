import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable packaging requires Windows x64');
const release = resolve('src-tauri', 'target', 'release');
const output = join(release, 'bundle', 'portable');
const stage = join(output, 'GOG Vault');
await mkdir(stage, { recursive: true });
await copyFile(join(release, 'gog-vault.exe'), join(stage, 'gog-vault.exe'));
await copyFile(resolve('src-tauri', 'binaries', 'gog-vault-sidecar-x86_64-pc-windows-msvc.exe'), join(stage, 'gog-vault-sidecar.exe'));
const archive = join(output, 'GOG-Vault-windows-x64-portable.zip');
const quote = (path: string) => path.replaceAll("'", "''");
const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${quote(stage)}\\*' -DestinationPath '${quote(archive)}' -Force`], { stdout: 'inherit', stderr: 'inherit' });
if (result.exitCode !== 0) throw new Error(`Portable ZIP failed (exit ${result.exitCode})`);
console.log(archive);