# Working agreements for spawn

Read this before changing anything. `AGENTS.md` is a symlink to this file, so
there is one copy and it cannot drift.

## The map

```
web/      Next.js browser app                → web/CLAUDE.md
mobile/   Expo / React Native app            → mobile/CLAUDE.md
desktop/  Tauri v2 macOS + Windows companion → desktop/CLAUDE.md
server/   FastAPI API + websockets + Alembic → server/CLAUDE.md
daemon/   Rust spawnd + spawn-worker         → daemon/CLAUDE.md
proto/    cross-runtime golden vectors shared by daemon and web crypto
scripts/  deploy, health, smoke, and guard scripts; test-all.sh runs the lot;
          ci/ owns self-hosted runner images, pool control and platform setup
infra/    docker-compose and nginx examples
docs/     design docs; docs/RELEASE.md — the release process,
          docs/WINDOWS_VALIDATION.md — the Windows evidence gate, and
          docs/AZURE_SIGNING_SETUP.md — the Windows signing identity, for
          whoever holds Azure
tools/    development utilities
.github/  CI workflows: tests, native connection acceptance and its promotion
          gate, the rolling daemon prebuilts, the Windows check
          and its unsigned packaging rehearsal, and the signed desktop
          artifacts; readme/ holds the README's press art, struck from
          web/public/brand/ink
```

Each product folder has its own `CLAUDE.md` (with an `AGENTS.md` symlink
beside it) describing its layout, where new things go, and its checks. Read
the one for the folder you are changing before you change it.

## spawn has two frontends. A change to one is a change to both

`web/` (Next.js) and `mobile/` (Expo/React Native) are two clients of the same
API. They are not a primary and a port — a person signs in on the phone and
picks the session up in the browser an hour later, and anything present in one
place and missing from the other reads as a bug rather than a roadmap.

So any user-facing change ships in both, in the same commit:

- a new screen, control, or flow
- copy, labels, empty states, error messages
- validation rules and what counts as a valid input
- anything read from `/api/auth/config` or another shared endpoint

Both have their own idiom and neither should be a transliteration of the other.
Match the surrounding code — `web/` uses Tailwind and server components,
`mobile/` uses the `@/theme` tokens and the shared `ui/` primitives. Shared
*meaning* stays identical; shared *markup* is not a goal.

When something genuinely belongs to one platform — Face ID unlock, a
`WebAuthn` ceremony that needs a browser — say so in the commit message. An
unexplained one-sided change is indistinguishable from a forgotten one.

Check both before calling a change done:

```bash
cd web    && npm run lint && npx tsc --noEmit
cd mobile && npm run ci        # typecheck + lint + jest
cd server && .venv/bin/ruff check . && .venv/bin/python -m pytest -q
```

## The product is called SPAWN D

The folder is `spawn` and the daemon is `spawnd`; the product is neither. In
anything a person reads — screen copy, error messages, permission prompts,
notification text, passkey and OAuth labels — the name is **SPAWN D**, set
exactly like that: capitals, a space, no trailing period. So "SPAWN D needs
camera access", "Back to SPAWN D", "while SPAWN D is closed".

Lower-case `spawnd` is still right where it names a technical thing: the
daemon and its CLI (`spawnd login`), the server it talks to ("a spawnd
server"), and the domain `spawnd.dev`. Identifiers never change for this:
the URL scheme, the storage keys, package names and paths stay `spawn`.

Bare lower-case "spawn" as the product name is a bug, in either frontend.

## Releasing

Before deploying or releasing anything — server, web, a mobile update or
build, daemon prebuilts — read `docs/RELEASE.md` in full. It is the entire
release process: what ships together, what the deploy script refuses and why,
and how to verify what actually reached production.

Connection acceptance runs through `.github/workflows/acceptance.yml`: exact
candidate iOS/Android native runs plus the isolated daemon canary. Missing or
failed evidence blocks promotion. `docs/CONNECTION_CANARY.md` describes the
canary, and `docs/DEVICE_CONNECTIONS.md` distinguishes automated native
evidence from physical-device and production observations. The lightweight
fixture, UDP fault-proxy and evidence-validator regressions run in
`scripts/test-all.sh`; the real native builds run on our platform runners.
Native fixtures prepare build configuration before compilation and activate
their daemon only after app installation. Unexpected fixture process exits
permanently fail acceptance; they are not silently restarted.
After fixture readiness, native app boot has a separate 180-second budget;
local startup diagnostics and scoped device captures preserve setup failures.

Every workflow uses the explicit self-hosted pools in `docs/CI_RUNNERS.md`.
Linux jobs run in one-job containers; Mac and Windows build/release services
use separate standard accounts. Keep wait jobs on their own pool so they cannot
occupy a builder they are waiting for. `scripts/ci/check-self-hosted.py` rejects
hosted fallbacks, and the runner/disk regressions run in `scripts/test-all.sh`.
Signing environments, exact-commit checks and release evidence remain required.
Linux x64 build and Android jobs require the `spawn-minivac` placement label in
addition to their capability labels. This prevents legacy Multivac registrations
from receiving them. Minivac uses disposable disk workspaces and a 6 GiB builder
limit; Android stays disabled until KVM and concurrent memory capacity are verified.
Linux CI wraps `scripts/test-all.sh` with disposable PostgreSQL 16 and Redis 7
fixtures, and sets `SPAWN_E2E_WORKERS=2` for its four-CPU container quota.
Mac setup uses `scripts/ci/prepare-macos-accounts.py` to keep generated account
passwords in the operator Keychain and install the release hook under a root-owned
directory. `check-macos-runner.py` checks role identity and policy protection before
registration; account and private password-prompt regressions run in `test-all.sh`.
All Linux jobs run on Minivac. `scripts/ci/build-linux-arm64.sh` cross-compiles
ARM64 outputs there against Ubuntu 22.04 and checks their execution with QEMU.
The builder keeps its real X64 runner label. Dispatch `test.yml` with
`arm64_only=true` for ARM64 binary validation without publication; its concurrency
group is separate from the full suite, and both share one bounded build slot.
The earlier Minimac Linux VM configuration is retained as historical setup
material; it is no longer an active CI pool. macOS jobs remain on Minimac.

## These files stay true, or they are worse than nothing

People and agents plan work from the CLAUDE.md files, so a stale one misroutes
every change that follows it. Two rules keep them honest:

- A commit that changes structure — a directory added, renamed, or moved — or
  changes a convention or a command, updates the owning CLAUDE.md **in the
  same commit**. The tree change and its documentation are one change, never
  two.
- `scripts/check-claude-md.sh` enforces the structural half mechanically:
  every git-tracked directory under a documented root must be named in the
  CLAUDE.md that owns it. `scripts/test-all.sh` runs it with the other
  guards. When it fails, the fix is updating the CLAUDE.md — not widening the
  guard.
