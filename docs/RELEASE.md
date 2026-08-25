# Releasing SPAWN D

Read this in full before deploying anything. A SPAWN D release has four moving
pieces — the server + web app, the mobile JavaScript, the mobile native app,
and the daemon binaries. Ship every piece the change touches, in the same
release; a piece left behind leaves production running two versions of the
same feature.

## Versions and compatibility

Each independently shipped piece carries a content identity. These identities
change when that piece's source or built output changes, even when the product
version remains `0.1.0`:

- the server is the full deployed git commit
- the web app is its Next build ID, pinned to that same commit by deploy
- the daemon is `git rev-parse <ref>:daemon`, plus the version printed by
  `spawnd --version`
- the mobile JavaScript is `git rev-parse <ref>:mobile`
- the mobile native runtime is the app version in `mobile/app.json`

Production publishes all expected identities at the public, uncacheable
`GET /api/release` endpoint. Unknown and dirty development identities are left
unset; clients do not prompt for updates when either side is unknown.

When a piece is behind, the user sees the recovery that fits that piece:

- a daemon downloads the advertised `spawnd` and `spawn-worker`, verifies both
  hashes, swaps them atomically, and restarts itself while workers keep running
- a stale browser tab asks to reload; a hard protocol refusal reloads it
  automatically after a short countdown
- the mobile app downloads a matching EAS update and asks to restart; when its
  native runtime is too old, it sends the user to the App Store instead

The daemon part of `/api/release` exists only when
`daemon/target/prebuilt/manifest.json` is valid and every listed binary is
present with the advertised hash. Deploy writes this file atomically after the
binaries:

```json
{
  "commit": "40hex",
  "tree": "40hex daemon tree",
  "version": "0.1.0+g<commit12>",
  "targets": {
    "darwin-aarch64": {
      "spawnd_sha256": "64hex",
      "spawn_worker_sha256": "64hex"
    }
  }
}
```

Do not hand-edit this manifest. Its hashes come from the already-verified
`SHA256SUMS` in `prebuilt-latest`, and it includes only target pairs actually
copied to the host.

## The server and the web app go out together

Deployment is over SSH, from a coding agent, using the script in this repo:

```bash
scripts/deploy-prod.sh <ssh-host>     # pulls, migrates, restarts spawn-server + spawn-web
```

The script refuses to run when the release would not be what it looks like:

- a dirty checkout or unpushed commits
- a branch other than master (`--allow-branch` to deploy one on purpose)
- an inherited `SPAWN_API_PROXY_TARGET` — the target is baked into the web
  build at build time, and an inherited value is indistinguishable from an
  intended one. Pass `--api-proxy-target URL` when you mean a non-default
  target; the default is prod's `http://127.0.0.1:8001`.
- a `prebuilt-latest` release whose `COMMIT`/`TREE` does not describe the
  daemon tree being deployed (see "The daemon prebuilts" below)
- a daemon tree change when verified prebuilts cannot be published because the
  release is missing, incomplete, stale, or fails checksum verification

And it checks its own work:

- after the web build and **before any restart**, the proxy target actually
  baked into `.next/routes-manifest.json` is compared against the requested
  one; a mismatch aborts with the previous build still serving
- after the restart, `/healthz` is fetched **through the web app's rewrite** —
  the one probe that exercises the chain a browser uses. A failure prints the
  rollback command. (`scripts/health-check.sh` on the host's timer walks the
  same path between deploys.)
- after prebuilt publication, `/api/release` must report the new full server
  commit and the new daemon tree; this proves the manifest became live

The daemon gate compares the target tree to the manifest currently on the host
before any production mutation. `SPAWN_DEPLOY_PREBUILTS=0` is the explicit
emergency override. It prints a loud warning and allows the deploy, but daemons
cannot auto-update to the new tree; affected users must reinstall with:

```bash
curl -fsSL https://spawnd.dev/install.sh | sh
```

Do not use the override merely because CI is slow. Wait for `prebuilt-latest`
whenever possible. If `mobile/` changed between the old production commit and
the new one, deploy also prints the matching `update-mobile-prod.sh` reminder.

## The phone

The deploy script does not touch the phone. The installed app keeps running
whatever JavaScript it was built with, so a release that stops at the deploy
leaves the two frontends on different versions of the same feature.

Push the matching update in the same release:

```bash
scripts/update-mobile-prod.sh -m "<same summary as the deploy>"
```

Never run `eas update` by hand for production. The `env` blocks in
`eas.json` apply to `eas build` profiles only — `eas update` re-evaluates
`app.config.ts` with the caller's shell environment, so a bare invocation
from a shell without `EXPO_PUBLIC_API_URL` publishes a bundle with no API URL
baked in, and every installed app falls back to `http://localhost:3000` and
breaks at sign-in. (This happened on 2026-08-24.) The script bakes the URL and
`EXPO_PUBLIC_SPAWN_MOBILE_TREE="$(git rev-parse HEAD:mobile)"`, refuses a
disagreeing inherited API URL, and proves the evaluated config carries both
`extra.apiUrl` and `extra.mobileTree` before publishing. It then fetches the
manifest served by `u.expo.dev` with the same headers the app uses and proves
`extra.expoClient.extra.mobileTree` and the API URL survived publication. Its
guards are pinned by `server/tests/test_update_mobile_script.py`.

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
daemon tree being deployed and its `TREE` is exactly
`git rev-parse <deployed-ref>:daemon`, and nothing more is needed.

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

Then assemble the assets the way the workflow's single publish job does — the
four `spawnd-<triple>` + four `spawn-worker-<triple>` binaries, plus
`SHA256SUMS`, `COMMIT`, `TREE`, and `VERSION`. From the repository root, after
placing the binaries in `out/`:

```bash
(cd out && sha256sum $(ls spawnd-* spawn-worker-* | sort) > SHA256SUMS)
git rev-parse HEAD > out/COMMIT
git rev-parse HEAD:daemon > out/TREE
# Run any staged binary compatible with this machine; on Apple silicon:
chmod +x out/spawnd-aarch64-apple-darwin
out/spawnd-aarch64-apple-darwin --version | awk '{print $2}' > out/VERSION
```

Inspect all four identity files, then recreate the rolling release:

```bash
gh release delete prebuilt-latest --repo levy-street/spawn --yes --cleanup-tag
gh release create prebuilt-latest out/* --repo levy-street/spawn \
  --target "<master sha>" --title "Prebuilt daemon (rolling)" \
  --notes "Built from <master sha>. Consumed by deploy-prod.sh; not for manual download." \
  --prerelease
```

`spawnd --version` prints `0.1.0+g<commit>`, so a running daemon can always be
matched to its source. `deploy-prod.sh` converts these release files into the
host manifest and refuses to publish a partial target pair. For a focused
binary-only diagnostic, compare the served bytes with the rolling release:

```bash
scripts/verify-prebuilts.sh https://spawnd.dev
```

## Order of operations

Migrations run before the new server starts, so a release is safe only when the
old code tolerates the new schema. Add columns and backfill in one release,
then start depending on them in the next.

Server config lives in the environment on the production host, not in this repo
and not in EAS. EAS environment variables are build inputs for the app;
`EXPO_PUBLIC_API_URL` is committed in `eas.json` for **builds**, while the
mobile tree is computed by `app.config.ts`. Over-the-air updates do not read
`eas.json`, which is why `scripts/update-mobile-prod.sh` sets both values itself
(see "The phone"). A server secret placed in EAS is both ineffective and
exposed.

## Release checklist

1. Confirm the checkout is clean, the intended commit is pushed, and daemon CI
   has finished when `daemon/` changed.
2. Run `scripts/deploy-prod.sh <ssh-host>`. Do not continue past a hard gate by
   habit; fix the release or record why the emergency prebuilt override is safe.
3. If `mobile/` changed, run
   `scripts/update-mobile-prod.sh -m "<same summary as the deploy>"`. If native
   code, configuration, entitlements, or the runtime version changed, publish a
   real store build as well.
4. Exercise the changed user flow. Keep the migration compatibility rule above
   in mind while the previous processes are still draining.
5. Last, prove the independently shipped identities and served daemon bytes:

   ```bash
   scripts/verify-release.sh https://spawnd.dev
   ```

   The verifier expects `origin/master` by default. Use `--ref <git-ref>` for
   an intentional branch deploy and `--skip-mobile` only when this environment
   cannot reach Expo. It prints `PIECE / EXPECTED / ACTUAL / RESULT` and exits
   non-zero on any mismatch. A release is not finished until this final proof
   passes or the skipped external dependency is explicitly handed off.
