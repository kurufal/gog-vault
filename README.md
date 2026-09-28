# GOG Vault

GOG Vault is a Windows x64 and Linux x64 desktop archive manager for offline installers from games you own on GOG. Tauri 2 hosts the React interface; a bundled Bun/TypeScript sidecar handles the GOG API, SQLite, downloads, scanning and checksum verification. No Docker service or separately installed Bun runtime is required to run the packaged app.

## Install and Develop

Use the Windows NSIS installer, Windows portable ZIP, or Linux `.deb`/AppImage produced by the Desktop CI workflow. Extract the portable ZIP before running `gog-vault.exe`; keep `gog-vault-sidecar.exe` beside it. Portable means no installer, not that account/queue settings travel with the ZIP: they live in the Windows user profile. Windows needs WebView2 (present on current Windows 10/11); Linux needs the distribution's WebKitGTK 4.1 runtime. CI binaries are unsigned; Windows may show a SmartScreen warning. Do not run untrusted binaries.

For development, install [Bun](https://bun.sh), [Rust](https://rustup.rs) and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs MSVC C++ Build Tools and WebView2; Ubuntu needs WebKitGTK 4.1, appindicator, OpenSSL and librsvg development packages. Then:

```sh
bun install
bun run dev
```

`bun run dev` compiles the local Bun sidecar and starts Tauri with Vite. `bun run build` compiles the sidecar and packages the native application; `bun run portable` builds the Windows NSIS installer and portable ZIP on Windows x64. `bun run test`, `bun run typecheck`, `bun run build:web` and `bun run sidecar` run individual checks/builds. Tests use Bun's per-file isolation for mocked dependencies. Windows and Linux installers must be built on their respective operating systems. Sidecar binaries are generated and ignored by Git.

## First Use

Open Settings, choose a vault directory on a local disk or mounted network share with the native picker, and connect your GOG account. No archive directory is created until you select one. GOG authentication opens in your default browser. Enter your password and 2FA **only on GOG**; paste the resulting redirect URL or authorization code into GOG Vault. Refresh the library, then scan an existing archive or select installers to download.

The library includes tiles and a compact list, platform/status filters, sorting, download selectors and per-game manifests. Main/DLC/Extras completion is byte-weighted; unselected categories show N/A. The persistent download queue supports pause/resume/cancel, HTTP Range `.part` resumes, retries and checksums. If GOG does not provide checksum metadata, the installer is not downloaded or marked verified. Offline metadata and artwork are stored in each game folder. Selected-content manifest changes indicate available updates; same-name installers from a prior version move into `.gog-vault/previous` only after the replacement verifies. No update starts automatically. A tray icon keeps downloads running after the window is closed; use **Quit** in its menu to stop the app cleanly.

The chosen vault directory is saved as an absolute path in SQLite. A disconnected network share is reported unavailable; GOG Vault does not recreate it, scan it as empty, or start queued downloads until it is accessible again. Files already in the archive are never removed by a scan. For existing folders with names different from the GOG title, use the native picker in game details to link a direct child of the vault. Back up both the chosen vault and the application data directory (including `vault.sqlite`, SQLite WAL files and `account.json`); stop the app for a consistent database copy. New Windows installs use Local AppData; existing Roaming AppData directories continue to be used so upgrades do not hide prior accounts and queues.

For an existing Docker installation, stop the container, copy its `/config` contents into the desktop app data directory, then select the old host-side `/vault` archive with the native picker. Keep the original archive and backup until the desktop library and queue have been checked. Resolve any old relative vault setting by selecting its absolute host path before resuming queued downloads.

## Security and Data

Tauri starts the sidecar on a randomly assigned `127.0.0.1` port with a fresh 256-bit session token. Every HTTP API and queue WebSocket request requires that token; it is sent to the frontend through a Tauri command and is never stored on disk. The built React app is served by Tauri, not by the API. Do not expose the sidecar over a network or reuse its token outside the desktop app.

GOG refresh credentials are stored in a restricted-permission `account.json` under the app data directory. You may set `GOG_VAULT_SECRET_KEY` in the environment to encrypt them with AES-GCM. Keep that key separately from backups: losing it makes the account file unreadable. To enable a key on an existing plaintext installation, disconnect the GOG account first and reconnect after setting the key. An authenticated user can select any directory writable by their OS account, so use only trusted archives and keep backups protected.

GOG Vault is independent and not affiliated with GOG. Download and retain only content your account may access. GOG's APIs can change; the adapter lives in `src/server/gog/` and the included tests use fixtures rather than credentials.