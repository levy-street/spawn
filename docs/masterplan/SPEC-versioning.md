# SPEC: SPAWN D release identity, compatibility, and self-update

Repo: /Users/charliesaxton/dev/spawn (branch native-daemon-fixes-auto-update-daemon).
Read the root CLAUDE.md and the CLAUDE.md of every folder you touch first.
Product name in user-facing copy is exactly `SPAWN D`.

## Problem

Four pieces ship separately: server+web (one deploy), the daemon binaries
(rolling `prebuilt-latest` release published to the server by the deploy),
the mobile JS (EAS OTA), and the mobile native build. Nothing today compares
what a client runs against what the server expects. The daemon reports
`0.1.0+g<commit>` on register and the server stores it, but no side acts on
it. The server emits `{"type":"protocol.required"}` + close 4003 when a
websocket subprotocol is too old, but the daemon never even reads it (its
handshake check fails first and it reconnects forever with backoff), the web
client ignores it, and mobile only treats it as a permanent close. A stale
browser tab keeps running old JS after a deploy; an old daemon silently stops
working after a wire change.

## Design in one paragraph

Every piece carries a **content identity** stamped at build time, and the
server publishes the identities it was deployed with at `GET /api/release`.
The daemon's identity is the git **tree hash of `daemon/`** (changes iff any
file under daemon/ changes); the web bundle's identity is its Next build id
(the deploy pins it to the commit); the mobile bundle's identity is the git
tree hash of `mobile/`. A client that finds its identity differs from the
server's is **outdated** and updates itself: the daemon downloads the
binaries the server serves, verifies them, swaps them atomically and
re-execs (sessions survive — workers are separate processes and are
re-adopted); the web tab prompts to reload (auto-reloads on a hard protocol
refusal); the phone fetches the OTA update through expo-updates and prompts
to restart (or points at the App Store when the native runtime is too old).
The server also auto-pushes a daemon update at registration, and every
`protocol.required`/4003 becomes an update trigger rather than a dead end.
The release process writes the identities (CI publishes `TREE`, deploy writes
the prebuilt manifest, the OTA script bakes the mobile tree) and a
`verify-release.sh` proves all three match after a release.

## Identities

| piece | identity | where stamped | how the server learns its expected value |
|---|---|---|---|
| daemon | `daemon_tree` = `git rev-parse HEAD:daemon` (40 hex; suffix `-dirty` when `git diff --quiet HEAD -- .` in daemon/ fails) + existing `version` `0.1.0+g<commit12>` | `daemon/build.rs` → `SPAWND_DAEMON_TREE` env → `version.rs` | `daemon/target/prebuilt/manifest.json`, written by `scripts/deploy-prod.sh` from the `prebuilt-latest` release's `COMMIT`/`TREE`/`VERSION`/`SHA256SUMS` |
| web tab | Next build id (`SPAWN_BUILD_ID`, pinned to the deployed commit by deploy-prod.sh; `spawn` in dev) | `next.config.ts` exposes it as `NEXT_PUBLIC_SPAWN_BUILD_ID` | reads `web/.next/BUILD_ID` from the repo checkout at startup |
| mobile JS | `mobile_tree` = `git rev-parse HEAD:mobile` | `mobile/app.config.ts` → `extra.mobileTree` (from `EXPO_PUBLIC_SPAWN_MOBILE_TREE`, else computed with git when available) | `git rev-parse HEAD:mobile` in the repo checkout at startup (env override `SPAWN_MOBILE_TREE`) |
| mobile native | `runtimeVersion` (= `expo.version` in `mobile/app.json`, policy appVersion) | expo | reads `mobile/app.json` at startup |
| server | commit (`git rev-parse HEAD`, env override `SPAWN_RELEASE_COMMIT`) | — | — |

Dev rule: when an identity is unknown/dirty on either side, **no update is
advertised or prompted**. Nagging in dev is a bug.

## Wire contracts (exact)

### `GET /api/release` (public, no auth, `Cache-Control: no-store`)

```json
{
  "server": {"commit": "3b1f…40hex" , "dirty": false},
  "web": {"build_id": "3b1f…40hex"},
  "daemon": {
    "version": "0.1.0+g3b1f2c4d5e6f",
    "commit": "3b1f…40hex",
    "tree": "9a8b…40hex",
    "targets": {
      "darwin-aarch64": {"spawnd_sha256": "…64hex", "spawn_worker_sha256": "…64hex"},
      "darwin-x86_64":  {"spawnd_sha256": "…", "spawn_worker_sha256": "…"},
      "linux-x86_64":   {"spawnd_sha256": "…", "spawn_worker_sha256": "…"},
      "linux-aarch64":  {"spawnd_sha256": "…", "spawn_worker_sha256": "…"}
    }
  },
  "mobile": {"tree": "c0de…40hex", "runtime_version": "0.1.0"},
  "protocols": {"daemon": "spawn.control.v3", "browser": "spawn.v3", "alerts": "spawn.alerts.v1"}
}
```

- `server.commit`, `web.build_id`, `mobile.tree` are `null` when unknown.
- `daemon` is `null` when there is no prebuilt manifest (dev). Only targets
  present in the manifest AND on disk are listed.
- Served by a new route module `server/spawn_server/routes/release.py`; the
  values come from a new `server/spawn_server/release.py` (computed once,
  cached; `refresh()` for tests; manifest re-read is cheap and may be
  re-stat'd per request so a deploy's publish step is picked up live —
  `install.py` already reads prebuilts live without a restart).

### Prebuilt manifest — `daemon/target/prebuilt/manifest.json` (written by deploy)

```json
{
  "commit": "40hex",
  "tree": "40hex",
  "version": "0.1.0+g<commit12>",
  "targets": {
    "darwin-aarch64": {"spawnd_sha256": "64hex", "spawn_worker_sha256": "64hex"},
    "…": {}
  }
}
```

The server treats a manifest as valid only if every listed target's files
exist on disk under `daemon/target/prebuilt/<target>/` and their sha256
matches (hash lazily, cache by mtime+size). A mismatch → log an error and
treat as no manifest (never advertise an update you cannot serve).

### Daemon `register` (daemon → server) — new fields, all optional for old daemons

```json
{"type":"register", "host_name":"…", "os":"macos", "arch":"aarch64",
 "version":"0.1.0+g3b1f2c4d5e6f",
 "daemon_tree":"9a8b…40hex",
 "self_update": true,
 "self_update_blocked": null,
 "existing_sessions":[…], "spec":{…}, "supports_account_chains":true}
```

`self_update` is true when the daemon can replace itself (see daemon
preconditions); otherwise false with a short class-only reason in
`self_update_blocked` (`"disabled"`, `"unwritable"`, `"unsupported_target"`,
`"worker_missing"`). Server validates field by field; unknown/invalid → treat
as absent.

### `daemon.update` (server → daemon)

```json
{"type":"daemon.update", "request_id":"<uuid>",
 "version":"0.1.0+g3b1f2c4d5e6f", "tree":"9a8b…40hex", "target":"darwin-aarch64",
 "spawnd":       {"path":"/api/install/spawnd/darwin-aarch64",       "sha256":"64hex"},
 "spawn_worker": {"path":"/api/install/spawn-worker/darwin-aarch64", "sha256":"64hex"}}
```

`path` is a **path**, never a URL: the daemon joins it onto the server origin
it is already talking to and refuses anything with a scheme or host. Old
daemons fail to deserialize the unknown frame type and discard it (verified:
`ws::classify` → `MalformedJson` → warn + continue), so sending it is safe.

### `daemon.update_result` (daemon → server)

```json
{"type":"daemon.update_result", "request_id":"<uuid>", "ok":true,
 "tree":"9a8b…40hex", "version_before":"0.1.0+g0ld…", "stage":null, "error":null}
```

`ok:false` carries `stage` ∈ `download|verify|swap|exec|precondition` and a
short class-only `error` (no paths, no server-supplied text). After `ok:true`
the daemon execs the new binary and re-registers; the server expects the new
register within 3 minutes with `daemon_tree == tree`.

### `HostOut` (server → web/mobile) — new fields

```json
"daemon_tree": "9a8b…|null",
"update": {
  "state": "current|available|updating|failed|unsupported|unknown",
  "latest_version": "0.1.0+g…|null",
  "error": "string|null",
  "requested_at": "iso|null"
}
```

State is computed at read time:
- no valid manifest → `unknown`
- `host.daemon_tree` is null → `unsupported` (daemon predates self-update; `error` = "This daemon is too old to update itself")
- `host.daemon_tree == manifest.tree` → `current`
- `host.update_state == "updating"` and `requested_at` within 3 min → `updating`
- `host.update_state == "failed"` and `host.update_tree == manifest.tree` → `failed` (with `error`)
- `host.self_update` is false → `unsupported` (`error` from `self_update_blocked`, humanised)
- otherwise → `available`

### `POST /api/hosts/{id}/update` (owner)

- host online + `available`/`failed` → send `daemon.update`, set
  `update_state=updating`, `update_tree=manifest.tree`, `update_requested_at=now`,
  clear `update_error`; return **202** with `{"update": {...}}`.
- already `current` → **200** with `{"update": {...}}` (no-op).
- daemon offline → **409** `{"detail":"host daemon is offline"}`.
- `unsupported`/`unknown` → **409** with the reason in `detail`.
- Rate: at most one request per host per 15 s (429 otherwise).

### Auto-update at register (server)

After sending `registered`, if the computed state is `available` and
`settings.daemon_auto_update` (new, default `True`) → send `daemon.update`
and record state `updating` exactly as the endpoint does. Never auto-resend
while a `failed` record exists for the same manifest tree (the user retries
from the UI, or a new release changes the tree). When a daemon re-registers
with `daemon_tree == update_tree` while `update_state == updating` → clear
to current (`update_state=null`). When it re-registers with a *different*
tree than `update_tree` while updating → `failed`, `error="restarted on the
previous binary"`.

### Websocket `protocol.required` / close 4003 — client behaviour

- **daemon**: a control-socket handshake refused for subprotocol (the
  existing "server did not select the required websocket subprotocol" error)
  or a 4003 close → run the HTTP self-update path: `GET /api/release`; if
  `daemon` is present and `daemon.tree != own tree` and own target is listed
  → download/verify/swap/exec exactly like the frame path. If it cannot
  update → log at error level once per hour, including the reinstall command
  `curl -fsSL <server>/install.sh | sh`, and back off 5 minutes between
  attempts (not the 60 s cap).
- **web**: any of the three sockets closed with 4003 → dispatch
  `window.dispatchEvent(new CustomEvent("spawn:client-stale", {detail:{hard:true}}))`
  and stop that socket's reconnect loop. The ReleaseWatcher shows the hard
  dialog and reloads.
- **mobile**: `socket.ts` already treats 4003 as permanent; additionally
  emit through a small `subscribeProtocolRequired()` in `data/realtime/socket.ts`
  so the ReleaseWatcher runs the hard update flow.

## Daemon self-update (daemon/src/update.rs, new)

Preconditions (evaluated at start and again before applying):
1. `SPAWND_NO_SELF_UPDATE` unset/empty (else `disabled`).
2. `std::env::current_exe()` resolves; its parent directory is writable by
   this process (create+remove a probe file) (else `unwritable`).
3. The worker binary resolves (`worker_backend::worker_bin()` or the
   equivalent existing resolver) to a file in a writable directory (else
   `worker_missing`/`unwritable`).
4. `(std::env::consts::OS, ARCH)` maps to a supported target
   (`macos`→`darwin`; `aarch64`, `x86_64`) (else `unsupported_target`).

Apply (single in-flight guard; a second request while one runs → result
`ok:false, stage:precondition, error:"busy"`):
1. Resolve URLs: `server_origin + path`; refuse if `path` has a scheme/host or
   does not start with `/api/install/`.
2. Download both to `<dir>/spawnd.tmp.<pid>` and `<dir>/spawn-worker.tmp.<pid>`
   with reqwest (rustls), 5-minute overall timeout, 256 MiB cap, sha256 while
   streaming; compare to expected (stage `download`/`verify`).
3. `chmod 755`; run `<tmp spawnd> --version` with a 15 s timeout; require exit
   0 and output ending in the expected `version` string (stage `verify`; a
   binary that cannot run on this host — glibc etc. — fails here, and the old
   binary stays).
4. Swap atomically: rename `spawnd` → `spawnd.prev`, tmp → `spawnd`; same for
   the worker. Any failure rolls back completed renames (stage `swap`). Remove
   `*.prev` only after the *next* successful startup (i.e. at daemon start,
   delete stale `.prev` files older than this binary).
5. Send `daemon.update_result ok:true`, flush the outbound channel, close the
   WS cleanly, then `exec` the new binary with the original argv
   (`std::os::unix::process::CommandExt::exec` — same PID, so launchd
   KeepAlive and systemd see nothing). If exec fails (stage `exec`), the
   process is still the old binary: log and continue running; the swapped
   files are the new ones, so the next supervisor restart picks them up.
6. Log every stage at info; errors class-only.

Startup: delete stale `spawnd.prev`/`spawn-worker.prev` beside the binary.

Also expose `spawnd update` as a CLI subcommand that runs the HTTP path once
(for humans and the install script).

## Web (web/)

- `next.config.ts`: `env.NEXT_PUBLIC_SPAWN_BUILD_ID = buildId()`.
- `src/lib/release.ts`: `ReleaseSchema` (zod, tolerant of nulls),
  `fetchRelease()`, `clientBuildId()`, `webIsStale(release)` (false when
  either side is null or the client id is `spawn`), tests beside it.
- `src/components/release/ReleaseWatcher.tsx` (client component mounted in
  `AppProviders`): checks on mount, every 5 min, on `visibilitychange`→visible,
  on `online`, and on `spawn:client-stale`. Soft stale → `Dialog`
  "SPAWN D has been updated" / body "Reload to pick up the new version. Open
  terminals reconnect on their own." / buttons **Reload** (primary) and
  **Later** (snooze 30 min in sessionStorage). Hard (4003) → same dialog, no
  Later, "Reloading in N s…" countdown (10 s) then reload. Reload =
  `navigator.serviceWorker?.getRegistration().then(r => r?.update())` best
  effort, then `location.reload()`.
- `src/components/release/HostUpdateDialog.tsx` + `useHostUpdate(host)`:
  shows for a host whose `update.state` is `available|updating|failed|unsupported`
  when the user opens the host page or picks the host to launch a session /
  open files. Copy:
  - available: title "Update SPAWN D on {name}"; body "This machine is running
    an older SPAWN D daemon ({version}). Update it to keep working with this
    version of the app. Running sessions are kept." Buttons **Update now**
    (POST `/api/hosts/{id}/update`, then poll `hosts.get` every 2 s until
    `current`/`failed`, max 3 min) and **Not now**.
  - updating: spinner, "Updating… the daemon restarts itself; sessions keep
    running."
  - failed: "The update did not complete: {error}. Run this on the machine:"
    + code block `curl -fsSL {origin}/install.sh | sh` with a Copy button;
    buttons **Try again**, **Close**.
  - unsupported: "This daemon cannot update itself ({error}). Run this on the
    machine:" + the same command; **Close**.
  - offline (status offline and state available): "This machine is offline.
    It updates itself the next time it connects." **Close**.
- Host list rows / pickers (`new-session-menu`, `launcher-fab`, Sidebar host
  list, legion, host page Facts): a small `Badge` "update available" /
  "updating" using existing `Badge` variants; no new primitives.
- `src/lib/api.ts`: `HostSchema` gains `daemon_tree`, `update` (with
  defaults so older mocks parse); `hosts.update(id)`; `release.get()`.
- 4003 handling in `alert-socket.ts`, `hostControl.ts`, `useSessionSocket.ts`
  (only the onclose code check + dispatch + stop reconnect).
- e2e mocks (`tests/e2e/app-mocks.ts`) get the new host fields with
  `state:"current"`.
- `web/CLAUDE.md`: add `release/` to the components list.

## Mobile (mobile/)

- `app.config.ts`: `extra.mobileTree` from `EXPO_PUBLIC_SPAWN_MOBILE_TREE`,
  else `git rev-parse HEAD:mobile` via `child_process.execSync` guarded by
  try/catch (undefined when git is unavailable).
- `src/data/api/schemas/release.ts`, `src/data/api/endpoints/release.ts`
  (`getRelease()`, `auth:false`), `src/data/queries/release.ts`
  (`useRelease`), key `qk.release()` in `data/queryKeys.ts`.
- `src/lib/updates.ts`: thin wrapper over `expo-updates` (`isEnabled`,
  `checkForUpdateAsync`, `fetchUpdateAsync`, `reloadAsync`,
  `runtimeVersion`) that no-ops in Expo Go / dev; `clientMobileTree()` from
  `Constants.expoConfig.extra.mobileTree`.
- `src/lib/release-watcher.tsx` (mounted in `AppProviders` under
  `ToastProvider`): checks on foreground (AppState active), every 15 min,
  and on protocol-required. Logic:
  - `runtime_version` differs from ours → Dialog "Update SPAWN D" / "This
    version of SPAWN D no longer works with the server. Update it from the
    App Store." **Open App Store** (link `itms-apps://…` with the app id if
    known, else `https://apps.apple.com/`), **Later** (soft only).
  - `mobile.tree` differs from ours → `checkForUpdateAsync()`; if available →
    `fetchUpdateAsync()` in the background, then Dialog "SPAWN D has been
    updated" / "Restart to pick up the new version." **Restart now**
    (`reloadAsync`) / **Later** (snooze 30 min). If no update is available
    yet (OTA not published), stay silent and retry on the next check.
  - hard (4003) → same dialogs without Later; if no OTA is available, show
    the App Store dialog.
- Host update dialog mirrors the web copy exactly, using `ui/dialog` and
  `ui/button`; `updateHost(id)` endpoint + `useUpdateHost` mutation; polling
  as on web. Shown from host detail and when launching on / opening files of
  an outdated host; "update available"/"updating" `Chip`/`Badge` on host rows
  and legion cards.
- `HostOutSchema` gains `daemon_tree` and `update` (nullable/defaulted).
- Native-only note: the App Store path is native-only; say so in the commit.
- `mobile/CLAUDE.md`: mention `release-watcher`/`updates` under `lib/`.

## Server (server/)

- `release.py`, `routes/release.py` (register in `main.py`).
- `models.py` `Host`: `daemon_tree String(64)`, `self_update Boolean
  default False server_default false`, `self_update_blocked String(64)`,
  `update_state String(16)`, `update_tree String(64)`, `update_error
  String(500)`, `update_requested_at DateTime(timezone=True)`. Alembic
  `0062_host_daemon_update.py`, single head.
- `schemas.py`: `HostUpdateOut`, `HostOut.daemon_tree`, `HostOut.update`;
  `ReleaseOut` and children.
- `ws/daemon.py`: parse the new register fields (validate types), persist
  them in `_prepare_host_activation`, compute state, auto-send
  `daemon.update`, handle `daemon.update_result`, reconcile on re-register.
- `ws/broker.py`: `request_daemon_update(conn, payload)` (fire-and-forget
  send with the same bounded-send pattern as `request_host_ping`).
- `routes/hosts.py`: `POST /{host_id}/update`; `HostOut` population must
  attach `update` everywhere hosts are serialised (list, get, patch).
- `routes/install.py`: read the manifest via `release.py` for the sha256
  case arms when present (fallback to hashing as now).
- `config.py`: `daemon_auto_update: bool = True`, `release_commit: str | None`,
  `mobile_tree: str | None`.
- Tests: `tests/test_release.py` (endpoint shapes, manifest validation, dirty
  handling), `tests/test_ws_daemon.py` (register persists fields, auto-update
  frame, result handling, reconcile), `tests/test_hosts.py` (update endpoint
  codes), `tests/test_install.py` (manifest-driven pins).
- `server/CLAUDE.md`: add `release` to routes and `release.py` to concerns.

## Release process (scripts/, .github/, docs/)

- `.github/workflows/prebuilt.yml` publish job also writes `TREE`
  (`git rev-parse HEAD:daemon` — needs a checkout step in the publish job) and
  `VERSION` (run the linux-x86_64 binary: `out/spawnd-x86_64-unknown-linux-gnu --version | awk '{print $2}'`).
- `scripts/deploy-prod.sh`:
  - preflight: also require `TREE == git rev-parse $remote_ref:daemon`
    (keeps the existing tree-diff check as the fallback when TREE is absent).
  - **hard gate**: before touching production, fetch the current
    `daemon/target/prebuilt/manifest.json` from the host (`ssh cat`, may be
    absent). If the daemon tree at `$remote_ref` differs from the host's
    current manifest tree AND prebuilts cannot be published (release missing,
    checksum failure, stale COMMIT/TREE) → `die` with the reinstall
    guidance; `SPAWN_DEPLOY_PREBUILTS=0` remains the explicit override and
    prints a loud warning that daemons will not auto-update.
  - after scp: write `manifest.json` on the host atomically (tmp + mv) with
    commit/tree/version and the sha256 of each published file (from
    SHA256SUMS).
  - post-deploy smoke: also `GET $origin/api/release` and require
    `server.commit == new full sha` and, when prebuilts were published,
    `daemon.tree == expected tree`; print the mobile reminder when
    `git diff --quiet $old_rev $new_rev -- mobile` fails: "mobile/ changed —
    run scripts/update-mobile-prod.sh -m '<same message>'".
- `scripts/update-mobile-prod.sh`: export
  `EXPO_PUBLIC_SPAWN_MOBILE_TREE="$(git rev-parse HEAD:mobile)"`, prove the
  evaluated config carries `extra.mobileTree`, prove the served manifest
  carries it.
- `scripts/verify-release.sh <server-url>` (new): checks (1) `/api/release`
  `server.commit == git rev-parse origin/master` (or `--ref`), (2)
  `daemon.tree == git rev-parse <ref>:daemon` and served binaries hash to the
  advertised sha256 (reuse verify-prebuilts logic or call it), (3) the
  u.expo.dev manifest's `extra.mobileTree == git rev-parse <ref>:mobile`.
  Exit non-zero with a per-piece table. `test-all.sh` runs it under the
  optional `SPAWN_HTTP_SMOKE_URL` block.
- `scripts/smoke-install-prebuilt.sh`: also assert `/api/release` returns
  `daemon: null` without a manifest and a populated `daemon` once a manifest
  is written next to the built binary (write one in the smoke).
- `docs/RELEASE.md`: new section "Versions and compatibility" (the model
  above, in operator terms), the manifest, `verify-release.sh` as the last
  step of every release, and what a user sees when a piece is left behind.
- Pin script behaviour in `server/tests/test_update_mobile_script.py`
  (mobileTree bake + served proof) and a new
  `server/tests/test_deploy_prod_script.py` only if one already exists in
  spirit (otherwise a bash `--self-test` for the manifest writer function).

## Path ownership (workers never run git; the orchestrator commits)

- **S server**: `server/spawn_server/**` (except nothing), `server/alembic/**`,
  `server/tests/**` except `test_update_mobile_script.py` and
  `test_deploy_prod_script.py`, `server/CLAUDE.md`.
- **D daemon**: `daemon/**`, `daemon/CLAUDE.md`.
- **W web**: `web/**`, `web/CLAUDE.md`.
- **M mobile**: `mobile/**`, `mobile/CLAUDE.md`.
- **R release**: `.github/workflows/**`, `scripts/**`, `docs/RELEASE.md`,
  `server/tests/test_update_mobile_script.py`,
  `server/tests/test_deploy_prod_script.py`.

## Verification each worker must run

- server: `cd server && .venv/bin/ruff check . && .venv/bin/python -m pytest -q tests/test_release.py tests/test_ws_daemon.py tests/test_hosts.py tests/test_install.py` then the full `pytest -q` once at the end; `alembic heads` shows one head.
- daemon: `cd daemon && cargo fmt && cargo clippy --locked -- -D warnings` (at least on touched modules) and `cargo test --locked update` / `cargo test --locked --bin spawnd ws::` / `run::` filters — the full suite hangs on this Mac (known: `upload::tests::concurrent_same_owner…`), so run module filters, and `cargo build --locked --release`.
- web: `cd web && npm run lint && npx tsc --noEmit && npx --package=bun bunx bun test src` (there is no global bun on this Mac).
- mobile: `cd mobile && npm run ci`.
- release: `bash -n scripts/*.sh`, the script self-tests, and `cd server && .venv/bin/python -m pytest -q tests/test_update_mobile_script.py`.
