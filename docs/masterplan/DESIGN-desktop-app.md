# DESIGN — the SPAWN D desktop app

Read-only investigation on branch `native-daemon-fixes-auto-update-daemon`, 2026-08-25.
All repo paths relative to `/Users/charliesaxton/dev/spawn`. Builds on
`DESIGN-multiaccount.md` and `DESIGN-daemon-ux.md` (same directory — its §2.1
command specs and §2.3 setup-claims hand-off are load-bearing here and were
confirmed with its author; points that ride on it are marked **[UX-COORD]**), plus
`RESEARCH-updates.md` §A1/A2 for updater-verification sources.

The ask, verbatim: *"an electron app that can be installed from the website that
handles everything from setting up locally or on our servers (user picks) to signing
up, installing and running daemon automatically, staying up to date with OTA and
things like that. this should make it way better for non technical users."*

---

## 1. Current state (with evidence)

### 1.1 What the trust model wants from a packaged client

`docs/TRUST.md:572-582` (Residual risk 1, "Web client delivery"): the hosted PWA is
JavaScript served by the same operator the model distrusts; a hostile operator could
ship exfiltrating JS or disable the signature/pinning checks before connecting. The
named mitigations, in increasing strength: open source + self-hosting, reproducible
web builds + signed releases, subresource integrity, and *"eventually a packaged
client (PWA store build / Tauri) whose update channel is independently signed"*
(`TRUST.md:581-582`). The open-source checklist repeats it: reproducible builds so
served bytes are verifiable against source, *"Same for the web bundle (risk 1)"*
(`TRUST.md:795-799`).

So the trust model asks three things of this app:

1. **An independently signed update channel** — updates verified against a key the
   production server does not hold, so a compromised operator cannot push client code.
2. **Verifiable provenance** — the client bytes correspond to public source
   (the web build already pins its Next buildId for exactly this,
   `web/next.config.ts:24-32`; `scripts/verify-served-client.sh` exists).
3. **Client-held key material out of operator reach** — the web client keeps device
   keys in IndexedDB (`web/src/lib/browser-device-identity.ts`) because a browser has
   nothing better; a packaged client can hold them in the OS keychain.

A desktop app that merely wraps the *hosted* web app in a webview satisfies none of
these — it re-imports risk 1 with extra steps. This shapes the window-mode decision
(§5).

### 1.2 The website download surface today

`web/src/app/download/page.tsx` — one page: OS detection
(`web/src/lib/platform.ts:31-39`), the curl one-liner
(`platform.ts:22-28`: `curl -fsSL <origin>/install.sh | sh`), a prebuilt-only
variant, and a "Windows unsupported" plate (`page.tsx:46-52` — **the daemon has no
Windows build**; `daemon/src/update.rs` exec is `#[cfg(unix)]`). No app artifact of
any kind is offered.

### 1.3 What the web app needs from a host environment (webview constraints)

- **WebAuthn + the PRF extension** for the trust bundle: `web/src/lib/passkey-prf.ts:1-25`
  — the PRF secret unlocks the operator's trust bundle and "never leaves the device";
  `passkey-flows.ts` runs setup/unlock/backup/revocation on it. TRUST_UX §3 also
  offers "sign in here with your passkey" as an approval escape.
- **IndexedDB** stores: device identity (`browser-device-identity.ts`), host pins
  (`browser-host-pins.ts`), split-store (`split-store.ts`).
- **WebRTC DataChannels are the terminal**: `docs/INTERFACE_MATRIX.md:40-42` — input
  over `spawn.pty`, control over `spawn.ctl`, "direct to the endpoint", never through
  the server.
- **Single-origin proxy**: `web/next.config.ts:63-70` rewrites `/api/*`, `/ws/*`,
  `/healthz`, `/install.sh` to the FastAPI server so the deployed app is single-origin
  ("no CORS, no cross-origin cookie weirdness", `next.config.ts:4-6`). The web app
  assumes it is served *by* Next with that proxy in front.

### 1.4 The machinery the app would drive (and must not duplicate)

- **Install**: `server/spawn_server/routes/install.py` — `/install.sh` (rendered
  script, `install.py:141-156`) plus raw binary endpoints
  `GET /api/install/spawnd/{target}` and `/api/install/spawn-worker/{target}`
  (`install.py:220-260`, four targets, `install.py:21-26`), with sha256s published via
  the prebuilt manifest (`install.py:88-110`, `docs/RELEASE.md:36-56`). The script's
  default tail is `exec spawnd possess` (`install.py:680-682`).
- **Possess / service**: `spawnd possess` is the idempotent one-command onboarding
  (`daemon/src/possess.rs:1-16`): derives a per-account config dir, runs the login
  ceremony if needed, then `service::install` writes and enables a **LaunchAgent**
  (`daemon/src/service.rs:181-260`, `app.spawn.spawnd[.<tag>]`, `RunAtLoad` +
  `KeepAlive=true`) or a **systemd user unit** (`service.rs:88-160`,
  `Restart=on-failure`, `KillMode=process`, plus `loginctl enable-linger`). Start at
  login and crash restart are *already the daemon's job*.
- **Pairing ceremony**: `spawnd login` (`daemon/src/login.rs:1-11`) — device-code
  start → possession proof → the approval URL is opened/printed with the host's
  public key appended **locally** as a `#k=` fragment ("the out-of-band value the
  browser checks the server's claimed key against") → poll → store
  `{access_token, host_id, server_url}`. The approving side: a signed-in browser
  device signs `SPAWN-HOST-PAIR-APPROVE-V1` (`server/spawn_server/routes/device.py:793`,
  `web/src/components/hosts/connect-host.tsx:33-52` reads the fragment;
  `docs/TRUST_UX.md` §4: exact-match → one **Approve mac-studio** button; mismatch →
  hard refusal, "There is no override").
- **Self-update**: `daemon/src/update.rs` — `apply_from_release` reads
  `GET /api/release`, compares its own content tree (`daemon.tree`), downloads both
  binaries from `/api/install/...`, verifies sha256s, re-checks preconditions,
  atomically swaps, execs itself; workers keep running and are re-adopted
  (`update.rs:1-6`). `spawnd update` runs it once (`cli.rs:43-44`). **The app must
  not implement any of this** — it delegates and surfaces.
- **Introspection**: `spawnd status` exists ("Print credential state and redacted
  host/browser fingerprints", `daemon/src/cli.rs:46-48`). **`spawnd doctor` does not
  exist in code today** (repo-wide grep) — but `DESIGN-daemon-ux.md` §2.1 now specs
  both `spawnd status --json` and `spawnd doctor --json`, plus a heartbeat file
  `<config_dir>/state.json` ({pid, connected, last_error, sessions…}, rewritten
  every 30 s by `run`). The app consumes those contracts (§4.4). **[UX-COORD]**
- **Release identity**: `GET /api/release` (`routes/release.py:10-15`,
  `schemas.py:857-861`: `server`, `web`, `daemon|null`, `mobile`) per
  `docs/RELEASE.md:9-33`; `scripts/verify-release.sh` proves deployed identities
  against a git ref; `scripts/deploy-prod.sh` + `scripts/update-mobile-prod.sh` ship
  the pieces.

### 1.5 The third-client precedent: mobile already proves the pattern

The desktop app is **not** a new kind of thing — the Expo app is already a native,
non-browser client of the same API, and every hard problem has a mobile answer to
copy:

- Token auth, not cookies: `mobile/src/data/api/endpoints/auth.ts` (`authToken`,
  password login returns a token; OAuth `redirect_uri` "is what turns this into a
  native flow: the server checks it" against an allow-list, then
  `POST /api/auth/oauth/exchange` trades a one-time code for the token —
  `endpoints/auth.ts:106-131`; native Apple sign-in via
  `/api/auth/oauth/apple/native`).
- Server choice: `mobile/src/data/api/config.ts` — a runtime server-URL override with
  validation copy ("Enter a SPAWN D server URL", `config.ts:52-59`).
- Device identity + ceremony: `mobile/src/data/trust/` (`registration.ts`,
  `ceremony.ts` — both SAS roles run on the phone, TRUST_UX §3 knock prompt), device
  keys in native storage.

### 1.6 "Setting up locally or on our servers" — the ambiguity, both readings

**Reading (i): choose the control-plane server** (hosted spawnd.dev vs self-hosted).
Fully supported today: `install.sh --server URL` (`install.py:203-210`), the service
units bake `--server` in (`service.rs:96-107, 186-196`), `spawnd` resolves per-instance
server URLs (`config::server_url_for_instance`, `login.rs:41-43`), the mobile app has
a server override (`config.ts`), and TRUST.md names self-hosting the strongest
mitigation for risks 1 and 3 (`TRUST.md:578-579, 587-588`).

**Reading (ii): choose where compute runs** (your machine vs machines SPAWN D hosts
for you). **Nothing in the repo suggests hosted compute exists**: "legion" is the
user's *own* fleet and its capacity strip (`docs/INTERFACE_MATRIX.md:13,38,127`);
"workspaces" are named grids of session tiles (`INTERFACE_MATRIX.md:12,32-33`);
`Host.owner_user_id` assumes user-owned machines (`DESIGN-multiaccount.md` §1.1);
every install path targets hardware the user controls. Hosted compute would be a new
product line — provisioning, isolation, billing — and would *invert* the trust
pitch ("the server only relays" stops being true for a host the operator runs).

**Recommendation**: the MVP implements reading (i) — a server picker with hosted
spawnd.dev as the default and an advanced self-hosted URL field, exactly mirroring
mobile's override. Reading (ii) is an open product question (§8.1); nothing in this
design blocks it later (a hosted host would simply appear in the legion like any
other), but the app should not pretend it exists.

---

## 2. Shell technology

### 2.1 The findings that decide it (researched 2026-08-25, sources cited)

**Passkeys/WebAuthn in a shell webview — broken everywhere that matters:**

| | Electron (Chromium) | Tauri v2 (system webviews) |
|---|---|---|
| macOS | Touch ID landed in Electron 41.5/42 (Apr 2026, `app.configureWebAuthn` + keychain entitlement) but creates **device-bound Secure-Enclave credentials, not iCloud-synced passkeys**; real passkeys need a native `ASAuthorizationController` module + Associated Domains ([PR #51255](https://github.com/electron/electron/pull/51255), [vault12/electron-webauthn-mac](https://github.com/vault12/electron-webauthn-mac)) | WKWebView allows WebAuthn only for the app's own associated RP domain; full support needs the restricted `com.apple.developer.web-browser.public-key-credential` entitlement Apple grants to real browsers ([passkeys.dev/macos](https://passkeys.dev/docs/reference/macos/), [tauri#7926](https://github.com/tauri-apps/tauri/issues/7926) still open) |
| Windows | Works out of the box on an https origin (OS WebAuthn dialog) ([Discord blog](https://discord.com/blog/how-discord-modernized-mfa-with-webauthn)) | WebView2 nominally supports Windows Hello; open reliability issues ([WebView2Feedback#5663](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5663)) |
| Linux | Broken — no authenticator dialog at all ([#24573](https://github.com/electron/electron/issues/24573)) | No WebAuthn in WebKitGTK ([WebKit bug 205350](https://bugs.webkit.org/show_bug.cgi?id=205350)) |
| file:// / custom scheme | WebAuthn refuses non-https origins entirely — no RP ID ([#24573](https://github.com/electron/electron/issues/24573)) | same |

**Consequence**: no shell gives us the web app's passkey-PRF trust-bundle unlock
in-webview. Every credible desktop app (GitHub Desktop, Slack, Figma, Tailscale)
bounces auth to the system browser (RFC 8252) — Tailscale's variant needs no deep
link back at all: the client polls its control plane until login completes
([tailscale#4023](https://github.com/tailscale/tailscale/issues/4023)). **This
neutralizes Electron's main advantage** — we must design around the system browser /
native APIs regardless of shell. And crucially, §1.5 shows the app does not *need*
in-shell WebAuthn: email/password + OAuth-with-exchange are token flows mobile
already uses, and the device-approval ceremony is the SAS number check, not a passkey.

**WebRTC** (only matters if we ever embed the terminal):
- Electron: full Chromium WebRTC, all platforms — its one real, durable edge.
- Tauri: fine on macOS WKWebView (RTCPeerConnection/DataChannel per Safari engine)
  and Windows WebView2; **effectively absent on Linux** — WebKitGTK compiles WebRTC
  out of release builds (`ENABLE_WEB_RTC = experimental`,
  [OptionsGTK.cmake](https://github.com/WebKit/WebKit/blob/main/Source/cmake/OptionsGTK.cmake);
  Debian doesn't override; [tauri#13143](https://github.com/tauri-apps/tauri/issues/13143)),
  and even compiled in it's off at runtime. Not default-on in any mainstream distro
  as of mid-2026.

**Updaters** — this is where the trust model votes:
- Tauri v2 updater: minisign keypair, **public key baked into the app**, every
  artifact ships a signature the app verifies before install; static `latest.json`
  endpoints supported; no built-in rollback ([Tauri updater docs](https://v2.tauri.app/plugin/updater/)).
  This is literally `TRUST.md:581-582`'s "update channel independently signed".
- electron-updater (generic provider): sha512 checksum from an **unsigned**
  `latest-mac.yml` over HTTPS + OS code-signing; Doyensec's Feb 2026 follow-up says
  downgrade/integrity threats remain unaddressed
  ([doyensec 2026](https://blog.doyensec.com/2026/02/16/electron-safe-updater.html)).
  Weaker than what the trust model asks for; hardening it is custom work.

**Footprint**: Tauri ~3-10 MB installer / ~40-80 MB idle vs Electron ~50-150 MB /
~100-300 MB (blog-grade numbers, direction uncontested). For "installed from the
website by non-technical users", a 6 MB DMG that opens instantly is a real
first-impression difference.

**Team fit + precedent**: the daemon is Rust; a Tauri app shares the workspace,
`reqwest`, the crypto crates, and CI toolchain. Tauri tray support is first-class
([v2 system-tray](https://v2.tauri.app/learn/system-tray/), macOS
`ActivationPolicy::Accessory` for menu-bar-only). GitButler ships a production Tauri
app with self-hosted update manifests. Signing/notarization on GitHub Actions is
documented for tauri-action (Developer ID cert + App Store Connect API key in
secrets, [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)).

### 2.2 Decision: Tauri v2, tray-first — "Electron" read as "installable desktop app"

Charlie said "an electron app"; the recommendation is Tauri, and the justification is
user-benefit, not taste:

1. **The update channel can be one the trust model endorses** (signed manifests
   verified against an app-baked key the server never holds) instead of one it would
   have to caveat. This app is the named fix for TRUST.md residual risk 1 — shipping
   it on the weaker updater would spend the effort without earning the property.
2. **A 6 MB download that launches fast** is materially better for the exact
   audience named ("non-technical users" clicking a website button).
3. **Nothing the MVP needs favors Electron**: auth bounces to the system browser
   under both shells; the tray/status/possess surfaces are plain HTTP + local
   process work; the terminal stays in the real browser (§5).
4. **Rust end-to-end**: the app can link the daemon's own crates (e.g. the
   `SPAWN-HOST-PAIR-APPROVE-V1` transcript code, `daemon/src/host_pair_approval.rs`)
   instead of reimplementing ceremonies in JS — fewer places for a trust bug.

The one scenario that flips this to Electron: a hard product requirement to embed
the full terminal UI in-app on **Linux** (WebKitGTK's missing WebRTC). §5 argues the
browser is the better home for the terminal anyway; if that ever changes, revisit.

---

## 3. What the app is

**"SPAWN D" lives in the menu bar / tray.** It is a companion, not a second
front-end: it makes the machine it runs on *possessable in one click* and keeps the
daemon's health visible. The web app stays the place you work.

Tray menu (steady state):

```
● mac-studio — possessed, online          ← status line (daemon + WSS state)
──────────────────────────────
Open SPAWN D                              ← browser to the chosen server origin
Sessions            3 running ▸           ← submenu from GET /api/sessions
──────────────────────────────
Daemon 0.1.0+g40ab12 — up to date         ← /api/release vs spawnd status
Update SPAWN D…                           ← only when the app itself has an update
Repair…                                   ← §4.4
Settings…
──────────────────────────────
Quit SPAWN D                              ← quits the app; the daemon keeps running
```

"Quit" copy matters: the daemon is a LaunchAgent/systemd unit and survives the app
(`service.rs` KeepAlive) — the menu says so ("The daemon keeps running while SPAWN D
is closed"), and Settings offers "Stop possessing this Mac…" (= `spawnd exorcise`)
as the real teardown.

The app's own UI (first-run wizard, settings, status windows) is **local, bundled
HTML/JS** rendered by the shell — never remote code. That is what makes it a packaged
client in TRUST.md's sense: the operator cannot alter what the app runs at load time.

### 3.1 Identity: the app is a device, the daemon is the host

Two credentials, deliberately separate:

- **The app's session**: a token from `/api/auth/login` (or OAuth exchange), stored
  in the OS keychain, plus a **device identity keypair** minted on first run —
  exactly the mobile pattern (`mobile/src/data/trust/registration.ts`). The app
  appears in the device roster like any browser or phone, is approved by the same
  number check, and can be revoked from anywhere.
- **The daemon's credential**: created by the ceremony the app drives
  (`spawnd login` → `{access_token, host_id}`), owned by the daemon in its config
  dir. The app never holds or proxies it.

This keeps the trust story auditable: revoking the app-device removes the *approver*;
the host's standing is its own.

---

## 4. The flows

### 4.1 First run: sign in → pick server → possess (all in-app)

Auth, concretely:

- **Email + password**: native form in the wizard → `POST /api/auth/login` → token
  (mobile's exact flow). Works with zero server change.
- **OAuth (Google, Microsoft, GitHub, Apple** — `routes/auth_providers.py:31`): open
  the **system browser** at `/api/auth/oauth/<provider>/start?redirect_uri=…` — the
  server already validates native `redirect_uri`s against an allow-list and hands
  back a one-time code for `POST /api/auth/oauth/exchange`
  (`mobile/src/data/api/endpoints/auth.ts:106-131`). Desktop registers a
  `spawn://` URL scheme (identifiers stay `spawn` per root CLAUDE.md) or, more
  robustly, uses a localhost loopback redirect — the allow-list grows one entry
  either way (server S). OAuth *must* leave the shell regardless: Google blocks
  embedded webviews outright.
- **Sign-up**: same form pair the web has (`web/src/app/signup/page.tsx`), against
  the same endpoints. Note `spawn-oauth-skips-email-verification` (2026-08-24
  decision) — OAuth sign-ups land ready to use.
- **Existing account, new device**: signing in stamps the roster row and raises the
  knock on the user's other devices (TRUST_UX §3, shipped 2026-08-25 for the phone).
  The wizard shows the waiting card with the **4-digit number** (SAS show side) —
  the same `NumberCheck` contract, no passkey required. A brand-new account's first
  device needs no approval; the wizard skips the step.

Server choice screen: default **spawnd.dev**; "Advanced" reveal → URL field reusing
mobile's normalization and copy (`config.ts:52-79`, "Enter a SPAWN D server URL").
Everything after this point — auth, install, possess, release checks — targets the
chosen origin. (App self-updates do not; §6.)

### 4.2 Installing the daemon: download from the chosen server (don't bundle)

**Decision: the app downloads `spawnd` + `spawn-worker` from the chosen server at
first run, exactly as `install.sh` does — it does not bundle them.**

- Bundling ties every daemon release to an app release (two channels for one
  artifact, guaranteed drift with the rolling prebuilts, `.github/workflows/prebuilt.yml`)
  and breaks the self-hosted case: a self-hosted server serves *its* daemon build
  and *its* `/api/release` identity; a bundled spawnd.dev daemon registering against
  it would be exactly the version skew `docs/RELEASE.md` exists to prevent.
- Downloading reuses one channel end to end: fetch `/api/release` → `daemon.targets[target].spawnd_sha256`
  (the manifest contract, `RELEASE.md:36-56`) → download
  `/api/install/spawnd/{target}` + worker → **verify both sha256s** → install to
  `~/.local/bin` (the install-script convention, `install.py:181-183`) → run
  `spawnd possess`. This is the same verify-then-trust dance `update.rs` performs,
  done once by the app; from then on **the daemon updates itself** and the app only
  watches.
- If the chosen server advertises no prebuilt for this target (`daemon: null` —
  a source-built self-hosted setup), the app is honest: it shows the curl command
  (`platform.ts:23`) and a "run this in Terminal" card instead of half-working.

The Tauri sidecar mechanism is deliberately **not** used for spawnd: sidecars live
inside the signed app bundle (`bundle.externalBin`), which is bundling by another
name, and the daemon must outlive and update independently of the app.

### 4.3 Possession with both ends on one machine: in-app approval, no browser

Today `spawnd possess` opens a browser to the `#k=` approval URL (§1.4). When the
approver is a signed-in app **on the same machine as the daemon**, the ceremony
completes in-app:

1. **The app is the "attended session"** of `DESIGN-daemon-ux.md` §2.3's setup
   claims (**[UX-COORD]**, confirmed with its author): it mints a claim
   (`POST /api/setup/claims` → token, authenticated as the app's session), spawns
   `spawnd possess` with `SPAWN_SETUP_TOKEN`, and polls
   `GET /api/setup/claims/{token}`. The daemon forwards the token on
   `device/start`; at possession-proof the server marks the claim `ready` (with
   `approval_ref`, `host_name`, fingerprint) and returns `attended: true`, so the
   daemon suppresses its own browser-open. No browser window ever appears.
2. **The key check**: the claim payload carries no `#k` fragment (its designed
   fallback is the full-fingerprint compare, TRUST_UX §4). But the app spawns
   `possess` as a child and reads the printed approval-URL line
   (`spawn:   https://…#k=…` — plain output lines are contractually stable and
   greppable per the daemon-ux TUI spec), extracting the fragment key locally.
   That is **the identical check `connect-host.tsx` performs**
   (`connect-host.tsx:33-52, 236-237`), and the out-of-band property holds —
   arguably more strongly than the browser case: the key crossed from daemon to
   approver over a pipe between two local processes; no URL bar, no network hop,
   nothing the server ever carries. Exact match → one-click approve; mismatch →
   the §4 refusal verbatim — "This host could not be verified", no override; no
   `#k` line at all → the fingerprint-compare screen, never a silent pin. If
   line-parsing offends, `possess --json-progress` is this design's **one new
   daemon ask** (S) — design-ux deliberately scoped `--json` to status/doctor.
3. One click — **Possess this Mac** — signs `SPAWN-HOST-PAIR-APPROVE-V1` with the
   app's device key (linking `daemon/src/host_pair_approval.rs` directly) and
   completes via the existing `POST /api/auth/device/pending` + `/approve`. The
   daemon's poll returns, `service::install` runs, done.

The done state mirrors §4's copy: the host named, "All your devices can reach it" —
and the host-introduction broadcast the web approver already does
(`connect-host.tsx` → `publishHostIntroductionBroadcast`, mesh R7) ships from the
app too, so other devices arrive verified.

For a **remote/headless** machine the app changes nothing: the curl path and the
QR/push improvements in `DESIGN-multiaccount.md` §3 remain the design; the app's
Settings can show the copyable command ("Possess another machine…"), same as
`ConnectHostSection`.

### 4.4 Supervision: observe and delegate, never re-implement

The daemon already owns start-at-login, crash-restart, and worker survival
(`service.rs`; `KillMode=process`, KeepAlive). The app:

- polls locally: `spawnd status --json` / `spawnd doctor --json` (the stable
  contracts, `DESIGN-daemon-ux.md` §2.1) for credential and diagnosis state, with
  the `<config_dir>/state.json` heartbeat (rewritten every 30 s by `run`) as the
  cheap between-polls read; `launchctl print gui/$UID/app.spawn.spawnd*` /
  `systemctl --user is-active 'spawn*'` for service state; the state-dir logs
  (`spawnd.out.log` / `spawnd.err.log`, `service.rs:246-247`) for the Repair view.
  Tray verbs map onto the daemon's own: `spawnd reconnect` / `disconnect` /
  `logout` (which now keeps the host identity, per the same spec);
- polls the server: `GET /api/hosts` for online/last-seen — the same truth the web
  shows;
- **Repair…** runs, in order, exactly the public machinery: re-run
  `spawnd possess` (idempotent resume — `possess.rs:37-56` silently resumes a single
  instance and re-installs the service), then offer reinstall via the verified
  download (§4.2), then show the log tail with a copy button. No bespoke fix-it
  code. `spawnd doctor --json` is the diagnosis surface (design-ux's spec owns
  its shape); the app shells out and renders, never re-diagnoses.
- **Updates surfaced, not performed**: the daemon self-updates against
  `/api/release` (`update.rs apply_from_release`); the app compares
  `daemon.tree`/version from `/api/release` with the running daemon's and shows
  "up to date" / "updating…" / "stuck — Repair". If the daemon's self-update is
  blocked, the app surfaces the daemon's own block reason (`update.rs BlockReason`
  — disabled/unwritable/worker_missing, and this branch is actively growing the
  set, e.g. worker_mismatch + a post-update probation/revert stage) and offers the
  reinstall path — the one thing an app with user interaction can do that the
  daemon can't. The contract is "render what the daemon reports", never a copy of
  its state machine.

Multi-account (from `DESIGN-multiaccount.md` §2 Option 2): the app is single-account
per app instance in MVP; if `possess` reports "already possessed for <other account>"
the app surfaces the `--new-account` hint verbatim once that lands.

---

## 5. Window mode: the browser keeps the terminal

**MVP: the app never embeds the remote web app.** "Open SPAWN D" opens the system
browser at the chosen origin. Reasons, in order of weight:

1. **Trust**: loading the hosted web app in a webview is residual risk 1 in a
   trench coat — operator-served JS, now with a less capable, less updatable
   runtime around it. The packaged-client win comes from *not* running
   operator-served code (§1.1).
2. **Capability**: the trust bundle's passkey-PRF unlock cannot run in any shell
   webview (§2.1) — an embedded web app couldn't even finish its own trust
   bootstrap. The terminal's WebRTC DataChannels die on Linux WebKitGTK.
3. **Honesty about what the shell adds**: embedding the remote app adds nothing
   the user's real browser doesn't do better (extensions, passkeys, profiles).
   The app's value is the tray, the one-click possess, and the supervision — all
   local.

**End state (TRUST.md's actual ask): ship the web bundle *inside* the app**, with
`/api` pointed at the chosen server. Honest cost assessment: the Next app is built
around server components and the single-origin rewrite proxy
(`next.config.ts:63-70`); packaging it means either bundling a Node server (heavy,
and still local-origin — WebAuthn RP ID breaks on non-https origins, §2.1) or a
static-export refactor plus an absolute-API-base mode plus CORS/cookie work on the
server plus native passkey bridges for the PRF unlock
(`tauri-plugin-macos-passkey`-style). That is an **L**, it is *the* long-term
packaged-client play, and nothing in the MVP forecloses it — but it should not gate
shipping the tray app. Between MVP and end state there is a cheap middle: local,
app-rendered read-only surfaces (sessions list, host health) built from the API —
no remote code, no WebRTC.

---

## 6. Staying up to date: two channels, cleanly separated

- **The daemon**: unchanged. Self-updates from the *chosen server's* `/api/release`
  (`update.rs`), because the daemon must match its control plane. The app watches.
- **The app**: Tauri updater against **https://spawnd.dev/desktop/latest.json** (a
  static, `no-store` manifest; artifacts + `.sig` files beside it) — **always the
  vendor origin, even when the control plane is self-hosted**. Rationale: the
  updater's minisign public key is baked into the app and the private key lives
  offline with the team — never on the production host — so a server compromise
  (or a hostile self-hosted server) cannot ship client code; the worst it can do
  is nothing. This is the "independently signed update channel" of
  `TRUST.md:581-582`, implemented literally. Self-hosters get app updates the same
  way they got the app: from the vendor. (A fully-airgapped deployment can disable
  the updater at build time and redistribute; document, don't block.)

`/api/release` grows an optional `desktop` block (server S):

```json
"desktop": { "version": "0.1.0", "tree": "40hex desktop/ tree", "platforms": ["darwin-aarch64", "darwin-x86_64"] }
```

— *display and verification identity only* (what the web download page shows, what
`verify-release.sh` checks); the updater itself never reads it. Unknown/dirty stays
unset, matching the existing convention (`RELEASE.md:22-24`).

### 6.1 Pipeline (macOS first)

1. **CI** (`.github/workflows/desktop.yml`, sibling of `prebuilt.yml`): tauri-action
   builds `aarch64` + `x86_64` DMGs and `.app.tar.gz` updater artifacts; signs with
   the Developer ID cert (base64 `.p12` in secrets, temp keychain); notarizes via
   App Store Connect API key — the account already exists (the iOS app ships via
   EAS; Developer ID is a new cert type on the same account, EAS holds nothing the
   desktop needs). Hardened runtime on; note the known pitfall that every embedded
   binary must be signed too.
2. **Updater signing**: `tauri signer generate`; **key custody is a deliberate
   decision, not a default** — a private key in GitHub Actions secrets is *not*
   an offline key (CI compromise = signed malicious releases; RESEARCH-updates.md
   security section). Recommended split: CI builds and notarizes; the minisign
   update-signing of `latest.json` + artifacts runs **locally in the release
   flow**, where deploys already run (`scripts/deploy-prod.sh` is invoked from
   the release Mac), so the key never lives in CI. Either way, custody and
   recovery go in docs/RELEASE.md — **losing the key strands every install**
   (Tauri's own warning).
3. **Publish**: the deploy step copies `latest.json` + artifacts to the prod host
   (nginx-served `/desktop/…`), *after* artifact verification, mirroring the
   prebuilt manifest's atomic-write rule (`RELEASE.md:33-36`).
4. **Staged rollout**: publish to `/desktop/beta/latest.json` first (team machines
   run the beta endpoint via a build flag), promote by copying to stable. Static
   manifests make percentage rollouts awkward; two channels is the honest v1.
5. **verify-release.sh grows**: fetch `/desktop/latest.json`, check `version`
   against the ref's `desktop/tauri.conf.json`, download one artifact, verify its
   minisign signature with the public key **committed in-repo**, and cross-check
   `/api/release.desktop`. Same PIECE/EXPECTED/ACTUAL/RESULT table.
6. **docs/RELEASE.md** gains piece five ("the desktop app"), its content identity
   (`git rev-parse <ref>:desktop` + app version), and the checklist line. The root
   CLAUDE.md map gains `desktop/` — same commit as the directory (check-claude-md
   guard).
7. **Windows/Linux later**: Linux = AppImage + updater (no gatekeeper, S on top of
   CI); Windows is **gated on a daemon Windows build that does not exist**
   (`download/page.tsx:46-52`, `update.rs` unix-only exec) — a Windows app today
   could only view, not possess. Don't ship it. When it comes: Azure Artifact
   Signing (~$10/mo), a SmartScreen reputation ramp, and one ordering gotcha
   worth writing down now: Authenticode rewrites the binary *after* `tauri
   build`, invalidating the minisign signature unless signing happens in the
   right order (tauri discussions #12692, issue #4610 — via RESEARCH-updates.md).
8. **Website**: `download/page.tsx` macOS plate leads with **Get SPAWN D for Mac**
   (DMG, version + sha from `/api/release.desktop`); the curl one-liner moves to
   "servers and Linux" placement. Mac App Store is explicitly out: the sandbox
   cannot install LaunchAgents or write `~/.local/bin`.

---

## 7. First-run script (copy, SPAWN D voice: flavoured headings, standard verbs)

1. **spawnd.dev/download** → "Get SPAWN D for Mac". Sub-line: "Or possess any
   machine from its terminal:" + the curl chip.
2. **Gatekeeper** → standard signed/notarized open; no copy of ours.
3. **Welcome** — heading **"Possess this Mac."** Body: "Sign in, pick your server,
   and SPAWN D does the rest — the daemon installed, verified, and kept running.
   About two minutes." Button: **Get started**. Footer link: "What gets installed?"
   (plain list: two binaries in ~/.local/bin, one LaunchAgent, nothing else).
4. **Sign in** — heading **"Who summons?"** Email/password fields; provider buttons
   ("Continue with Google/GitHub/Microsoft/Apple" — opens your browser); "Create an
   account" link. Errors verbatim from the web app.
5. **Approve this device** (existing accounts only) — the waiting card: "Approve
   from a device you already use." + the large 4-digit number (SAS show side); the
   knock reaches phones as a push (§3 TRUST_UX). Never skippable, no override.
6. **Choose your server** — heading **"Whose altar?"** Radio: **spawnd.dev** —
   "Hosted. Fastest start." / **A server you run** — reveal URL field ("Enter a
   SPAWN D server URL"), sub-line: "Self-hosting is the strongest trust stance —
   the server only ever relays." Button: **Continue**.
7. **Possess** — one button: **Possess this Mac**. Progress lines, each checked
   off: "Downloading the daemon" → "Verifying — hashes match the server's
   manifest" → "Starting the service" → "Registering this Mac" → "Approved — key
   verified on this machine". Failure states below.
8. **Done** — heading **"mac-studio is possessed."** Body: "All your devices can
   reach it. SPAWN D lives in your menu bar; the daemon keeps running on its own."
   Buttons: **Open SPAWN D** (browser) / **Done**.

Error and repair paths (each maps to a §4.4 mechanism):

- Download/verify fails → "The daemon didn't verify. Nothing was installed." +
  **Try again** / **Use the Terminal instead** (curl chip).
- Key mismatch → TRUST_UX §4 verbatim: **"This host could not be verified."** No
  retry-as-approve, no override; a **Learn what this means** link.
- Service fails to start → "The daemon installed but its service didn't start." +
  **Repair** (re-runs possess) + log tail.
- No prebuilt on a self-hosted server → "<server> doesn't serve a build for this
  Mac. Run its installer in Terminal:" + chip.
- Already possessed → "This Mac is already possessed for <account>." + **Open
  SPAWN D**; (+ the `--new-account` path once DESIGN-multiaccount ships).

---

## 8. Implementation cut-list

Stage 0 — contracts (land with or before the app; each S):
- The `DESIGN-daemon-ux.md` contracts the app consumes — `spawnd status --json`,
  `spawnd doctor --json`, the `state.json` heartbeat, and the setup-claims flow
  (`POST /api/setup/claims`, possess `--setup`/`SPAWN_SETUP_TOKEN`) — specced
  there, built once, shared by TUI and app. **[UX-COORD]**
- Optional `spawnd possess --json-progress` (daemon) — this design's only new
  daemon ask, if URL-line parsing is rejected (§4.3).
- OAuth `redirect_uri` allow-list entry for the desktop scheme/loopback (server).
- `/api/release.desktop` block + schema (server).

Stage 1 — MVP, macOS (order = build order):
- Tauri workspace member `desktop/`, tray + local wizard UI, keychain token +
  device identity (link daemon crypto crates) — **M**
- Sign-in (password native; OAuth browser bounce + exchange; SAS waiting card) — **M**
- Server picker with mobile's validation — **S**
- Verified daemon download + `possess` drive + in-app approval (§4.2-4.3) — **M**
- Tray status/supervision/Repair (§4.4) — **M**
- Tauri updater + signed static manifest + beta/stable channels — **S/M**
- CI: sign, notarize, publish; verify-release.sh + RELEASE.md + CLAUDE.md map — **M**
- Website download page: Mac button + placement change (web, same commit as the
  server's `desktop` block per the two-frontends rule — mobile is untouched, and
  that one-sidedness is *explained*: this artifact only exists for desktops) — **S**

Stage 2 — comfort:
- Sessions-at-a-glance submenu; "Possess another machine" surface reusing
  connect-host copy — **S**
- The knock prompt rendered by the app (approve *other* devices from the tray,
  number-check enter side) — **M**
- Linux AppImage — **M** (tray caveats: no click events on some DEs)
- Multi-account `--new-account` surface, after DESIGN-multiaccount lands — **S**

Stage 3 — the trust-model end state (each L, sequence-independent):
- Packaged web client in-app: static-export/absolute-API refactor + native passkey
  bridge; TRUST.md residual-risk-1 rewrite to claim the property.
- Reproducible desktop builds wired into `verify-served-client.sh`'s sibling.
- Windows, gated on a daemon Windows port (separate, unscoped).

## 9. Open product questions

1. **"On our servers" — which reading?** This design implements *choose your control
   plane* (§1.6 reading i). If it meant *SPAWN D hosts compute for you* (reading ii),
   that is a new product line (provisioning, isolation, billing, and a changed trust
   pitch) that nothing in the repo starts today — needs an explicit call.
2. **Electron by name**: the design recommends Tauri for the reasons in §2.2. If
   Electron specifically is wanted, ~80% of this design carries over unchanged; the
   deltas are the weaker update-channel signing (custom hardening work to match),
   ~10× artifact size, and losing the shared-Rust-crates ceremony code.
3. **Sign-up in-app day one?** Password sign-up is S; if OAuth-only sign-up matters
   for launch, the browser-bounce is M and should be scheduled first.
4. **App-update channel for self-hosters**: this design pins app updates to
   spawnd.dev (§6). Acceptable, or does the open-source posture require a documented
   build-your-own-channel path at launch?
5. **Windows**: confirm it stays out of scope until a daemon Windows build exists —
   the download page already says so; the app shouldn't imply otherwise.
6. **Menu-bar-only vs Dock**: MVP proposes menu-bar-only (`ActivationPolicy::Accessory`)
   with windows only during the wizard. Some users expect a Dock icon; cheap to make
   it a setting, but the default is a product-voice call.
