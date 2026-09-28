# GOG Vault

A self-hosted, single-container WebGUI for keeping offline installers for games you own on GOG. GOG Vault inventories the account, compares selected installers, DLC and extras with a server-side archive, and downloads verified files into a persistent vault. It does not download games to the browser's computer.

## Features

- Dashboard with archive counts, free space and recent activity.
- Searchable library with cover tiles or a compact table, platform/status filters, sorting and per-game details.
- Per-game file manifest covering Windows, Linux and macOS installers, DLC, extras and patches where GOG exposes them. Keep alternate versions and select exact files individually.
- Separate byte-weighted Main, DLC and Extras completion. Unselected categories show N/A. Main and selected DLC determine whether a game is Vaulted; extras do not block it.
- Existing-folder matching and manual linking, filesystem scanning, size and checksum verification, offline artwork and metadata in each archived game folder.
- Persistent two-job (configurable) queue with WebSocket updates, pause/resume/cancel, HTTP Range partial-file resumes, retry/backoff and integrity checks before a `.part` file becomes a final installer.
- Explicit update detection based on remote file IDs, sizes, versions, platform and language. Updates are never downloaded automatically; older files are never deleted automatically.

## Quick Start

Requirements: Docker Engine with Compose, outbound HTTPS access to GOG, and writable persistent directories for `/config` and `/vault`.

```sh
cp .env.example .env
docker compose up -d --build
```

Open `http://<docker-host>:3000` (or the configured `WEB_PORT`). The first run starts with an empty library. Go to Settings > GOG Account to connect, then refresh the library. Go to Settings > Storage to choose a directory **inside** the mounted vault and scan existing files.

For local development install Bun, run `bun install`, `bun run build`, then `bun run start` and open `http://localhost:3000`. For hot reload, run `bun run dev` and `bun run dev:web` in separate terminals, then open Vite's port 5173. Set `CONFIG_DIR` and `VAULT_ROOT` to override local `./config` and `./vault` when running outside Docker.

## Choosing Where Games Are Stored

The container sees `/vault`, not arbitrary paths on the Docker host. The **left** side of a volume mapping is a host/TrueNAS path. The **right** side is the path GOG Vault sees inside the container:

```yaml
services:
  gog-vault:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - /mnt/tank/apps/gog-vault/config:/config
      - /mnt/tank/Games/GOG:/vault
```

Those paths are examples, not application defaults. The included Compose file instead uses `${CONFIG_PATH:-./config}` and `${VAULT_PATH:-./vault}`. Set the host-side paths in `.env` before deployment. A Windows PC accessing the WebGUI over the LAN **does not** receive the downloads: the container writes installers directly to the TrueNAS-mounted `/vault` directory. Settings > Storage browses server-side directories beneath `/vault`, never the browser's local filesystem. It cannot browse above `/vault` or create a new Docker host mount; change Compose and recreate the container to change mounts.

For an existing archive, mount the library as `/vault`, refresh owned games, run Scan Vault and check the folder matches. If a folder's title differs, open the game's details and manually link its directory. Scans do not rename, move or delete files. New folders use sanitized game titles; existing directories must be linked or scanned before a download can use them.

## TrueNAS SCALE

Create a Custom App using this repository's Compose definition (or build and push its Docker image, then configure the same port, environment and two host-path mounts in the TrueNAS Custom App form). Map a persistent apps dataset to `/config` and the game archive dataset to `/vault`, as in the example above. Give the container's non-root `bun` user read/write and directory traversal rights on both datasets; for bind-mounted datasets, adjust the dataset ACL/ownership to the image user's UID/GID, or set an appropriate Compose `user:` after checking `id bun` in the image. Do not use a read-only vault. Published port 3000 must be reachable from LAN clients. A health check reports database access, `/config` writability and `/vault` accessibility/writability without requiring internet access.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFIG_PATH` | `./config` | Host directory mapped to `/config` by Compose |
| `VAULT_PATH` | `./vault` | Host directory mapped to `/vault` by Compose |
| `WEB_PORT` | `3000` | Host-side published HTTP port |
| `TZ` | `America/Los_Angeles` in `.env.example` | Container timezone |
| `GOG_VAULT_SECRET_KEY` | empty | Optional encryption key for stored GOG refresh tokens |

Do not change or lose `GOG_VAULT_SECRET_KEY` while an encrypted account is connected: the stored token cannot be recovered with a different key. If adding a key to an existing plaintext installation, disconnect first, then set the key and reconnect. With no key, the refresh token is stored in a restricted-permission file under `/config`; protect the entire config volume and backups.

Settings > Downloads controls concurrency (2 games by default), preferred platform (Windows), language (English), DLC default (on), Extras default (off), retry count and inactivity timeout. The platform/language preferences only set initial selections; a game's manifest still lists all GOG-provided platforms/languages and can be overridden per file. Settings > Appearance supports reduced motion. The library's tile/list choice is persisted.

## Connecting GOG

1. Select **Connect GOG** in Settings. A new tab opens GOG's official authentication page. Enter your password, CAPTCHA and 2FA **only on GOG**.
2. After GOG redirects to its `on_login_success` page, copy the final URL or just the `code` parameter into GOG Vault's field and press **Finish**.
3. The server exchanges the code, verifies the account with `userData.json`, stores the refresh token under `/config`, and refreshes access tokens as needed. The browser never receives the refresh token.
4. Press **Refresh library**. Large refreshes show progress; a failed individual product is logged by product ID and the remainder continues.

Some GOG APIs are community documented and may change without notice. The isolated adapter in `src/server/gog/` uses `embed.gog.com` for owned IDs/account information and `api.gog.com` for expanded product downloads, DLC, artwork and secure downlinks. An account is needed to verify GOG's live responses and any undocumented changes; the tests use fixtures, never credentials.

## Scanning and Downloading

Refresh metadata before scanning so expected files are known. Scan Vault matches normalized game titles or saved product-ID mappings, resolves current filenames where possible, compares sizes, and checks GOG checksum XML when available. An unavailable checksum response will not count as verified. Offline scans can still inspect cached filenames and sizes when the downlink cannot be resolved. Archives written by GOG Vault include `.gog-vault/metadata.json`, `manifest.json` and downloaded cover/background artwork, so archived artwork survives a lost config database. Restore the config backup to retain folder mappings, selections and queue state.

In a game detail view, press **Query GOG** or **Refresh metadata** to update available files, then select the desired main installers, DLC, extras and patches. Download Selected queues only selected files not marked verified. The downloader resolves signed CDN URLs again on retry, streams chunks to `filename.part`, resumes via Range, checks expected size and available full-file/chunk MD5 hashes, and renames only on successful verification. It refuses to overwrite an existing installer that fails verification. Failed jobs retain their partials for diagnosis/retry. Restarted active jobs return to queued and resume; completed jobs remain in history. Pause, resume and cancel are available in the right-side queue from every page.

Updates are detected during metadata refresh when the remote manifest changes after an archived version has been recorded. Review and select the replacement files, download and verify them before considering any old copies for manual removal. GOG Vault never deletes older files automatically. No scheduled refreshes or automatic updates are provided in v1.

## Maintenance

To update the application, back up `/config` and `/vault`, pull the latest code, and run `docker compose up -d --build`. SQLite migrations run on startup. Back up all of `/config` (including SQLite WAL files if copying live; preferably stop the container or use SQLite's backup API) and the full `/vault` archive. Store the optional encryption key separately from those backups.

Run `bun test`, `bun run typecheck`, `bun run build`, `docker compose config` and `docker compose build` after changes. `GET /api/health` returns HTTP 503 if local database or volume checks fail.

## Troubleshooting

- **Health check fails:** check the mounted volume paths and ACLs for the container user; both `/config` and `/vault` must be writable.
- **Empty library:** finish GOG connection, then refresh; inspect product-ID warnings in container logs if some products fail.
- **No matching folder:** link the existing folder manually from the game's details, or rename neither data nor mapping automatically.
- **Checksum failure:** inspect the `.part` file and available disk space; a failed verification never marks the installer complete. A stale signed URL is resolved again on retry.
- **Download refused for existing file:** use Scan/Verify and investigate the mismatch; GOG Vault intentionally does not replace user files.
- **Connection changes or expired authorization code:** repeat Connect GOG; do not paste passwords or tokens into issue reports.

## Security Notes

GOG Vault has no separate app login. It is designed for a trusted LAN, **not direct public internet exposure**. Anyone who can reach its HTTP API can control downloads and account connection; put an authenticated reverse proxy/VPN in front if remote access is necessary. The app binds to `0.0.0.0` inside the container. Auth codes, tokens and cookies are not logged. Keep `/config` private, keep backups protected, and do not expose the Docker socket. Filesystem browsing and writes remain beneath the selected vault root; remote filenames are rejected if unsafe. Do not mount untrusted shared folders writable by other processes when archiving.

GOG Vault is an independent tool and is not affiliated with GOG. Download and retain only content your account is entitled to access.