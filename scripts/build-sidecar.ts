import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const targets = {
  win32: { bun: 'bun-windows-x64', rust: 'x86_64-pc-windows-msvc', extension: '.exe' },
  linux: { bun: 'bun-linux-x64', rust: 'x86_64-unknown-linux-gnu', extension: '' }
} as const;
const target = targets[process.platform as keyof typeof targets];
if (!target || process.arch !== 'x64') throw new Error('Only Windows x64 and Linux x64 are supported');
const directory = join('src-tauri', 'binaries');
mkdirSync(directory, { recursive: true });
const result = Bun.spawnSync([process.execPath, 'build', 'src/server/index.ts', '--compile', `--target=${target.bun}`,
  `--outfile=${join(directory, `gog-vault-sidecar-${target.rust}${target.extension}`)}`], { stdout: 'inherit', stderr: 'inherit' });
if (result.exitCode !== 0) process.exit(result.exitCode);