import { createServer } from 'vite';

const sidecar = Bun.spawnSync([process.execPath, 'run', 'sidecar'], { stdout: 'inherit', stderr: 'inherit' });
if (sidecar.exitCode !== 0) process.exit(sidecar.exitCode);

const vite = await createServer({ server: { strictPort: true } });
try {
  await vite.listen();
  vite.printUrls();
  const tauri = Bun.spawn([process.execPath, 'x', 'tauri', 'dev'], {
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
  });
  const exitCode = await tauri.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await vite.close();
}