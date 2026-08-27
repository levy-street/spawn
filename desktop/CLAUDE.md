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
  icons/         icon.icns / icon.png (bundle) and tray.png / tray@2x.png;
                 icon.html is the source and render.mjs prints both bundle
                 forms from it
  Cargo.toml     standalone crate; links ../../daemon as a library
  tauri.conf.json
  tauri.ci.conf.json  release-only DMG target override
  tauri.dev.conf.json the same targets, signed ad-hoc, for local runs
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
  meet unexplained. The permissions gate does: three system dialogs follow it,
  every time. The keychain move does not, and used to have one — it cannot
  know whether macOS will ask, because finding out means probing the keychain,
  which *is* the dialog, so it would have shown to everyone while only builds
  whose signature changed ever see a prompt. It migrates in silence instead.
  Do not add a screen for something most people will never see.
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

Two things about that face are contracts with `web/`, not implementation
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
a PNG. `tray.png` / `tray@2x.png` are black-on-alpha and handed to macOS with
`icon_as_template(true)`, which is the only correct way to wear a logo in the
menu bar.

## Where things go

- UI state and rendering stay in `src/`; keep dependencies to the vanilla
  Tauri template and do not add a component framework.
- Network, process, keychain, filesystem and cryptographic work belongs in
  Rust commands under `src-tauri/src/`. Pure contract logic gets a Rust unit
  test beside it.
- **This app never asks for the macOS keychain.** The session token and the
  Ed25519 device seed live in a mode-0600 `credentials.json` beside the
  preferences, written through `spawnd::secret_file` — the same atomic write,
  ownership and permission checks, `NOFOLLOW` open and cross-process lock the
  daemon's `creds.rs` uses for its own token and host seed. Non-secret
  preferences stay in the state file.

  The trade is real and is argued in the `storage.rs` module comment rather
  than assumed: a keychain item's ACL keeps *other processes running as this
  user* out, and a 0600 file does not. It is worth giving up because the
  daemon's strictly more powerful credentials — the host key that possesses
  this Mac — already live in exactly such a file, so the stronger door is on
  the lesser prize; and because "SPAWN D wants to use your confidential
  information stored in your keychain" reads to most people as *passwords*,
  which is the last thing a product that runs agents on your machine can afford
  to ask for. If you are tempted to put a secret back in the keychain, read that
  comment first and update it if you disagree — do not leave it stale.

  `keyring` remains as a dependency for one reason: a one-time migration that
  moves items older builds wrote into the file and deletes them. It runs from
  the `setup` hook in `lib.rs`, on its own thread — a fixed moment beats
  whichever secret read lands first, which could be mid-possession, and a
  thread because it can sit on a dialog for as long as a person takes. Nothing
  in the launch path reads a secret (`window::surface` reads preferences only),
  so there is nothing for it to race. Whether that
  migration is silent is decided by the signature, not by us — a notarized app
  reading items a notarized app wrote satisfies the ACL and nobody is asked
  anything, while a build whose signature changed since the item was written
  gets one dialog per item, at most twice, once, ever.

  **A macOS keychain read can block for ever, and `keyring` has no timeout.**
  When an item's ACL does not match the running signature macOS wants to
  prompt — and a prompt is a sheet, which needs a visible window to attach to.
  With no window it never renders and the call never returns. Not slowly:
  never. Running the sweep from `setup` shipped an app that launched to
  nothing at all — no window, no error, no log line, because nothing had
  failed yet. So: every keychain read happens on a detached thread behind
  `recv_timeout` (`PATIENT` when a window is up for the sheet to land on,
  `BRIEF` otherwise), the boot sweep waits for a *visible* window before it
  reads, and a reader that finds the sweep busy answers from the file rather
  than queueing behind it. The `try_lock` in `sweep_once` is load-bearing: a
  `OnceLock` there made every secret read wait on the boot sweep, which is how
  one stuck call took the whole app. A stuck reader thread is never joined and
  lives until the process exits — deliberate, and the cheaper half of the
  trade. Verify a change here by running the built app and checking
  `CGWindowListCopyWindowInfo` reports the window `onscreen=true`; no unit test
  can see this.

  **Never collapse a refused keychain read into an absent one.** `.ok()` on
  `get_password()` makes "there is nothing here" and "I will not tell you" the
  same value, and the sweep then marks itself complete having rescued nothing.
  The token is replaceable; the device seed is not — it *is* what made this
  device approved, so one accidental Deny signs the person out and leaves them
  re-approving a device the account already trusted, with nothing anywhere
  saying why. `KeychainRead` keeps the three answers apart and
  `sweep_is_complete` refuses to finish on a refusal, so the next launch tries
  again; a repeated dialog is a far smaller harm than an identity destroyed
  permanently. Only people on a signature that cannot satisfy the ACL reach
  that branch at all. `daemon/src/creds.rs` gets this right already
  (`NoEntry` → `Ok(None)`, every other error propagates) — match it.
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
npm run icons               # after editing src-tauri/icons/icon.html
cd src-tauri && cargo fmt && cargo build && cargo test && cargo clippy -- -D warnings
```

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

The wizard can be driven in a plain browser by faking the Tauri bridge
(`window.__TAURI_INTERNALS__`) under Vite with `root` set to this folder — the
way its screens are reviewed without a build; see the memory note on the
desktop screenshot harness.

For the beta updater channel, build with
`cargo tauri build --features beta-updates --config
src-tauri/tauri.beta.conf.json`. Signing,
notarization and publication are release operations; read `docs/RELEASE.md`
in full before attempting any of them.
