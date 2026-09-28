const bundles = process.platform === 'win32' ? 'nsis' : process.platform === 'linux' ? 'deb,appimage' : null;
if (!bundles || process.arch !== 'x64') throw new Error('Only Windows x64 and Linux x64 are supported');
const result = Bun.spawnSync([process.execPath, 'x', 'tauri', 'build', '--bundles', bundles], { stdout: 'inherit', stderr: 'inherit' });
if (result.exitCode !== 0) process.exit(result.exitCode);