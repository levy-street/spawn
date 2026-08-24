# Releasing spawn

Read this in full before deploying anything. A spawn release has four moving
pieces — the server + web app, the mobile JavaScript, the mobile native app,
and the daemon binaries — and the 2026-08-24 incident happened in the gaps
between them. Ship every piece the change touches, in the same release.

## The server and the web app go out together

Deployment is over SSH, from a coding agent, using the script in this repo:

```bash
scripts/deploy-prod.sh <ssh-host>     # pulls, migrates, restarts spawn-server + spawn-web
```

The script refuses to run when the release would not be what it looks like:

- a dirty checkout or unpushed commits
- a branch other than master (`--allow-branch` to deploy one on purpose)
- an inherited `SPAWN_API_PROXY_TARGET` — the 2026-08-24 incident was a dev
  shell's value baked into the prod web build. Pass `--api-proxy-target URL`
  when you genuinely mean a non-default target; the default is prod's
  `http://127.0.0.1:8001`.
- a `prebuilt-latest` release built from a different daemon tree than the
  commit being deployed (see "The daemon prebuilts" below)

And it checks its own work:

- after the web build and **before any restart**, the proxy target actually
  baked into `.next/routes-manifest.json` is compared against the requested
  one; a mismatch aborts with the previous build still serving
- after the restart, `/healthz` is fetched **through the web app's rewrite** —
  the one probe that exercises the chain a browser uses. A failure prints the
  rollback command. (`scripts/health-check.sh` on the host's timer walks the
  same path between deploys.)

## The phone

The deploy script does not touch the phone. The installed app keeps running
whatever JavaScript it was built with, so a release that stops at the deploy
leaves the two frontends on different versions of the same feature.

Push the matching update in the same release:

```bash
cd mobile && eas update --branch production -m "<same summary as the deploy>"
```

Over-the-air updates carry JavaScript and assets, and they reach installed
builds within a launch or two. They cannot carry native changes. Anything that
alters the native layer needs a real build instead:

- a new dependency with native code, or a config plugin
- entitlements, capabilities, permissions, or `Info.plist` keys
- app icons, the splash screen, the bundle identifier, the display name
- bumping `version` in `app.json` — `runtimeVersion` follows `appVersion`, so a
  version bump orphans every install from further updates until they rebuild

```bash
cd mobile && EXPO_NO_CAPABILITY_SYNC=1 \
  eas build -p ios -e production --non-interactive --auto-submit
```

Credentials live on EAS — distribution certificate, provisioning profile, APNs
key, and the App Store Connect key for submissions — so this needs no Apple
login and runs unattended.

`EXPO_NO_CAPABILITY_SYNC=1` is required until Associated Domains is either used
in the entitlements or removed from the App ID: Apple's API rejects EAS's
attempt to switch it off, and it should stay on for universal links.

## The daemon prebuilts

Installers download daemon binaries from the production server, and the server
hands out whatever `deploy-prod.sh` last published to it from the rolling
`prebuilt-latest` GitHub release. Normally CI
(`.github/workflows/prebuilt.yml`) rebuilds that release on every daemon
change to master, the deploy verifies the release's `COMMIT` still matches the
daemon tree being deployed, and nothing more is needed.

When CI cannot run (out of credits, broken runner), the release goes stale and
the deploy will refuse — correctly. Refresh it by hand from the **pushed**
master commit:

```bash
cd daemon
# darwin, on an Apple-silicon Mac (x86_64 target via rustup)
cargo build --release --locked --bin spawnd --bin spawn-worker
cargo build --release --locked --target x86_64-apple-darwin --bin spawnd --bin spawn-worker
# linux, via Docker; bullseye's glibc 2.31 keeps the compatibility floor low
docker run --rm --platform linux/arm64 -v "$(git rev-parse --show-toplevel)":/src \
  -e CARGO_TARGET_DIR=/src/daemon/target-bullseye/arm64 rust:1-bullseye \
  bash -c 'git config --global --add safe.directory /src && cd /src/daemon && cargo build --release --locked --bin spawnd --bin spawn-worker'
docker run --rm --platform linux/amd64 -v "$(git rev-parse --show-toplevel)":/src \
  -e CARGO_TARGET_DIR=/src/daemon/target-bullseye/amd64 rust:1-bullseye \
  bash -c 'git config --global --add safe.directory /src && cd /src/daemon && cargo build --release --locked --bin spawnd --bin spawn-worker'
```

Then assemble the assets the way the workflow's publish job does — the four
`spawnd-<triple>` + four `spawn-worker-<triple>` binaries, a `SHA256SUMS` over
all of them, and a `COMMIT` file holding the full master SHA the binaries were
built from — and recreate the release:

```bash
gh release delete prebuilt-latest --repo levy-street/spawn --yes --cleanup-tag
gh release create prebuilt-latest out/* --repo levy-street/spawn \
  --target "<master sha>" --title "Prebuilt daemon (rolling)" \
  --notes "Built from <master sha>. Consumed by deploy-prod.sh; not for manual download." \
  --prerelease
```

`spawnd --version` prints `0.1.0+g<commit>`, so a running daemon can always be
matched to its source. After the next deploy publishes the binaries to prod,
confirm the served bytes match the release:

```bash
scripts/verify-prebuilts.sh https://spawnd.dev
```

## Order of operations

Migrations run before the new server starts, so a release is safe only when the
old code tolerates the new schema. Add columns and backfill in one release,
then start depending on them in the next.

Server config lives in the environment on the production host, not in this repo
and not in EAS. EAS environment variables are build inputs for the app; the
only one this project uses is `EXPO_PUBLIC_API_URL`, already committed in
`eas.json`. A server secret placed in EAS is both ineffective and exposed.
