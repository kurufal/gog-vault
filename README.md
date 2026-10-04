# GOG Vault

Windows x64 desktop app for archiving offline installers from games you own on GOG. Built with Tauri, React and a bundled Bun sidecar.

## Download

Download the [Windows x64 installer](downloads/GOG%20Vault_0.1.0_x64-setup.exe) or [portable ZIP](downloads/GOG-Vault-windows-x64-portable.zip) from this repository (on GitHub, use **Download raw file**). No [Releases](https://github.com/kurufal/gog-vault/releases) are published yet. For source, use [Code > Download ZIP](https://github.com/kurufal/gog-vault) or `git clone https://github.com/kurufal/gog-vault.git`. Do not run binaries from untrusted sources.

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