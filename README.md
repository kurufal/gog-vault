# GOG Vault

Windows x64 desktop app for archiving offline installers from games you own on GOG. Built with Tauri, React and a bundled Bun sidecar.

## Library Shelves

The Library's **Collection / Products** toggle switches between GOG's account shelf (excluding products hidden on GOG) and all owned product IDs, including DLC, bonus products, and edition wrappers. Collection membership is cached per account and synced by **Refresh library**, or automatically when first opening an unsynced Collection. A failed shelf refresh retains the previous snapshot and displays a warning. Local visibility, search, and platform filters can reduce the displayed count; collection entries without product metadata are reported separately. Switching shelves does not change vault folders, file ownership, or download selections.

## Editions And Bundles

Library status toggles combine selected statuses; **All** clears the status selection, and removing the last selected status returns to All. **Show Hidden** and **Additional Details** are saved independently of status filters. Additional Details expands tiles and list rows with size on disk and archived image/video counts for the current vault; external video links are identified separately and do not add a video downloader. Selected controls use a gently swinging gradient border that respects reduced-motion settings. Dashboard tiles open the Products library with the corresponding status selected, clearing search and system filters without changing either display option.

Library and per-product metadata refreshes read GOG's explicit inclusion links. Product details show **Includes** and **Included In** separately from DLC relationships. Downloading an edition queues missing selected files from its owned included products, including nested packs, once per product. Existing verified base-game files contribute to every edition that includes that product; an edition is only complete when its selected included content is verified in the current vault. Bulk previews count shared files once. Missing manifests, unavailable members, cyclic links, or failed inclusion refreshes prevent a false complete result; failed refreshes retain the last known links and display a warning. No folders are moved and no files are copied to edition wrappers.

Pack completion is recalculated from linked products as their files verify, and an open pack detail view refreshes when a child job changes. Fileless packs with missing or failed inclusion metadata receive a deduplicated background relationship check when the Library loads or a download completes. Checks run one at a time and failures back off for five minutes; they do not download installers or perform a full library refresh.

## GOG Product Types

Store-media downloads are selected by **Images** and **Videos** categories rather than individual files. Images includes artwork, icons, posters, and screenshots. Existing renamed artwork is reconciled from its saved source mapping and known hash when the Library loads, without re-downloading it. External video links remain open-only; no yt-dlp downloader is included. Additional Details shows both size on disk and remote size alongside archive counts.

The exact `game_type` supplied by GOG is preserved and shown as **GOG TYPE** in product details. Confirmed values are `game`, `dlc`, and `pack`; GOG packs use a **PACK** badge and the app's existing internal bundle behavior. These observed values are not treated as an exhaustive API contract: unfamiliar values are retained verbatim with an internal unknown classification. Legacy fields and title/slug heuristics are only fallbacks when no source type has been retrieved, and DLC relationship backfills cannot override a known GOG type. Bonus downloads and inclusion relationships remain separate from product type. Refresh product metadata or the library to populate source types on existing records.

## Download

Activity entries expand to show queue/start/finish timestamps, elapsed time, and every queued file's name, size, state, and progress bar. Download and import file histories come from their saved job snapshots rather than the current product manifest; verification history remains session-only. A job waiting for its first transfer displays **Waiting in queue**. Start times were not saved by older versions, so their elapsed time remains **Unavailable** rather than being guessed from queue time. Rebuild and restart the sidecar when developing backend changes; frontend hot reload does not update the queue API or apply database migrations. Hover artwork remains available when an entry is collapsed, and clicking an entry no longer latches its hover tint.

Settings > Downloads > **Simultaneous downloads** sets the transfer limit from 1 to 8. Verification releases a transfer slot so another queued game can download; at most one extra game may be active beyond the transfer limit. Multipart installers remain ordered within a game and each part verifies before the next part starts. Returning jobs reacquire a slot before transferring again. Checksum or size failures discard the corrupt `.part` and retry within the configured **Retries** limit; exhausted attempts stop with an error rather than looping forever. Existing completed files and prior installers are retained. Pause, resume, cancel, and shutdown also apply while a job waits for a transfer slot.

The main page and nested panes use simple solid-color scrollbars. Scroll limits in navigation, Activity, game details, dialogs, and nested lists do not chain into the page behind them. Open overlays lock background scrolling; a closed Activity drawer is hidden and cannot intercept input along the right edge.

Download the [Windows x64 installer](downloads/GOG%20Vault_0.2.0_x64-setup.exe) or [portable ZIP](downloads/GOG-Vault-windows-x64-portable.zip) from this repository (on GitHub, use **Download raw file**). No [Releases](https://github.com/kurufal/gog-vault/releases) are published yet. For source, use [Code > Download ZIP](https://github.com/kurufal/gog-vault) or `git clone https://github.com/kurufal/gog-vault.git`. Do not run binaries from untrusted sources.

## Build for Windows

On Windows x64, install [Bun](https://bun.sh/docs/installation), [Rust with the MSVC toolchain](https://rustup.rs/), and [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows): Visual Studio Build Tools with **Desktop development with C++** and the Windows SDK, plus the WebView2 runtime. Open a new PowerShell window after installation, then from the extracted or cloned repository root run:

```powershell
bun.cmd install --frozen-lockfile
bun.cmd run typecheck
bun.cmd run test
bun.cmd run build
```

`bun.cmd run build` compiles the Bun sidecar, builds the web UI and Rust application, and creates the NSIS installer at `src-tauri/target/release/bundle/nsis/GOG Vault_0.1.0_x64-setup.exe` (the version changes with the project version). Run that installer to install the app. To also build a portable ZIP, run `bun.cmd run portable`; extract `src-tauri/target/release/bundle/portable/GOG-Vault-windows-x64-portable.zip` and keep `gog-vault.exe` and `gog-vault-sidecar.exe` together.

Build outputs under `src-tauri/target/` are ignored by Git. The linked binaries above are copies in `downloads/`; after rebuilding, copy new outputs there if you intend to update the downloadable files.

Self-built binaries are unsigned. Windows may warn about them, and managed Windows application-control policies can block the sidecar even after a successful build; use an approved signed build or ask your administrator to approve it. Do not bypass device security policy.

See [NOTES.md](NOTES.md) for first-use, data, and development details.