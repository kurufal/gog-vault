# GOG Vault

GOG Vault is a Windows x64 and Linux x64 desktop archive manager for offline installers from games you own on GOG. Tauri 2 hosts the React interface; a bundled Bun/TypeScript sidecar handles the GOG API, SQLite, downloads, scanning and checksum verification. No Docker service or separately installed Bun runtime is required to run the packaged app.

## Install and Develop

Use the Windows NSIS installer or Linux `.deb`/AppImage produced by the Desktop CI workflow. Windows needs WebView2 (present on current Windows 10/11); Linux needs the distribution's WebKitGTK 4.1 runtime. Installers built on CI are unsigned. Do not run untrusted binaries.

For development, install [Bun](https://bun.sh), [Rust](https://rustup.rs) and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs MSVC C++ Build Tools and WebView2; Ubuntu needs WebKitGTK 4.1, appindicator, OpenSSL and librsvg development packages. Then:

```sh
bun install
bun run dev
```

`bun run dev` compiles the local Bun sidecar and starts Tauri with Vite. `bun run build` compiles the sidecar and packages the native application; `bun test`, `bun run typecheck`, `bun run build:web` and `bun run sidecar` run the individual checks/builds. Windows and Linux installers should be built on their respective operating systems. Sidecar binaries are generated and ignored by Git.

## First Use

Open Settings, choose a vault directory on a local disk or mounted network share with the native picker, and connect your GOG account. GOG authentication opens in your default browser. Enter your password and 2FA **only on GOG**; paste the resulting redirect URL or authorization code into GOG Vault. Refresh the library, then scan an existing archive or select installers to download. The default archive, before a directory is chosen, is the `vault` subdirectory of the application's data directory.

The library includes tiles and a compact list, platform/status filters, sorting, download selectors and per-game manifests. Main/DLC/Extras completion is byte-weighted; unselected categories show N/A. The persistent download queue supports pause/resume/cancel, HTTP Range `.part` resumes, retries and checksums. Offline metadata and artwork are stored in each game folder. Remote manifest changes indicate available updates, but never delete or download old/new installers automatically. A tray icon keeps downloads running after the window is closed; use **Quit** in its menu to stop the app.

The chosen vault directory is saved as an absolute path in SQLite. A disconnected network share is reported unavailable; GOG Vault does not recreate it, scan it as empty, or start queued downloads until it is accessible again. Files already in the archive are never removed by a scan. For existing folders with names different from the GOG title, link the folder from game details. Back up both the chosen vault and the application data directory (including `vault.sqlite`, SQLite WAL files and `account.json`); stop the app for a consistent database copy.

For an existing Docker installation, stop the container, copy its `/config` contents into the desktop app data directory, then select the old host-side `/vault` archive with the native picker. The picker replaces any older relative vault setting with an absolute path. Keep the original archive and backup until the desktop library and queue have been checked.

## Security and Data

Tauri starts the sidecar on a randomly assigned `127.0.0.1` port with a fresh 256-bit session token. Every HTTP API and queue WebSocket request requires that token; it is sent to the frontend through a Tauri command and is never stored on disk. The built React app is served by Tauri, not by the API. Do not expose the sidecar over a network or reuse its token outside the desktop app.

GOG refresh credentials are stored in a restricted-permission `account.json` under the app data directory. You may set `GOG_VAULT_SECRET_KEY` in the environment to encrypt them with AES-GCM. Keep that key separately from backups: losing it makes the account file unreadable. To enable a key on an existing plaintext installation, disconnect the GOG account first and reconnect after setting the key. An authenticated user can select any directory writable by their OS account, so use only trusted archives and keep backups protected.

GOG Vault is independent and not affiliated with GOG. Download and retain only content your account may access. GOG's APIs can change; the adapter lives in `src/server/gog/` and the included tests use fixtures rather than credentials.