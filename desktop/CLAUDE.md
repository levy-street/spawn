# Working agreements for desktop/

The macOS SPAWN D companion. It is a Tauri v2, menu-bar-only app: a small
local wizard installs and possesses the current Mac, while the browser remains
the place where people run sessions. Read the repo root `CLAUDE.md` first.

## Layout

```
src/             bundled vanilla HTML, TypeScript and CSS; never remote code
src-tauri/
  src/           Rust commands, API client, trust ceremonies and tray shell
  capabilities/  least-privilege Tauri capability declarations
  icons/         bundle assets when release artwork is added
  Cargo.toml     standalone crate; links ../../daemon as a library
  tauri.conf.json
  tauri.ci.conf.json  release-only DMG target override
```

## Where things go

- UI state and rendering stay in `src/`; keep dependencies to the vanilla
  Tauri template and do not add a component framework.
- Network, process, keychain, filesystem and cryptographic work belongs in
  Rust commands under `src-tauri/src/`. Pure contract logic gets a Rust unit
  test beside it.
- The app token and Ed25519 seed use the macOS keychain (`keyring`, service
  `spawn`). Non-secret preferences may use the local desktop state file.
- The chosen control-plane origin applies to auth, daemon install and daemon
  status. App updates always use the independently signed spawnd.dev channel.
- Never bundle or load `spawnd` in the app. Download and verify both daemon
  binaries from the chosen server, install them to `~/.local/bin`, then let
  the daemon own its service and updates.

## Commands

```bash
npm install
cargo tauri dev
cargo tauri build
cd src-tauri && cargo fmt && cargo build && cargo test && cargo clippy -- -D warnings
```

For the beta updater channel, build with
`cargo tauri build --features beta-updates --config
src-tauri/tauri.beta.conf.json`. Signing,
notarization and publication are release operations; read `docs/RELEASE.md`
in full before attempting any of them.
