# Working agreements for desktop/

The macOS SPAWN D companion. It is a Tauri v2, menu-bar-only app: a small
local wizard installs and possesses the current Mac, while the browser remains
the place where people run sessions. Read the repo root `CLAUDE.md` first.

## Layout

```
src/             bundled vanilla HTML, TypeScript and CSS; never remote code
  assets/        vendored brand art and the two brand faces
    fonts/       IBM Plex Sans and Rowdies, latin subsets, with their OFL
src-tauri/
  src/           Rust commands, API client, trust ceremonies and tray shell
  capabilities/  least-privilege Tauri capability declarations
  icons/         icon.icns / icon.png (bundle) and tray.png / tray@2x.png
  Cargo.toml     standalone crate; links ../../daemon as a library
  tauri.conf.json
  tauri.ci.conf.json  release-only DMG target override
```

## The app wears the product's brand, not its own

Someone signs up in the browser and installs this app an hour later. It has to
read as one product, so `src/styles.css` is the web's brand system restated in
plain CSS, not an approximation of it: the grimoire palette and the pressroom's
control voice from `web/src/app/globals.css`, and the altar plate and press
furniture from `web/src/components/onboarding/auth-shell.tsx` and
`web/src/components/brand/press.tsx`. When one of those changes, this follows.

The rules that palette carries are load-bearing:

- Hellfire (`#e11e15`) is the accent — a rule, a mark, a hover. It is never a
  button ground; the primary action is always the bone slab on the void.
- One ink means one affirmative. There is no green and no blue: "complete",
  "online" and "verified" all read in ember, and the words carry the rest.
- Display type is Rowdies Light, set in caps; body is IBM Plex Sans; every
  control, label, eyebrow and number is the sigil monospace, letterspaced.

The marks are the real art vendored from `web/public/brand/`, never redrawn:
the trident is painted hellfire, and the wordmark is unpainted and worn as a
CSS mask so it takes its call site's ink. Both faces and the altar plate are
vendored beside them — the app never fetches a font or an image.

`src-tauri/icons/` is generated from that same trident: `icon.icns` /
`icon.png` are the mark on its hellfire ground, cut to the macOS icon grid;
`tray.png` / `tray@2x.png` are black-on-alpha and handed to macOS with
`icon_as_template(true)`, which is the only correct way to wear a logo in the
menu bar.

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
