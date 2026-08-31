# DESIGN: SPAWN D daemon CLI/TUI, install UX, and end-to-end onboarding

Read-only investigation + design, 2026-08-25, branch `native-daemon-fixes-auto-update-daemon`.
Companion docs: `docs/TRUST_UX.md` (ceremony rules — nothing here weakens them),
`scratchpad/reports/DESIGN-multiaccount.md` §3 (QR / pairing push / Add-a-machine — built on, not duplicated),
`scratchpad/SPEC-connection.md` (W2 #11-12, M2 #12 — connection-state surfacing already specced there).

---

# Part 1 — What exists today

## 1.1 Daemon CLI surface

Subcommands (`daemon/src/cli.rs:31-49`): `possess`, `exorcise`, `login`, `run`, `update`, `logout`, `status`.
Global flags: `--server` (env `SPAWN_SERVER_URL`), `--config-dir`, `-v/-vv` (`cli.rs:9-29`).
**There is no colour, no spinner, no progress indicator, and no `--json` anywhere in the daemon.**
All human output is bare `println!` with a `spawn: ` prefix; logs go to stderr via tracing (`main.rs:75-92`).

### What each command prints

| Command | Output (verbatim) | Evidence |
|---|---|---|
| `possess` (fresh) | login flow output (below), then `spawn: possessed as <account>. daemon running in the background.` | `possess.rs:102` |
| `possess` (resume) | `spawn: already possessed (<account>); daemon running in the background.` + a relogin hint naming the exact `spawnd login --no-run --server … --config-dir …` command | `possess.rs:50-55`, `possess.rs:281-287` |
| `exorcise` | `spawn: exorcised.` / `spawn: exorcised N instance(s).` | `possess.rs:157,173` |
| `login` | On open: `spawn: opened your browser to approve this host.` / else `spawn: approve this host in your browser — open this link on any device:` then the URL; then 5 lines explaining the `#k=` fragment + fingerprint; then `can't use the link? … "enter a pairing code" and type: <CODE>`; then `spawn: waiting for approval…`; on success `spawn: logged in. host_id = <uuid>` + `spawn: browser approval proof verified` + `spawn: verify browser fingerprint: <fp>` | `login.rs:112-136,180,416,429,435` |
| `run` | **Nothing on stdout, ever.** tracing only (`grep println run.rs` → zero hits). Auth failures, revoked creds, unreachable server all vanish into log files / journald. | `run.rs`, `ws.rs` |
| `update` | `SPAWN D daemon update not applied (<reason>).` or bails `SPAWN D daemon update failed: <stage>: <error>` | `update.rs:334-341` |
| `logout` | `spawn: removed <path>` / `spawn: no stored credentials` — **wipes the whole record including the host identity seed and browser pins** (`cli.rs:45-46`) | `creds.rs:1466-1470` |
| `status` | 7 static lines: `server: / configured: / logged in: / host_id: / host key: / fingerprint: / browser pins: N` — **no liveness, no service state, no instance list** | `creds.rs:1545-1600` |

### The `#k=` mechanics (the security spine — must survive any redesign)

`login.rs:222-249 (approval_url)`: the daemon parses `verification_uri` from `device/start`, **refuses a
cross-origin approval page**, appends `?ref=<approval_ref>` (or `?code=<user_code>` pre-0029), and sets the
fragment `#k=<host_public_key>` **locally**, overwriting anything server-supplied. Fragments never transit
HTTP, so the browser's check of the server-claimed key against `#k` is out-of-band (`login.rs:205-221`).
`open_browser` (`login.rs:254-278`) uses `open`/`xdg-open`; on Linux it skips when no `DISPLAY`/`WAYLAND_DISPLAY`
(headless) and the caller prints the URL. **This unconditional open is the "NEW browser window" complaint** —
the daemon has no knowledge of an already-open onboarding tab, and the server has no channel to tell it.

### Failure behaviour today (all as raw anyhow chains on stderr, `Error: …`)

- Server unreachable / DNS / TLS: `POST /api/auth/device/start: error sending request …` (reqwest debug text).
- Wrong URL (an HTML page): `decoding device/start response: expected value at line 1 column 1`.
- Expired code: `device code expired; run \`spawnd login\` again` (`login.rs:193`) — the one good message.
- Denied: `login was denied` (`login.rs:196`).
- `key_conflict` / `pin_conflict` / `pin_limit`: fall through to `device/poll returned error: key_conflict`
  (`login.rs:198-200`) — jargon, no remedy. Server emits these at `routes/device.py:425,459+26,459+120,459+137`.
- Revoked creds while running: **silent**. `run` reconnects forever with backoff (`ws.rs:313-323`,
  1s→60s cap); a 401 is just another retry. Nothing reaches the user or the web host page except "Offline".
- Service install denied: `systemctl --user enable --now <unit> failed` bail (`service.rs:144-146`);
  launchd failures are swallowed (`service.rs:243-253` best-effort).

## 1.2 install.sh (`server/spawn_server/routes/install.py:160-683`)

Served at `/install.sh` with the server origin templated in. As a user experience:

- Pure `sh`, `say()` = `spawn: <msg>` lines, `die()` to stderr. **No colour, no steps, no spinner.**
- Flags: `--server/--repo/--branch/--no-login/--no-start/--no-service/--foreground/--prebuilt-only` (`:200-219`).
- Happy path: download prebuilt spawnd + spawn-worker for the detected target (`:477-504`), sha256-pinned
  against server-templated case arms (`:444-451`, fail-open when no pin/tool), `--version` sanity check, then
  **`exec spawnd --server <URL> possess`** (`:682`) — possess owns login + service.
- **The source-build fallback is the silence trap**: on any prebuilt miss it apt/dnf/brew-installs git +
  compilers (`:329-359`, sudo prompts mid-pipe), installs rustup (`:389-403` — curl|sh inside curl|sh),
  then `cargo install` (`:405-420`) — **many minutes of raw cargo output or near-silence**, unannounced.
- Errors are one-liners with decent remedies (`die "cargo $_ver is too old (need >= 1.88); update Rust …"`,
  `:386`) but no visual distinction from progress lines.
- Legacy paths `start_launchd_service` / `start_systemd_service` / `start_background` (`:514-637`) only run
  under `--no-service`/`--foreground`; the default is possess-owned service install (`service.rs`).
- Note: `install.sh` intentionally ignores `SPAWN_SERVER_URL`-style env for the server (only `--server`);
  the mobile app builds the command from its configured base URL (`install-instructions.tsx:15-18`), web from
  `window.location.origin` (`web/src/lib/platform.ts:22-28`).

## 1.3 Web onboarding + device auth flow

- Steps: `account → verify → host → done`, derived purely from live state (`step-machine.ts:18-23`), so a
  pairing completed in *another tab* advances this one — the plumbing for "the old tab catches up" half-exists.
- Host step: `ConnectHostSection` (`onboarding-flow.tsx:306-319`) = install command + "Enter a pairing code"
  form + a status dot polling `hosts.list` every 3 s: `Waiting for your machine…` → `<name> is online.`
  (`connect-host.tsx:109-124,194-201`). `onHostOnline` fires the success beat and `done` auto-creates a
  workspace and redirects (`onboarding-flow.tsx:200-215`).
- The daemon-opened link lands on **`/device`** (`web/src/app/device/page.tsx`) — a full `AuthGate`+`AppShell`
  page hosting the same `ConnectHostSection` with `autoLoadFromUrl` — which reads `?ref=`/`?code=` + `#k=`
  (`connect-host.tsx:45-51,323-339`), runs the invisible key check, and shows the one-click
  `Approve <host>` screen (`:584-653`) or the terminal refusal (`:53-61,489-504`). Fallback (no fragment):
  full-fingerprint compare via the shared `NumberCheck` frame (`:654-684`; `number-check.tsx:102-120`).

### Why a NEW tab, precisely

1. `spawnd possess` → `login::run` → `open_browser(approve_url)` (`login.rs:112`) — `open <url>` **always
   opens a new tab/window in the default browser**; the CLI cannot address an existing tab.
2. The onboarding tab has no knowledge of the pending ceremony: `device/start` is unauthenticated and the
   `DeviceCode` row is **bound to no account until approval** (`routes/device.py:125-139`). There is no
   "list pending possession-verified codes for my account" endpoint — `POST /api/auth/device/pending`
   requires already knowing the `approval_ref` or `user_code` (`device.py:459+195-234`), which live only in
   the terminal and the daemon-built URL.
3. `/ws/alerts` forwards only `agent.finished`, `agent.awaiting_input`, `session.died`
   (`ws/alerts.py:ALERT_EVENTS`) plus the trust events `device.approval_requested/resolved`
   (`trust_events.py:25`) — those are **browser-device knocks, not host pairings**. Nothing on any socket
   says "a host wants to pair".
4. So the onboarding tab can only ever notice the *end* of the story (the host flipping online via the 3 s
   hosts poll), never the middle (approval needed) — and the daemon, knowing nothing, always opens a new tab.

Second-order rough edges of the current shape:

- The `/device` tab is a full app page; after approving, the user is stranded there ("done" NumberCheck
  state) while the *onboarding* tab concurrently jumps into a fresh workspace — two tabs, both claiming
  to be the continuation.
- If the default browser isn't signed in (or is a different browser/profile than the one mid-onboarding),
  `/device` shows `AuthGate` sign-in; whether the `#k=` fragment survives the login redirect (and especially
  an OAuth round-trip) is unverified — a dropped fragment silently downgrades to the fingerprint path.
- The onboarding waiting dot violates TRUST_UX's own "waiting states never strand" rule: no elapsed-time
  hint, no "having trouble?" escape, ever.

## 1.4 Mobile onboarding

- Same derived rail (`onboarding-flow.tsx (mobile):100-108`); the host step splits: hosts exist → this-device
  approval (`DeviceApprovalBody`), no hosts → `HostPairingStep` (`:170-186`).
- `HostPairingStep` stages: `instructions → code → review → failure/success` (`host-pairing-step.tsx:39`),
  with a full failure catalogue (`trust-failure-state.tsx:15-80` — the best remediation copy in the product)
  and the endorsement path ("a device you already trust vouches for the host") on the instructions screen.
- **Copy bug:** instructions step 2 says "After installation, run **spawnd login** on that machine."
  (`install-instructions.tsx:110`) and code entry says "**spawnd login** shows an eight-character code"
  (`pairing-code-entry.tsx:33-35`) — but the install one-liner already ends in `spawnd possess`, which runs
  login itself and *opens a browser on the Mac* (useless mid-phone-flow) while the phone waits for a typed
  code. Web says `spawnd possess` (`connect-host.tsx:178`). The two frontends teach different commands.
- No push for host pairing (the knock push exists only for device approvals, `push.py:91-101,172-181`), no QR.

## 1.5 Flow permutations, walked as a user

| # | Flow | What happens | Rough edges |
|---|---|---|---|
| a | Sign up on web → install on same machine | Onboarding `host` step → copy one-liner → script downloads → `possess` → **new tab** `/device?ref=…#k=` → one-click Approve → daemon stores token → host online → old tab's 3 s poll flips to `done`, summons workspace | Two tabs; stranded `/device` tab post-approval; new tab may hit a signed-out browser/profile; onboarding tab shows nothing during the whole install+approve middle; source-build fallback = minutes of silence; waiting dot strands forever on any failure |
| b | Sign up on web → install on headless box (SSH) | `possess` can't open a browser (`login.rs:263-266`), prints a ~180-char URL with fragment + the 8-char code | Copying the URL out of tmux wraps/mangles the fragment (→ silent downgrade or `REFUSAL_MALFORMED`); no QR (designed in DESIGN-multiaccount §3, unbuilt); onboarding tab never suggests "paste the link here / type the code here" although the code form is right on it |
| c | Install daemon first, no account | `possess` → new tab `/device` → `AuthGate` → sign-up → back to approve | Fragment survival across the auth redirect (and OAuth especially) unverified; 30-min TTL is fine, but if sign-up wanders into onboarding, onboarding tells them to install the daemon they just installed (pending ceremony ≠ host, so `deriveStep` still says `host`) |
| d | Sign up on iPhone → install on a Mac | Phone shows install cmd + "run spawnd login" + typed 8-char code path; Mac's `possess` meanwhile opens Safari on the Mac | Wrong command taught (`login` vs `possess`); a browser tab opens on the Mac that the flow never mentions; typing 8 chars is the *primary* phone path though push+deep-link and QR are both designed; if the Mac tab is signed in (same account) both surfaces race to approve |
| e | Second machine, existing account | Same as (a)/(b) but no onboarding tab exists | No permanent "Add a machine" surface (web: `/device` is unreachable from nav; mobile: install-instructions only in onboarding) — per DESIGN-multiaccount §3 friction 3; user must remember the URL or re-find onboarding |
| f | Reinstall / recovery on a machine that had SPAWN D | Creds intact → `possess` resumes silently and prints the relogin hint (good). Creds revoked server-side → **service starts and loops 401 silently forever**; web just shows Offline. Creds wiped + key retained by *another* account → `key_conflict` surfaced as `device/poll returned error: key_conflict` | No detection of "registered but rejected"; `status` says `logged in: yes` while the token is dead; key_conflict has no human words and no remedy anywhere (CLI, web, or mobile) |
| g | Terminal closed mid-login | Ceremony expires in 30 min (`device.py:25-27`); staging dir left behind; re-running `possess` cleans and restarts (`possess.rs:61-63`) — correct but unexplained | Onboarding tab waits forever with no hint; an already-open approval tab later errors `user code is expired` (`device.py:459+214-216`) with no "ask the machine for a fresh code" next step |

## 1.6 Health / diagnosis inventory

- `spawnd status`: static credential dump only (§1.1). No "is the daemon actually running/connected".
- No `spawnd doctor` or anything like it. `run`'s connect-failure classification (`dns/tcp/tls/…`) is specced
  in SPEC-connection D2 #10 but as *logging*, not UX.
- Web: `runDiagnosticRefresh` saves a terminal diag bundle to the host (`web/src/lib/diagnostics.ts`);
  `storage-diagnostics.ts` probes IndexedDB/WebCrypto persistence. Both are session/browser-side.
- Mobile: `diagnostics-sheet.tsx` — transport state, secure context, connection path, RTT.
- SPEC-connection already owns *connection-state* surfacing (W2 #11-12 reconnect banner + retry-ladder reset;
  M2 #12 connection-info in header/diagnostics) — this design does **not** re-spec those; it adds the
  *setup/identity/host-level* health story they don't cover: "why is my host offline / rejected / stale".
- Server: host rows carry `status` and `version`; there is no `last_disconnect_reason`, and daemon-side
  setup errors have no channel to the web/mobile host pages at all.

---

# Part 2 — The design

Copy rules throughout: the product is **SPAWN D** in prose; technical names stay `spawnd`. Brand voice:
flavour headings and prose, keep prompts/verbs standard (repo memory). Possess/exorcise stay. Nothing below
touches the ceremony's security properties: the `#k=` fragment path, the origin check, the fingerprint
fallback ("never a weaker check"), possession-before-approval ordering, and terminal mismatch states are
all preserved exactly.

## 2.1 CLI command set

Final list (aliases in parens are visible in help; clap `visible_alias`):

| Command | Semantics |
|---|---|
| `possess` (`setup`) | Unchanged: register + background service, idempotent. Gains: TUI presentation (§2.2), QR (§2.3), attended hand-off (§2.3), `--qr/--no-qr`. |
| `exorcise` (`remove`) | Unchanged (`--all` kept). Gains a confirm prompt on a TTY (`--yes` to skip): names what will be removed. |
| `login` | Unchanged semantics (`--no-run` kept). Same presentation gains as possess. |
| `run` | Unchanged; adds a SIGHUP handler = drop WS + reconnect now with backoff reset; writes the heartbeat state file (below). |
| `status` | Extended (spec below): liveness, service state, sessions, update state, instance listing per DESIGN-multiaccount. `--json`. |
| `doctor` | **New.** 14 health checks, pass/warn/fail + one-line remedy each; exit 1 on any fail; `--json`. |
| `reconnect` | **New.** Bounce the connection now: if the heartbeat pid is alive → SIGHUP; else (re)start the service (`launchctl kickstart -k` / `systemctl --user restart`, workers survive via KillMode=process); else tell the user the one command that fixes it. |
| `disconnect` | **New.** Stop the background daemon and its autostart without removing anything. Prints what stays (creds, identity, N running sessions that stay alive but unreachable) and how to come back (`spawnd reconnect`). |
| `logout` | **Changed semantics.** Stops the service, removes the access token, **keeps the host identity seed, browser pins, and server URL** so `spawnd login` re-attaches the same host with one approval. `--wipe-identity` restores today's full wipe. (Today's logout discards the identity, which strands a dead Host row and invites key-claim confusion on re-login — `creds.rs:1453-1471`.) |
| `reset` | **New.** The local recovery hammer for corrupt/revoked state: confirm (TTY; `--yes`), stop + remove service files, terminate workers (named count, second confirmation if any are running), wipe the config dir(s) — creds, identity, pins, heartbeat. Never talks to the server (that's the point: it works when auth is broken). Ends by printing: "This machine is clean. The old entry may still show under Hosts on the web — remove it there. To set up again: `spawnd possess`." Distinction vs `exorcise`: exorcise = polite teardown incl. server deregistration; reset = local-only, works when nothing else does. |
| `update` | Unchanged; presentation joins the TUI system. |
| `help` | clap grouped help with examples (template below). |

**Heartbeat state file** (enables status/doctor/reconnect liveness without an IPC socket):
`<config_dir>/state.json`, written by `run` atomically every 30 s and on transitions:
`{pid, version, connected: bool, connected_at, server, last_error: {kind, detail, at} | null, sessions: n}`.
`kind` reuses D2 #10's classification (`dns|tcp|tls|http|auth|protocol`). `auth` is set on a 401/4001-class
rejection — that's what finally makes revoked creds *visible* (permutation f).

### Top-level help (`spawnd help`, exact text)

```
spawnd — the SPAWN D daemon. It possesses a machine and answers to your account.

Usage: spawnd [OPTIONS] <COMMAND>

Summoning:
  possess      Register this machine and keep it running in the background.
               Safe to re-run at any time.                       [alias: setup]
  exorcise     Deregister this machine and remove the daemon.   [alias: remove]

Every day:
  status       What this machine knows: account, connection, service, sessions.
  doctor       Run every health check; each failure comes with its fix.
  reconnect    Drop and re-establish the server connection right now.
  disconnect   Stop the background daemon. Nothing is removed.
  update       Apply the latest SPAWN D release.

Account:
  login        Re-run the browser approval for this machine.
  logout       Sign this machine out. Its identity is kept for next time.
  reset        Wipe all local SPAWN D state on this machine. Last resort.

Advanced:
  run          Run the daemon in the foreground (what the service runs).

Options:
  --server <URL>       spawn server (default: the one this machine registered with)
  --config-dir <PATH>  instance directory — one per account on shared machines
  -v, -vv              more detail in logs
  -h, --help           this help;  spawnd <command> --help for one command

Examples:
  curl -fsSL https://spawnd.dev/install.sh | sh    install and possess, one line
  spawnd possess                                   set this machine up (or resume)
  spawnd doctor                                    my host shows offline — why?
  spawnd exorcise                                  undo everything possess did
```

Per-command `--help` follows the same shape: one sentence of what, the flags, one or two examples. Notable
exact copy:

- `spawnd doctor --help` example line: `spawnd doctor --json   # for scripts and support bundles`
- `spawnd reset --help` warning paragraph: "This removes this machine's SPAWN D identity, sign-in, and
  approvals — but never your files or the sessions' working directories. The server is not contacted."

### `spawnd status` (extended, exact layout)

```
SPAWN D on mac-studio
  account      9f1c2d3e (charlie)               # dir name; label if cached
  server       https://spawnd.dev
  connection   connected · 42 min · last error: none
  service      running (launchd app.spawn.spawnd.3f9ac3e1)
  sessions     2 running
  version      0.4.2 · up to date
  host key     SHA256:Yr0kQ…   (fingerprint: shown in full with -v)
  browser pins 3

Other instances on this machine: none
```

Degradations: `connection  not running — start with: spawnd reconnect`;
`connection  retrying (tls: certificate expired) — see: spawnd doctor`;
`connection  rejected by server (signed out) — fix with: spawnd login`.
`--json` emits the same data as one object. Multi-instance: one block per account dir
(`possess.rs:247-263` enumeration), exactly as DESIGN-multiaccount's status listing asks.

### `spawnd doctor` (checks, order, remedies)

Each check prints one line: glyph + name + finding; failures append `  ↳ fix: <one action>`. Warns don't
affect exit code; any fail → exit 1. `--json` for support.

| # | Check | Method | Fail remedy (exact copy) |
|---|---|---|---|
| 1 | credentials | `creds::load()` parses | `↳ fix: spawnd reset, then spawnd possess` |
| 2 | signed in | token present | `↳ fix: spawnd login` |
| 3 | server reachable | GET `/api/health`, classify dns/tcp/tls/proxy | dns: `↳ fix: check the server address — spawnd status shows it`; tls: `↳ fix: this machine's clock or CA store — see checks 9 and 10` |
| 4 | server is SPAWN D | health body shape | `↳ fix: --server points at something else (a proxy login page?) — re-run install with the right URL` |
| 5 | sign-in accepted | GET `/api/hosts/self` with token | 401: `↳ fix: this machine was signed out or removed — spawnd login to re-approve it` |
| 6 | live connection | WSS handshake to `/ws/daemon` (connect, protocol accept, close) | `↳ fix: a proxy or firewall is blocking WebSockets on 443` |
| 7 | background service | unit/plist exists + `systemctl is-active` / `launchctl print` | `↳ fix: spawnd reconnect (reinstalls and starts the service)` |
| 8 | daemon heartbeat | state.json fresh (<90 s) + pid alive | `↳ fix: spawnd reconnect` |
| 9 | clock | `Date` header vs local, warn >2 min, fail >5 | `↳ fix: enable automatic date & time — TLS and sign-in both break on a skewed clock` |
| 10 | worker binary | spawn-worker found + `--version` == spawnd's | `↳ fix: reinstall — curl -fsSL <server>/install.sh \| sh` (uses `update::reinstall_command`, `update.rs:377-382`) |
| 11 | self-update ready | `classify_preconditions` (`update.rs:409-441`) | unwritable: `↳ fix: the install dir isn't writable; updates will be skipped` (warn) |
| 12 | version | vs release manifest | warn: `an update is available — spawnd update` |
| 13 | file permissions | config dir writable, credentials 0600 | `↳ fix: chmod 600 <path>` |
| 14 | media path (UDP) | STUN bind probe to configured ICE servers, 2 s | warn: `UDP looks blocked; terminals may fail to connect from outside this network` (TURN/TCP is unavailable — SPEC-connection D2 #12 — so this is warn + honest, not fixable here) |

Header/footer: the logo mini-mark, then `SPAWN D doctor — mac-studio, 0.4.2`, checks, then either
`Everything checks out.` or `N problems found. Fixes are listed above; run spawnd doctor again after.`

## 2.2 TUI presentation

### Dependency choices (binary size first)

- **Colour: zero new crates.** clap 4.5 (default features) already brings `anstyle`/`anstream` into the tree;
  use `anstream::stdout()`/`stderr()` + `anstyle` styles. anstream gives NO_COLOR, `CLICOLOR_FORCE`, and
  non-TTY stripping for free and matches clap's own styled help.
- **Spinner: hand-rolled** (~30 lines): braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms on **stderr**, only when
  `std::io::stderr().is_terminal()` (std `IsTerminal`, no crate); finalises the line with the ✓/✗ glyph +
  elapsed time. No indicatif (drags `console`/`unicode-width`; we need one spinner, not progress bars).
- **QR: `qrcode` crate**, default-features off (no `image`) — pure Rust, renders to unicode half-blocks;
  ~tens of KB. The single justified addition.
- install.sh: pure POSIX — colour via `printf '\033[…m'` gated on `[ -t 1 ] && [ -z "${NO_COLOR:-}" ]` and
  `tput colors` ≥ 8 when tput exists; spinner via a background `while` printing `\r` frames, killed on step
  end; **never** when non-TTY (curl-piped stdout is a TTY in the normal `| sh` case since sh inherits the
  terminal, but a CI pipe isn't — the guard covers both).

### Rules (both the daemon and install.sh)

1. Styled output goes to stdout, the spinner to stderr; logs stay tracing/stderr.
2. Non-TTY or NO_COLOR ⇒ exactly today's plain `spawn: …` lines. **The plain text of every line is identical
   in both modes** — colour and glyphs decorate, never replace. Every line stays greppable
   (`grep '^spawn:'` keeps working: in TTY mode the prefix is still printed, styled).
3. Steps are numbered `[1/4]`, `[2/4]`… on multi-step commands (install, possess, update).
4. One accent, used sparingly. Palette (basic ANSI so every terminal renders it):
   - **accent / brand** — red (31; bright-red 91 for the logo core) — the web's ember/hellfire family
   - **ok** — green (32) `✓` · **warn** — yellow (33) `!` · **fail** — red (31) `✗`
   - **step** — bold default `[1/4]` · **dim/meta** — bright-black (90) · **values** (codes, fingerprints,
     URLs) — bold default, never coloured (colour on a fingerprint invites misreading)
5. Waiting states always show elapsed time after 30 s and a hint after 60 s ("Still waiting — is the browser
   open? The link is above; the code works on any device.") — TRUST_UX's never-strand rule, applied to the CLI.
6. The logo appears at the start of `possess`/install and atop `doctor` — never on everyday commands, never
   non-TTY, never when the terminal is under 60 cols.

### The logo (≤12 lines, a summoning circle around the trident)

```
            .  ·  ✦  ·  .
        ·                   ·
     ·        \  |  /          ·
    ·          \ | /            ·
   ·        ─── \|/ ───          ·      S P A W N  D
   ·             |               ·      ──────────────
   ·             |               ·      your machine, possessed
    ·           /|\             ·
     ·      ── ┘ | └ ──        ·
        ·        |          ·
            ·  ·  ✦  ·  ·
```

(Trident strokes and the ring dots take the accent red; `✦` bright-red; the wordmark bold; the tagline dim.
Pentagram-adjacent but abstract — a circle of marks around the trident the app already uses as its glyph.
ASCII-safe fallback (no `·✦┘└`) ships beside it for non-UTF-8 locales; both ≤12 lines, ≤40 cols, so the
wordmark column fits in 80.)

### Mock transcript 1 — the install one-liner, end to end (TTY, prebuilt path)

```
$ curl -fsSL https://spawnd.dev/install.sh | sh

            .  ·  ✦  ·  .            S P A W N  D
        (logo as above)              your machine, possessed

spawn: [1/4] Checking this machine          ✓ macOS · arm64
spawn: [2/4] Downloading SPAWN D            ✓ spawnd + spawn-worker 0.4.2, verified
spawn: [3/4] Registering this machine       ⠸ waiting for your approval…

spawn:   Approve this machine in the browser tab that just opened —
spawn:   or open this link on any device:
spawn:     https://spawnd.dev/device?ref=Xk2…#k=hJd8…
spawn:   No browser here? In the app choose “enter a pairing code”: QZ4K-7HMT

spawn: [3/4] Registering this machine       ✓ approved from Chrome on mac-studio
spawn: [4/4] Starting the background daemon ✓ running (starts on login)

spawn: mac-studio is possessed. Your sessions are one tab away.
spawn:   status: spawnd status · health: spawnd doctor · undo: spawnd exorcise
```

Source-build fallback inserts, before [2/4] completes:
```
spawn: [2/4] Downloading SPAWN D            ! no prebuilt for linux-riscv64
spawn:        Building from source instead — this takes several minutes
spawn:        ⠴ compiling (12 min max, log: /tmp/spawn-install.4821/build.log)
```
(cargo output goes to the log file; the spinner line updates with the current crate count when available.)

### Mock transcript 2 — `spawnd possess` on a headless box (QR + waiting)

```
$ spawnd possess
spawn: [1/2] Registering this machine       ⠸ waiting for your approval…

spawn:   Scan this with your phone, or open the link on any device:

     █▀▀▀▀▀█ ▀▄█ ▄▀▀ █▀▀▀▀▀█        (QR encodes the full approval URL
     █ ███ █ ██▄▀▄█▄ █ ███ █         INCLUDING the #k= identity part —
     █ ▀▀▀ █ ▄▀ █ ▀▄ █ ▀▀▀ █         it never touches the server)
     ▀▀▀▀▀▀▀ █ ▀ █ ▀ ▀▀▀▀▀▀▀
     …

spawn:     https://spawnd.dev/device?ref=Xk2…#k=hJd8…
spawn:   Or in the app: “enter a pairing code” → QZ4K-7HMT
spawn:   If asked to compare a fingerprint, it must be exactly:
spawn:     SHA256:Yr0kQmVd…

spawn:   ⠼ waiting for approval — 1 min elapsed  (code expires in 29 min)
spawn: [1/2] Registering this machine       ✓ approved from iPhone
spawn: [2/2] Starting the background daemon ✓ running (starts on boot)
spawn: headless-01 is possessed.
```

### Mock transcript 3 — a failure with remediation (`key_conflict`)

```
spawn: [1/2] Registering this machine       ✗ this machine's key belongs to another account

spawn: This machine was set up before, under a different SPAWN D account, and
spawn: that account still holds its identity. Nothing was changed.
spawn:   • To use it under THAT account: sign in there and approve as usual.
spawn:   • To hand it to THIS account: remove the host from the old account's
spawn:     Hosts page first, then run  spawnd possess  again.
spawn:   • To keep both accounts on this machine:  spawnd possess --config-dir <new dir>
```

### Mock transcript 4 — `spawnd doctor`

```
$ spawnd doctor
SPAWN D doctor — mac-studio, 0.4.2

  ✓ credentials        readable, one account (9f1c2d3e)
  ✓ signed in          token present
  ✓ server reachable   https://spawnd.dev (TLS ok, 34 ms)
  ✓ server is SPAWN D  api healthy
  ✗ sign-in accepted   the server rejected this machine (signed out or removed)
      ↳ fix: spawnd login   (one browser approval re-attaches it)
  ✓ live connection    WebSocket handshake ok
  ! background service loaded but not running
      ↳ fix: spawnd reconnect
  – daemon heartbeat   skipped (service not running)
  ✓ clock              within 1 s of the server
  ✓ worker binary      spawn-worker 0.4.2 (matches)
  ✓ self-update        install dir writable
  ✓ version            up to date
  ✓ file permissions   credentials are 0600
  ! media path         UDP to the relay looks blocked; terminals may not
                       connect from outside this network
1 problem found. Fixes are listed above; run spawnd doctor again after.
```

## 2.3 The auth hand-off, and every permutation

### The mechanism (permutation a — the user's headline complaint)

The pending ceremony is account-less by design, so the fix is to give the ceremony a *routing hint* the
already-open tab minted — a **setup claim** — while every grant of trust stays exactly where it is.

1. **Mint.** The onboarding host step (and the permanent Add-a-machine surfaces) calls
   `POST /api/setup/claims` (authenticated) → `{token, expires_in: 1800}`. The token is embedded in the
   displayed command: `curl -fsSL https://spawnd.dev/install.sh | sh -s -- --setup <token>`; install.sh
   passes it through as `SPAWN_SETUP_TOKEN` to `possess`, which forwards it on `device/start`
   (`DeviceStartRequest` gains optional `setup_token`). A bare `spawnd possess` (no token) behaves as today.
2. **Bind + notify.** The server stores the token on the `DeviceCode` row and, **the moment the possession
   proof lands** (`device.py:162-247` — the same point DESIGN-multiaccount hangs its push on), resolves
   token → minting user and (a) marks the claim `ready` with `{approval_ref, host_name, os,
   host_key_fingerprint}`, and (b) publishes a trust event `host.pair_requested` on that user's alerts
   channel (added to `trust_events.py`'s forwardable set alongside `device.approval_requested`;
   `host.pair_resolved` on approval/expiry). Note the fingerprint the claim carries is server-derived —
   the same value `/pending` already serves — it is *display* data; the check below never trusts it alone.
3. **The tab morphs.** The onboarding host step polls `GET /api/setup/claims/{token}` every 2 s while
   visible (baseline; the alerts event is the low-latency upgrade where the socket exists — onboarding
   doesn't mount AppShell today, so polling is the dependable path). On `ready` it stops saying "Waiting
   for your machine" and renders the approve UI **inline**: it feeds `approval_ref` to the existing
   `POST /api/auth/device/pending` → `PairingCodeForm`'s review path (`connect-host.tsx:265-311`). No
   fragment reached this tab, so this is by definition the **fingerprint-compare frame** — the
   TRUST_UX-sanctioned fallback ("never a weaker check", §4) against the fingerprint the terminal prints
   (`login.rs:126-127`). Copy on the inline card: *"Fastest: open the link in the machine's terminal — it
   verifies the identity automatically. Or compare the fingerprint below against the terminal."*
4. **The daemon stops fighting the tab.** `device/possession`'s response gains `attended: bool` (true iff a
   setup claim from a live authenticated session is bound). When `attended`, `login.rs` **does not
   auto-open the browser**; it prints the link + code as fallback and starts polling. If the poll is still
   `authorization_pending` after **25 s**, it opens the browser as today (the tab may have been closed).
   Unattended ceremonies keep today's open-immediately behaviour.
5. **After approval**, both surfaces converge exactly as now: daemon poll succeeds, host comes online, the
   onboarding tab's existing hosts-poll → success beat → workspace. The stranded-`/device`-tab problem
   disappears because `/device` never opens in flow (a).

Security review of the mechanism: the setup token grants nothing — it routes a notification, pre-fills a
lookup the user could already do with the typed code, and suppresses one `open(1)` call. Approval still
requires the signed browser approval proof (`device.py:459+358-364`), possession-before-approval is
untouched, the `#k=` path is untouched wherever a browser does open, and the inline path is the existing
full-fingerprint ceremony. A stolen token lets an attacker at most surface *their* host's fingerprint in
the victim's tab — exactly what the typed-code path already allows — and the fingerprint compare is the
defence in both. This is deliberately NOT the rejected "pre-authorised device code" (DESIGN-multiaccount
§3): approval stays a post-possession, human, per-ceremony act.

### Permutations (b)–(g), designed

- **(b) headless/SSH:** `possess` detects no opener (existing logic) → prints the **QR** (transcript 2) —
  the QR carries the fragment terminal→camera→browser with no HTTP hop, preserving out-of-band (this is
  DESIGN-multiaccount §3's S item, adopted here as part of the possess TUI). The onboarding/Add-a-machine
  tab, having minted a claim, *also* goes `ready` (the token travelled via the pasted command) → the user
  can finish inline on the laptop with the fingerprint compare, scan with the phone, or type the code.
  Three doors, one ceremony each.
- **(c) daemon-first, no account:** unchanged entry (`/device` → AuthGate). Two hardenings: (i) the
  `/device` page stashes `ref` + `#k` fragment in `sessionStorage` before redirecting to login and restores
  them after — the fragment must survive email/password *and* OAuth round-trips (today unverified; after
  OAuth the fragment is otherwise gone and the flow silently downgrades); (ii) after approval on `/device`,
  if the account has zero workspaces, offer "Continue setup" → `/onboarding` (which will now derive `done`).
  Onboarding's host step also learns to show a `ready` claim *or* an already-pending-approved host —
  covering "I installed before signing up".
- **(d) phone-first:** fix the command mismatch — mobile teaches `spawnd possess` (same commit as any copy
  change, both frontends). Phone flow gains the **pairing push** (DESIGN-multiaccount §3): with a setup
  claim minted on the phone, possession-verified triggers a push "mac-studio is ready to join your account"
  → deep link `spawn://device?ref=…` → the existing `FingerprintReview` (`fingerprint-review.tsx`) pre-filled
  via `/pending`. The typed 8-char code remains the no-push fallback. The Mac-side auto-open is suppressed
  by `attended` (the phone's claim), so Safari no longer pops uninvited on the Mac (step 4 above).
- **(e) second machine:** the permanent **Add a machine** surfaces (DESIGN-multiaccount §3, adopted):
  web — a button on the Hosts page opening the same ConnectHostSection (which mints a claim); mobile — the
  same entry on the hosts tab (`PairingScreen` already exists for this; it becomes reachable outside
  onboarding). Both then behave exactly like (a)/(d).
- **(f) reinstall/recovery:**
  - Revoked-while-running becomes visible end to end: `run` writes `last_error.kind = "auth"` to the
    heartbeat on server rejection → `status` says `rejected by server (signed out) — fix with: spawnd login`
    → doctor check 5 fails with the same remedy → the web/mobile host page shows it (§2.5).
  - `key_conflict` gets transcript 3's copy at the CLI, and the web/mobile approve surfaces map the
    `key_conflict`/`pin_conflict`/`pin_limit` poll errors to the same three-option copy (error catalogue).
  - `possess` resume path stays silent-and-fast (good) but appends one line when the heartbeat shows
    `auth` errors: `spawn: note — the server is rejecting this machine's sign-in. Run: spawnd login`.
- **(g) closed terminal mid-login:** the CLI waiting state now names the expiry ("code expires in 29 min")
  and Ctrl-C prints `spawn: stopped. Nothing was registered — run spawnd possess to start again.`; the web
  waiting dot gains the 60 s hint ("Having trouble? Re-run the install command — it's safe to repeat.");
  an expired-code approval attempt on web/mobile says "That code expired. On the machine, run
  `spawnd possess` again for a fresh one." (replacing the raw `user code is expired`).

## 2.4 Error catalogue

Columns: where it's detected → the exact user-facing line (CLI form; web/mobile reuse the same sentence,
minus the `spawn:` prefix) → where it surfaces. One action per message; no jargon (no "poll", "device
code", "pin", "claim").

| # | Failure | Detection | Message (CLI) | Surfaces |
|---|---|---|---|---|
| 1 | DNS: server name unresolvable | reqwest error chain classified `dns` (login + doctor 3) | `✗ Can't find <host>. Check the server address — spawnd status shows what this machine uses.` | CLI, doctor |
| 2 | TCP refused / timeout | classified `tcp` | `✗ <server> didn't answer. Is the machine online? A firewall or VPN may be blocking it.` | CLI, doctor |
| 3 | TLS failure | classified `tls` | `✗ Secure connection to <server> failed. If this machine's clock is wrong, fix that first (spawnd doctor checks it).` | CLI, doctor |
| 4 | Wrong URL (HTML/JSON-shape mismatch) | `device/start` decode error, doctor 4 | `✗ <server> answered, but it isn't a SPAWN D server. Re-run the install command from the app — it carries the right address.` | CLI, doctor |
| 5 | Proxy 502/503 | HTTP status | `✗ <server> is having trouble (HTTP 502). Try again in a minute.` | CLI, doctor |
| 6 | Approval code expired | poll `expired_token` (`login.rs:192-194`); web/mobile lookup 400 | CLI: `✗ The approval expired before anyone finished it. Run spawnd possess again for a fresh one.` Web/mobile: `That code expired. On the machine, run spawnd possess again.` | CLI, web `/device`, mobile pairing |
| 7 | Approval denied | poll `denied` | `✗ The approval was declined in the browser. Nothing was registered.` | CLI |
| 8 | key_conflict | poll `key_conflict` (`device.py:425,459+26`) | transcript 3's three-option block | CLI; web/mobile approve error state with the same 3 options |
| 9 | pin_conflict | poll `pin_conflict` (`device.py:459+120`) | `✗ The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.` | CLI, web |
| 10 | pin_limit | poll `pin_limit` (`device.py:459+137`) | `✗ This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.` | CLI, web |
| 11 | Signed out / revoked while running | 401-class WS/API rejection → heartbeat `auth` | status: `rejected by server (signed out) — fix with: spawnd login`; doctor 5; host page: `mac-studio can't sign in. On that machine, run: spawnd login` | status, doctor, **web+mobile host page** |
| 12 | Service install denied | systemctl/launchctl failure (`service.rs:144,243`) | `✗ Couldn't install the background service (<detail>). The daemon still works in the foreground: spawnd run. To retry the service: spawnd reconnect.` | CLI |
| 13 | No systemd user session / no linger | doctor 7 detail | `! The daemon will start at login, not at boot. To fix: loginctl enable-linger $USER` | doctor, install.sh |
| 14 | Prebuilt won't run (old glibc etc.) | install.sh `--version` probe (`install.py:493-499`) | `spawn: the prebuilt daemon can't run here (older system libraries). Building from source instead — several minutes.` (with `--prebuilt-only`: `…; re-run without --prebuilt-only to build from source.`) | install.sh |
| 15 | cargo too old / rust missing | install.sh (`install.py:366-403`) | existing lines, restyled: `✗ cargo 1.74 is too old (need 1.88+). Update Rust (brew upgrade rust / rustup update), then re-run.` | install.sh |
| 16 | sha256 mismatch on prebuilt | install.sh (`install.py:463-475`) | `! The downloaded daemon didn't match the server's checksum. Not installed. Trying a source build; if this repeats, tell whoever runs your server.` | install.sh |
| 17 | Clock skew | doctor 9 | `✗ This machine's clock is 7 min off. Sign-in and secure connections both break — enable automatic date & time.` | doctor |
| 18 | UDP blocked | doctor 14 probe | `! UDP to the relay looks blocked; terminals may not connect from outside this network.` | doctor, and the host page's helper panel |

Rule for new failures: every terminal error names (1) what happened, (2) what was/wasn't changed
("Nothing was registered"), (3) exactly one next action. The trust-failure copy on mobile
(`trust-failure-state.tsx`) already follows this shape — web adopts the same catalogue verbatim where the
same states exist (its `FAILURE_COPY` map is the shared source of truth to mirror, per the
both-frontends rule).

## 2.5 Web/mobile helper surfaces

1. **Live install progress in onboarding / Add-a-machine** (both frontends, same commit). The waiting dot
   becomes a four-step checklist driven by the setup claim + hosts poll:
   `Command copied → Machine registered (claim: ready) → Approved (claim: resolved) → Online (hosts poll)`.
   Each step has a stalled-state hint after 60 s (e.g. stuck on "registered": "The machine is waiting for
   your approval below." — because at that point the inline approve card is already showing).
2. **The inline approve card** (§2.3 step 3) in onboarding and Add-a-machine: fingerprint frame + typed-code
   entry + "a link also opened on the machine" note. Mobile equivalent: the pairing push → `FingerprintReview`.
3. **Host page "Something wrong?" panel** (web host detail + mobile host-detail-view), shown whenever the
   host is offline or degraded. Server additions (minimal): `Host.last_disconnect_at`,
   `Host.last_disconnect_reason` (close-code class recorded at the `/ws/daemon` write site — the same site
   SPEC-connection S2 #8 touches), and the existing `version` + `last_seen`. The panel renders a remote
   mini-doctor from what the server can know: last seen, daemon version (with "outdated" badge vs release
   manifest), last disconnect reason in plain words, and the one action:
   - never connected: "SPAWN D hasn't checked in from this machine yet. On it, run: `spawnd doctor`" (copyable)
   - auth-rejected: "mac-studio can't sign in. On that machine, run: `spawnd login`"
   - stale version: "mac-studio runs 0.3.9. On it, run: `spawnd update` (or it will self-update when idle)."
   - plain offline: "Last seen 2 h ago (connection dropped). If the machine is on, run `spawnd doctor` there."
   Deliberately **not** built: any remote-execution of doctor — the daemon is offline in exactly the cases
   that matter, so the panel's job is to put the right command in the user's clipboard. (When the host IS
   online, the panel collapses to version + latency, deferring to SPEC-connection's live indicators.)
4. **Waiting states never strand** (TRUST_UX rule, applied): every waiting surface in this flow — CLI wait,
   web checklist steps, mobile code entry — gains the elapsed-time hint and an escape after 60 s.
5. Copy inventory kept in lockstep: the install command, the "run `spawnd possess`" line, checklist labels,
   and catalogue sentences ship in web and mobile in the same commit (repo rule); mobile's
   `install-instructions.tsx:110` `spawnd login` → `spawnd possess` is the first such fix.

---

# Part 3 — Implementation cut-list

S ≈ ≤1 day, M ≈ 2-4 days, L ≈ 1-2 weeks. Order within tiers = dependency order.

**Tier 1 — the complaint, addressed (do first)**

| # | Item | Size | Where |
|---|---|---|---|
| 1 | Setup claims: `POST/GET /api/setup/claims`, `DeviceCode.setup_token`, `attended` in possession response, claim resolution at possession-verified + approve; `host.pair_requested/resolved` trust events | M | server |
| 2 | install.sh `--setup` passthrough (`SPAWN_SETUP_TOKEN`); `device/start` forwards it; daemon `attended` → suppress auto-open + 25 s fallback timer | S | server(script) + daemon |
| 3 | Onboarding host step: claim mint, 2 s claim poll, checklist, inline approve card (reuse `PairingCodeForm` review path), 60 s hints, expired-code copy | M | web |
| 4 | Mobile: same checklist + claim mint on `HostPairingStep`; fix `spawnd login`→`possess` copy; expired-code copy | S | mobile |
| 5 | `/device` fragment survival across AuthGate/OAuth (sessionStorage stash+restore) + post-approve "Continue setup" | S | web |
| 6 | Pairing push on possession-verified with a bound claim → deep link → `FingerprintReview` (per DESIGN-multiaccount §3) | M | server + mobile |

**Tier 2 — CLI/TUI**

| # | Item | Size | Where |
|---|---|---|---|
| 7 | TUI kit in daemon: anstyle/anstream wiring (no new deps), spinner, step lines, NO_COLOR/non-TTY rules, logo | M | daemon |
| 8 | Heartbeat `state.json` from `run` (+ SIGHUP = reconnect-now) | S | daemon |
| 9 | `spawnd status` extension + `--json` + instance listing (DESIGN-multiaccount) | S | daemon |
| 10 | `spawnd doctor` (14 checks, `--json`) — reuses D2 #10 error classification and `classify_preconditions` | M | daemon |
| 11 | `reconnect` / `disconnect` / new `logout` semantics (keep identity; `--wipe-identity`) / `reset` | M | daemon |
| 12 | Error catalogue in `login`/`possess` (key_conflict, pin_conflict, pin_limit, expired, denied, dns/tcp/tls/proxy classification) | M | daemon |
| 13 | QR in `possess`/`login` (qrcode crate, headless auto + `--qr`) | S | daemon |
| 14 | Help texts (grouped template, aliases `setup`/`remove`, per-command examples) | S | daemon |
| 15 | install.sh restyle: colours/steps/spinner with tty+NO_COLOR guards, source-build announcement + build log, restyled remedies (catalogue #14-16) | M | server(script) |

**Tier 3 — health surfaces**

| # | Item | Size | Where |
|---|---|---|---|
| 16 | `Host.last_disconnect_at/reason` recorded at `/ws/daemon` write site; expose on hosts API | S | server |
| 17 | Host-page "Something wrong?" panel (web + mobile, same commit), incl. auth-rejected + stale-version states | M | web + mobile |
| 18 | Permanent Add-a-machine surfaces (Hosts page button on web; hosts-tab entry to `PairingScreen` on mobile) — per DESIGN-multiaccount §3 | S | web + mobile |
| 19 | `exorcise` confirm prompt; possess resume auth-note; Ctrl-C copy in login wait | S | daemon |

Dependency notes: 3/4 depend on 1-2; 6 depends on 1; 9-11 depend on 8; 17 depends on 16 (and on 8 for the
auth-rejected signal reaching the server as a close reason). Item 12 is independent and high-value.
Crate additions: **qrcode only**. Everything else rides clap's existing anstyle family and std `IsTerminal`.

Open questions for Charlie (small): (1) alias names — `setup`/`remove` vs `connect`/`disconnect` pairing
(this design avoids `connect` because `disconnect` means "stop the service", not "exorcise"); (2) should
`reset` also delete session worker scrollback dirs (this design: yes, with the confirmation naming the
running-session count); (3) doctor check 14's UDP probe — ship in v1 or defer until SPEC-connection's ICE
work lands (this design: ship as warn-only).
