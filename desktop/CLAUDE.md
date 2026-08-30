# Working agreements for desktop/

The macOS and Windows SPAWN D desktop companion. It is a Tauri v2 app with one window and two faces
for it: a local wizard that signs you in, installs the daemon and possesses
this computer, and then the product itself — the web app from the chosen server,
loaded into that same window, already signed in. Launching the app opens
whichever face is current, like any app; closing the window leaves SPAWN D
in the menu bar on macOS or the system tray on Windows. Read the repo root
`CLAUDE.md` first.

## Layout

```
src/             bundled vanilla HTML, TypeScript and CSS; never remote code
  assets/        vendored brand art and the two brand faces
    fonts/       IBM Plex Sans and Rowdies, latin subsets, with their OFL
src-tauri/
  src/           Rust commands, API client, trust ceremonies, the one window
                 and its two faces (window.rs) and the tray shell
    install/      OS-specific verified daemon installation and update handoff
    supervision/ OS-specific launchd / Task Scheduler diagnostics and log tail
    window/       Windows WebView2 integration; common navigation stays in window.rs
  capabilities/  least-privilege Tauri capability declarations; they name the
                 window, never a remote URL, so the product page has no IPC
  dmg/           the disk image's window: background.html is the source,
                 render.mjs prints it to background.png at 2× / 144 dpi
  icons/         icon.html is the macOS bundle-art source; render.mjs emits
                 icon.png / icon.icns plus multi-size Windows ICO/PNG assets
  Cargo.toml     standalone crate; links ../../daemon as a library
  tauri.conf.json
  tauri.ci.conf.json  release-only DMG target override
  tauri.dev.conf.json ad-hoc-signed macOS targets for local runs
  tauri.windows.conf.json  automatic Windows NSIS/current-user override
```

## The wizard is the browser's funnel, printed locally

Someone signs up in the browser and installs this app an hour later. It has to
read as one product, so the wizard is the web's own account surface restated,
not a cousin of it:

- The screens are `/login` and `/signup` (`web/src/app/{login,signup}`), then
  the onboarding gates in the browser's order — account, verify, host, done
  (`web/src/components/onboarding/{step-machine,onboarding-flow}.tsx`) — plus
  the two only a native app needs: the device approval, when the account
  already has another device, and the permissions gate between Approved and
  Online, where macOS is about to ask. Copy is the web's copy; where this app
  does something the browser cannot (install the daemon itself), the words say
  so.
- A screen earns its place by preceding something the person will otherwise
  meet unexplained. The permissions gate does: three system dialogs follow it
  on macOS. Secret storage does not prompt on either platform and is not a
  wizard step. Do not add a screen for something nobody has to answer.
- Where the browser has to ask, this app already knows, so it does not ask
  twice. The host gate possesses on arrival rather than offering a button — it
  holds the account, it runs the install, and it matches the daemon's key
  itself — and the done gate opens the product on its own. A press that only
  confirms what is already happening is not a choice. What is still a choice
  keeps its buttons: the permissions gate, and every failure card.
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

Once this computer is possessed the product is the web app, and the window becomes
it (`src-tauri/src/window.rs`): the same window navigates to the chosen
origin, the wizard's session becomes the browser session by way of the cookie
the server sets on renewal, the wizard's device becomes the page's device (the
third contract below), the page gets no IPC, and any navigation off the
origin — or any `window.open` — goes to the system browser. Settings, repair
and update turn the window back into the wizard, carrying the surface in the
URL hash, and leaving them turns it back into the product. There is never a
second window; a second copy of the app (single-instance) fronts the first
and exits. Nothing of the web build is bundled here, so the app can never
drift from the server it talks to.

Four things about that face are contracts with `web/`, not implementation
details:

- The webview's user agent ends in `SpawnDesktop/<version>`, and the web app
  reads it (`web/src/lib/platform.ts`, `web/src/hooks/useDesktopShell.ts`) to
  drop the chrome that would walk someone out of the product and into the
  marketing site — there is no address bar in here and no way back. It rides
  the agent because that survives every navigation the product makes; a query
  parameter does not.
- The session cookie handed to the webview must never state `Secure` unless it
  is one. wry writes the flag into `NSHTTPCookieSecure` whenever it is *set*,
  and CFNetwork reads the **presence** of that key as "secure" whatever value
  it carries — so marking a cookie explicitly not-secure on an `http` server
  minted a Secure cookie the store kept and never sent, and the product opened
  signed out on every local run. Reading the store back does not reveal it
  either: `cookies_for_url` filters wry's own list and waves a Secure cookie
  through on `localhost`. If a session still will not land, `window.rs` clears
  the stored one — a page cannot overwrite an `HttpOnly` cookie — and has the
  page carry it instead.
- The page is this app's device. One computer is one device: this app
  registered as "SPAWN D on Mac", it possessed this computer — the daemon
  pins its key — and it published the hosts it possessed under that key. A
  web app minting a device of its own inside this window would be a stranger
  to all of that, unapproved in every roster and refused by the host. So on
  the way into the product `window.rs` leaves the app's Ed25519 identity —
  account, device id, public key, seed — in the origin's `sessionStorage`
  under `spawn.desktop-device.v1`, and the web app takes it exactly once,
  under this user agent only, before it registers as anything
  (`web/src/lib/desktop-device-handover.ts`), replacing any identity the page
  minted for itself and retiring that device's roster row. The hosts this app
  possessed then arrive trusted on the app's own signed introductions. The key
  travels in-process only; the server never sees it and could not have forged
  the handover.
- Dropping a file on this window is the page's gesture, not the shell's, so
  the window is built with `disable_drag_drop_handler()`. Left alone, Tauri
  answers the OS itself and forwards the paths over IPC — and forwarding is
  all it does: the drag is swallowed, `dragenter` and `drop` never reach the
  page, and every drop target in the product goes dead. Dragging a screenshot
  onto a terminal is ordinary in a browser tab and did nothing whatsoever in
  here. There is nothing on this side to receive those paths anyway — the
  product page has no IPC by design — and the files are the page's to read and
  upload exactly as a tab does. WebView2 needs this to see HTML5 drag and drop
  at all; WKWebView falls back to its own native handling without it.

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
`icon.png` are the mark on its hellfire ground, cut to the macOS icon grid,
and `npm run icons` prints both from `icons/icon.html` — the plate's geometry
and the mark's fit live there, in CSS, and the mark is fitted by its *ink*
rather than its viewBox, so it can be resized or shifted without hand-editing
a PNG. The newly rendered 1024 px `icon.png` is also the Windows colour
master: the same command emits the black-on-alpha macOS `tray.png` /
`tray@2x.png`, multi-size `icon.ico`, `tray-windows.ico`, the Windows tray
layers and the 32/64 px runtime tray PNGs. `npm run icons:check` proves every
committed output is current without rewriting it. The ICNS holds exactly the
members `iconutil` writes — PNG from 128 px up, Apple's ARGB run-length form at
16 and 32 px. IconServices reads a PNG in those two slots as raw pixels, which
is how the app once wore coloured noise in Login Items and the Dock's menu while
Finder's big icon looked right; `iconutil -c iconset` on the file is the check. The macOS tray images use
`icon_as_template(true)`, which is the only correct way to wear a logo in the
menu bar; Windows uses the generated colour tray and never template mode.

## Where things go

- UI state and rendering stay in `src/`; keep dependencies to the vanilla
  Tauri template and do not add a component framework.
- Network, process, secret storage, filesystem and cryptographic work belongs in
  Rust commands under `src-tauri/src/`. Pure contract logic gets a Rust unit
  test beside it.
- **This app never uses Keychain, Credential Manager or `keyring`.** The
  session token and Ed25519 device seed live in `credentials.json` beside the
  preferences, written through `spawnd::secret_file` — the same atomic write,
  no-follow open, cross-process lock and platform access checks the daemon uses
  for its own, more powerful credentials. Unix gets a user-owned mode-0600
  file; Windows gets a current-user-only DACL. `dirs::config_dir` maps the same
  `dev.spawnd.desktop` support directory to Application Support on macOS and
  `%APPDATA%` on Windows. Non-secret preferences stay in `state.json`.

  The trade is real and is argued in the `storage.rs` module comment rather
  than assumed. If you are tempted to put a secret back in an OS vault, read
  and update that comment first — do not leave it stale. There is deliberately
  no vault migration or launch-time vault read: the app must never prompt for
  one, block on one, or inherit a platform-specific credential size limit.

- The chosen control-plane origin applies to auth, daemon install and daemon
  status. App updates always use the independently signed spawnd.dev channel.
- Never bundle or load `spawnd` in the app. Download and verify both daemon
  binaries from the chosen server. Fresh installs go to `~/.local/bin` on
  macOS or `%LOCALAPPDATA%\spawn\bin` on Windows. Any existing Windows install
  is handed to `spawnd update`; the app must never rename or overwrite a live
  `spawnd.exe`. The daemon owns launchd / Task Scheduler and its own updates.

## Commands

```bash
npm install
cargo tauri dev
cargo tauri build
npm run dmg:background      # after editing src-tauri/dmg/background.html
npm run icons               # after editing src-tauri/icons/icon.html
npm run icons:check
cd src-tauri && cargo fmt && cargo build && cargo test && cargo clippy -- -D warnings
```

### Which server a build points at

`SPAWN_DESKTOP_SERVER_ORIGIN` fixes it at build time, and is the same question
`mobile/eas.json` answers per profile with `EXPO_PUBLIC_API_URL`. Unset means
`https://spawnd.dev`, so a release build needs no ceremony:

```bash
SPAWN_DESKTOP_SERVER_ORIGIN=https://dev.spawnd.dev:8330 npm run tauri -- build
```

It becomes the default `server_origin`, and the origin the wizard offers as
"hosted" — read through `models::HOSTED_ORIGIN` and the `hosted_origin`
command, so the Rust side and the wizard cannot disagree about it. `build.rs`
rejects a value that is not an http(s) origin, ends in a slash, or holds
whitespace: a bad one is only visible at runtime as an app that reaches no
server at all.

A build pointed anywhere but `https://spawnd.dev` also takes **no updates**
from the signed app channel. That channel carries the app for the vendor's
server, signed by the offline updater key, so a build made for a dev deployment
would check production on launch and — the first time production went ahead of
it — replace itself with the production app, moving the machine to another
fleet. Such a build is updated by whoever built it, and its update surface says
so.

`scripts/dev.sh --onboarding` (`npm run dev --onboarding`) rebuilds this app
when anything under `src/`, `src-tauri/src/`, the icons or the configs is newer
than the staged image. It does two things with the result: puts the DMG in
`web/public/desktop/` — the path the local server serves `/desktop/` from, so
the download button on the local site hands over this checkout's app rather
than the last one built — and installs the app itself into `/Applications`.

Both, because only one of them can be relied on. A browser quarantines what it
downloads, from localhost as much as anywhere, and a local build carries no
notarization to answer that with, so the copy that comes back through the page
is refused until `xattr -dr com.apple.quarantine` clears the mark. The copy
that never went through a browser has nothing to answer for. The build is
signed ad-hoc (`tauri.dev.conf.json`) because an unsigned bundle is not merely
unnotarized to macOS — it is *damaged*, a dialog whose only button is "Move to
Bin". `SPAWN_DEV_DESKTOP=0` skips all of it; `=1` asks for it on a plain
`npm run dev`.

So a locally built app costs **two** trips to System Settings → Privacy &
Security, and neither is a product bug: Gatekeeper judges the disk image and the
app separately, once when the image is opened and once for the copy dragged to
`/Applications`, which inherits `com.apple.quarantine` from the browser that
downloaded it. A release has neither — `desktop.yml` notarizes the app and
staples the DMG, so the image opens silently and the app gets the ordinary
one-click "downloaded from the Internet" confirmation. Judge a build with
`syspolicy_check distribution` and `xcrun stapler validate`; `spctl --assess`
calls good builds "rejected" on some Macs. What the app installs is a separate
question and already answered: binaries written by `install.rs` carry no
quarantine mark, because only a browser sets one.

The permission dialogs that arrive *after* possession are not this app's at all
— macOS attributes them to `spawnd`, so their copy lives in `daemon/Info.plist`
and their timing in `daemon/src/permissions.rs`. What this app owns is the
screen in front of them: `begin_permissions_gate` holds the daemon and says
whether to show it, `answer_permissions(prime)` carries the answer, and the
daemon asks after the screen instead of over the top of it. Without that hold
there is a real race — the service registers within seconds of approval, so the
dialogs would routinely beat the screen onto the display. See "What macOS asks,
and when" in `daemon/CLAUDE.md`.

`tauri.ci.conf.json` is macOS-only (`app` + `dmg`). On Windows,
`tauri.windows.conf.json` is merged automatically and produces only the
English, per-user NSIS installer with the WebView2 download bootstrapper:

```powershell
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
npm run tauri -- build --no-bundle --target x86_64-pc-windows-msvc
# CI Authenticode-signs spawn-desktop.exe here, then:
npm run tauri -- bundle --bundles nsis --target x86_64-pc-windows-msvc
```

The public Windows artifact is exactly
`SPAWN-D_<version>_windows-x86_64-setup.exe`. The Azure Key Vault certificate
covers the inner EXE before NSIS and the final installer after bundling. The offline
Tauri updater signature covers the final, canonically named setup EXE last.

The wizard can be driven in a plain browser by faking the Tauri bridge
(`window.__TAURI_INTERNALS__`) under Vite with `root` set to this folder — the
way its screens are reviewed without a build; see the memory note on the
desktop screenshot harness.

For the beta updater channel, build with
`cargo tauri build --features beta-updates --config
src-tauri/tauri.beta.conf.json`. Signing,
notarization and publication are release operations; read `docs/RELEASE.md`
in full before attempting any of them.
