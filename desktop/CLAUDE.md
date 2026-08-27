# Working agreements for desktop/

The macOS SPAWN D app. It is a Tauri v2 app with one window and two faces
for it: a local wizard that signs you in, installs the daemon and possesses
this Mac, and then the product itself — the web app from the chosen server,
loaded into that same window, already signed in. Launching the app opens
whichever face is current, like any app; closing the window leaves SPAWN D
in the menu bar. Read the repo root `CLAUDE.md` first.

## Layout

```
src/             bundled vanilla HTML, TypeScript and CSS; never remote code
  assets/        vendored brand art and the two brand faces
    fonts/       IBM Plex Sans and Rowdies, latin subsets, with their OFL
src-tauri/
  src/           Rust commands, API client, trust ceremonies, the one window
                 and its two faces (window.rs) and the tray shell
  capabilities/  least-privilege Tauri capability declarations; they name the
                 window, never a remote URL, so the product page has no IPC
  dmg/           the disk image's window: background.html is the source,
                 render.mjs prints it to background.png at 2× / 144 dpi
  icons/         icon.icns / icon.png (bundle) and tray.png / tray@2x.png
  Cargo.toml     standalone crate; links ../../daemon as a library
  tauri.conf.json
  tauri.ci.conf.json  release-only DMG target override
```

## The wizard is the browser's funnel, printed locally

Someone signs up in the browser and installs this app an hour later. It has to
read as one product, so the wizard is the web's own account surface restated,
not a cousin of it:

- The screens are `/login` and `/signup` (`web/src/app/{login,signup}`), then
  the onboarding gates in the browser's order — account, verify, host, done
  (`web/src/components/onboarding/{step-machine,onboarding-flow}.tsx`) — with
  one gate the browser never needs, the device approval, slotted in only when
  the account already has a device. Copy is the web's copy; where this app does
  something the browser cannot (install the daemon itself), the words say so.
- Sign-in options come from `GET /api/auth/config` at sign-in time, never from
  a list in the app: providers in the server's order, the invite field only on
  an invite-only server, the verify gate only when the server will enforce it.
- OAuth goes out to the system browser and comes back on `spawn://auth/oauth`,
  the one native redirect every server release admits (the phone uses the same
  one). A native `error=invite_required` shows the invite field, as the browser
  does.
- `src/styles.css` is `web/src/components/onboarding/auth-shell.tsx` and the
  `.pressroom` rules in `web/src/app/globals.css` in plain CSS — the altar
  plate under the same scrim, the stacked column for sign-in, the split
  masthead for the gates, the bone slab, the hairline plate. When one of those
  changes, this follows.

Once this Mac is possessed the product is the web app, and the window becomes
it (`src-tauri/src/window.rs`): the same window navigates to the chosen
origin, the wizard's session becomes the browser session by way of the cookie
the server sets on renewal, the page gets no IPC, and any navigation off the
origin — or any `window.open` — goes to the system browser. Settings, repair
and update turn the window back into the wizard, carrying the surface in the
URL hash, and leaving them turns it back into the product. There is never a
second window; a second copy of the app (single-instance) fronts the first
and exits. Nothing of the web build is bundled here, so the app can never
drift from the server it talks to.

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
npm run dmg:background      # after editing src-tauri/dmg/background.html
cd src-tauri && cargo fmt && cargo build && cargo test && cargo clippy -- -D warnings
```

The wizard can be driven in a plain browser by faking the Tauri bridge
(`window.__TAURI_INTERNALS__`) under Vite with `root` set to this folder — the
way its screens are reviewed without a build; see the memory note on the
desktop screenshot harness.

For the beta updater channel, build with
`cargo tauri build --features beta-updates --config
src-tauri/tauri.beta.conf.json`. Signing,
notarization and publication are release operations; read `docs/RELEASE.md`
in full before attempting any of them.
