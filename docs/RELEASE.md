# Releasing SPAWN D

Read this in full before deploying anything. A SPAWN D release has five moving
pieces — the server + web app, the mobile JavaScript, the mobile native app,
the daemon binaries, and the macOS desktop app. Ship every piece the change
touches, in the same release; a piece left behind leaves production running two
versions of the same feature.

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
- the desktop app is `git rev-parse <ref>:desktop`, plus the app version in
  `desktop/src-tauri/tauri.conf.json` — which `/api/release` advertises from
  the deployed checkout whether or not a matching artifact was published, so
  the publish leads the deploy (see the checklist)

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
  "release_counter": 1770000000,
  "signing_key_id": "8hex",
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

## The wire protocols

Version numbers decide nothing about whether two deployed pieces can talk. A
named subprotocol does, and there are three:

| between | name | declared in |
| --- | --- | --- |
| daemon and server | `spawn.control.v3` | `daemon/src/ws.rs`, `server/spawn_server/ws/daemon.py` |
| browser and server | `spawn.v3` | `web/src/lib/ws.ts`, `server/spawn_server/ws/browser.py` |
| alerts | `spawn.alerts.v1` | `web/src/lib/alerts.ts`, `mobile/src/data/realtime/alert-socket.ts`, `server/spawn_server/ws/alerts.py` |

All three are published at `GET /api/release` under `protocols`. A 0.1.2 daemon
and a much newer server interoperate for as long as both speak
`spawn.control.v3`; releasing them in lockstep is neither required nor checked.

**Bump one only when a peer speaking the old name would be wrong, not merely
behind.** That means a frame or field removed or renamed that the peer relies
on, changed semantics for a frame that already exists, or a change to the
handshake itself. Additive frames and optional fields never bump it — every
side validates frames field by field and ignores what it does not recognise, so
an old peer misses the new thing and keeps working. A bump is a fleet-wide
cutover, not a changelog entry: every deployed peer offering the old name is
refused at the handshake, and bumping for a change they could have survived
spends that cutover for nothing.

What a bump then does is already built, end to end — do not re-derive it:

- the server refuses any socket that does not offer the name. It accepts,
  sends `{"type": "protocol.required", "protocol": …}`, and closes with
  `WS_CLOSE_PROTOCOL_REQUIRED`, so the peer is told what is required rather
  than left with a dead connection.
- **the daemon heals itself.** A protocol refusal is the one failure that makes
  `run.rs` self-update immediately: it fetches `/api/install/manifest.json`
  over plain HTTP — not the socket that just refused it — verifies the hashes,
  swaps the binaries and re-execs. A daemon that cannot self-update (an
  unwritable install directory, self-update disabled) logs the exact reinstall
  command hourly and retries every five minutes.
- **the browser reloads.** The refusal raises `spawn:client-stale` with
  `hard: true`, which is the release watcher's hard prompt: a short countdown,
  then a reload.
- **the phone** handles `protocol.required` on its sockets the same way and
  routes it into the update path.

So the order of operations for a bump is forced: the daemon prebuilts that
speak the new protocol must be published **before or with** the server that
requires it. The daemon's self-heal pulls from the manifest that server serves,
so if the manifest still holds a build speaking the old name, every daemon in
the field spends its retry loop downloading a build that is refused just the
same.

## Signed daemon releases

Every daemon release has two public metadata files:
`/api/install/manifest.json` and `/api/install/manifest.json.sig`. The second
is a detached Ed25519 signature, encoded as one line of unpadded base64url,
over the exact bytes of the first. There is no JSON reformatting or
canonicalisation between signing and verification. The signed bytes bind the
release commit and daemon tree, the version, the committer-timestamp
`release_counter`, the signing key id, and both binary hashes for every
published target. `deploy-prod.sh` publishes the manifest atomically and then
the signature atomically, last; a daemon never installs from an unsigned or
badly signed manifest.

The private key is a 32-byte Ed25519 seed stored as one line of unpadded
base64url at
`${SPAWN_RELEASE_SIGNING_KEY:-$HOME/.config/spawn/release-signing.key}` on the
operator Mac. Its mode is `0600`. Custody is deliberately narrow:

- keep the working seed on that one operator Mac;
- keep one backup of the seed in the password manager;
- never put it in this repository, CI, EAS, the production server, a deploy
  log, or a shell command line.

The production public key is
`8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0`, key id `e65c013f`. Public keys
are compiled into the daemon as a list so rotation can overlap. To rotate,
add the new public key beside the old one and ship that daemon release in a
manifest signed by the old key. After it is deployed and the fleet has
updated, retire the old key from the list in the following daemon release.
Never remove the old key in the release that first introduces the new one.
If the private seed is lost and the password-manager backup is also gone,
there is no signed recovery path for installed daemons: rotate the key and do
one fleet reinstall wave with the install one-liner.

`scripts/verify-release.sh https://spawnd.dev` fetches the manifest and
signature through the public origin, verifies them against the public-key list
compiled into the expected daemon source, and proves `release_counter` equals
`git show -s --format=%ct` for the expected commit. It also continues to prove
the server/web identity, daemon tree and served binary hashes, and mobile
identity. A failed signature or counter row is a failed release.

The counter is also the downgrade boundary. Automatic daemon updates never
downgrade. A deliberate operator retry may bypass the monotonicity check only
through `POST /api/hosts/{id}/update` with
`{"allow_downgrade": true}`. Use that override only when the older signed
release is the intended recovery; it does not permit unsigned updates.

### Proving the updater

The repeatable local updater proof has three CI scripts, all run by
`scripts/test-all.sh` after the daemon tests:

- `scripts/test-update-e2e.sh` builds two signed throwaway daemon identities
  and proves automatic and manual update, same-PID exec, worker-backed PTY
  survival, pair cleanup, idempotence, request throttling, update
  preconditions, and the downgrade override.
- `scripts/test-update-faults.sh` puts the daemon's complete localhost origin
  behind the standard-library `scripts/fault-proxy.py` and pins download,
  signature, hash, truncation, throttling, and candidate-version failures to
  their reported update stages without corrupting the installed pair.
- `scripts/test-update-probation.sh` runs the daemon under a launchd/systemd-
  shaped supervisor loop, installs a candidate that fails real startup, and
  proves pair-atomic health reversion plus the failed-tree no-repush rule.

Before every release that changes `daemon/`, run the previous/new compatibility
matrix with the commit currently deployed to production supplied explicitly:

```bash
SPAWN_OLD_REF=<deployed-commit> scripts/test-version-skew.sh
```

That ritual creates and removes a detached temporary worktree and prints all
four `{old,new daemon} × {old,new server}` cells after registration and PTY
smoke. The browser half lives in `web/tests/e2e/version-skew.spec.ts`: the
old-web/new-server 4003 cell must show the hard reload countdown without a
reconnect loop, while a soft build mismatch remains snooze-able.

After connection, signalling, keepalive, worker-adoption, ICE, or TURN changes,
run `SPAWN_ALLOW_SUDO=1 scripts/chaos-drills.sh`. The safe SIGSTOP and local
uvicorn-loss cases are scripted; pfctl, Network Link Conditioner, sleep/wake,
and network-interface steps print `MANUAL` markers and their expected
observations. The script never prompts for sudo (`sudo -n` only) and refuses
privileged steps without the explicit environment gate. Toxiproxy and
mitmproxy remain useful optional manual comparators, but neither is a test
dependency: the committed fault proxy uses Python's standard library.

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
- after the restart, `/healthz` is fetched **through the web app's rewrite**,
  then an anonymous `spawn.alerts.v1` WebSocket must upgrade through the public
  origin and close with the expected 1008 auth policy code. Together they
  exercise the HTTP and WebSocket chains a browser uses. A failure prints the
  rollback command. (`scripts/health-check.sh` on the host's timer walks the
  same paths between deploys.)
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

The deploy carries code, not secrets. Server configuration lives in the host's
`server/.env` and is set once, by hand: see [EMAIL.md](EMAIL.md) for outbound
mail and [PUSH.md](PUSH.md) for the VAPID key pair that gives browsers
notifications while they are closed. Rotating the VAPID key invalidates every
existing browser subscription, so it is a deliberate act, never a side effect
of a release.

Two of those values are checked rather than trusted. When `SPAWN_PUBLIC_URL`
names anything the internet can reach, `spawn-server` refuses to start while
`SPAWN_JWT_SECRET` is still the default published in this repository, or while
`SPAWN_EMAIL_BACKEND` is `console` (which records mail and sends none, leaving
signup unable to verify an address). It names the variable to fix and exits. A
truncated env file used to boot happily and sign session tokens with a public
secret. Loopback, private and link-local addresses are exempt, so local
development and LAN testing against a phone keep every default they have.

One more value is read rather than set: `SPAWN_DESKTOP_DIR`, the static root
nginx serves at `/desktop/`. It defaults to `/var/www/spawnd/desktop` — the
same directory `scripts/publish-desktop.sh` uploads to under the same variable
name — and the server looks in it before advertising a desktop version, so
`/api/release` names a Mac build only when that build's disk image is really
there. A deploy that lands before the publish therefore says nothing about the
desktop app rather than pointing the download button at a 404. If the
directory does not exist at all the server cannot check, so it advertises the
version anyway and logs an error naming this variable; a download that
vanishes silently would be the harder failure to notice.

## The phone

The deploy script does not touch the phone. The installed app keeps running
whatever JavaScript it was built with, so a release that stops at the deploy
leaves the two frontends on different versions of the same feature.

Push the matching update in the same release:

```bash
scripts/update-mobile-prod.sh -m "<same summary as the deploy>"
```

For a bad OTA, the operator kill switches are:

```bash
eas update:rollback
eas update:revert-update-rollout
```

The first publishes a rollback directive; the second backs out an in-progress
percentage rollout. Use the one matching how the update was published, then
verify the production manifest again. Separately, `expo-updates` has client
error recovery: an update that crashes during startup can fall back through an
emergency launch (`isEmergencyLaunch` / `emergencyLaunchReason`). That safety
net is not a substitute for issuing the rollback promptly.

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

## The desktop app

The desktop companion is piece five of a SPAWN D release. It ships independently
from the daemon it supervises: the app follows the vendor-owned Tauri updater
channel, while the daemon continues to update from the server the user chose.
Stable builds read `https://spawnd.dev/desktop/latest.json`; builds made with the
beta configuration read `https://spawnd.dev/desktop/beta/latest.json`. A
self-hosted server never becomes an app-update authority.

`.github/workflows/desktop.yml` is manual-only. It builds, Developer ID signs and
notarizes the Apple-silicon and Intel apps and DMGs, then uploads the notarized
DMGs plus `.app.tar.gz` updater payloads. Its Apple credentials are
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_PRIVATE_KEY`, `APPLE_API_KEY`, and `APPLE_API_ISSUER`. The workflow
does not publish a release and it never receives the Tauri updater private key.

`workflow_dispatch` only lists workflows that exist on the default branch, so
until `desktop.yml` has been merged the run has to be made locally with the
same inputs: a clean worktree at the release commit, the six credentials in
the environment (`APPLE_API_KEY_PATH` pointing at the `.p8` on disk, the
rustup toolchain's `bin` first on `PATH` where Homebrew's Rust shadows it),
then in `desktop/`, for `aarch64-apple-darwin` and `x86_64-apple-darwin`:
`npx tauri build --config src-tauri/tauri.ci.conf.json --target <triple>`,
`xcrun notarytool submit --wait` and `xcrun stapler staple` on the DMG (Tauri
signs it but does not notarize it), and
`COPYFILE_DISABLE=1 tar -czf SPAWN-D_<version>_<platform>.app.tar.gz -C <bundle>/macos "SPAWN D.app"`.
Then continue from step 1 below. Note that `spctl --assess` reports a
notarized, stapled build as "rejected" on some Macs; `syspolicy_check
distribution` and `xcrun stapler validate` are the checks to trust.

Updater promotion is deliberately local and offline:

1. Download both workflow artifacts and verify their checksums, code signatures,
   notarization tickets and version before promoting either architecture.
2. With the updater private key exposed only through
   `SPAWN_DESKTOP_UPDATER_KEY`, run `cargo tauri signer sign -f
   "$SPAWN_DESKTOP_UPDATER_KEY" <artifact.app.tar.gz>` for each updater payload.
3. Assemble `latest.json` locally with the exact app version, release notes,
   publication time and `darwin-aarch64` / `darwin-x86_64` URL-and-signature
   entries. The detached minisign values produced in step 2 are the signatures
   embedded in that manifest. Do the same under `desktop/beta/` for a beta.
4. Publish with `scripts/publish-desktop.sh <ssh-host> <artifact-dir>`. It
   refuses the set unless `latest.json` names the committed version and both
   platforms, every URL points at the payload beside it under this origin's
   `/desktop/` tree, and every signature verifies against
   `desktop/updater.pubkey`; then it uploads the payloads and DMGs first and
   the manifest last, through a rename, and reads every URL back. Set
   `SPAWN_DESKTOP_CHANNEL=beta` to publish under `desktop/beta/`. Never
   assemble or sign this manifest in CI.

The static origin behind those URLs is nginx, not the server or Next: the
`location /desktop/` block in `infra/nginx-spawnd.conf.example` serves
`/var/www/spawnd/desktop/` directly (`SPAWN_DESKTOP_DIR` for the script), so
the updater and the download page never depend on the app being up. It holds
the DMGs the download page links to (`SPAWN-D_<version>_<platform>.dmg`), the
`.app.tar.gz` updater payloads, and `latest.json`.

Publish before deploying a commit whose `desktop/` tree is new. `GET
/api/release` reports the `desktop` block — and the download page lights its
Mac link — from the deployed checkout alone, without checking that the DMG at
that URL exists, so a deploy that precedes the publish hands out a 404.

The updater public key is committed in `desktop/updater.pubkey` and baked into
`desktop/src-tauri/tauri.conf.json`. The private key stays on the release
operator's Mac, outside this repository, with one protected password-manager
backup. Never place it in GitHub Actions, the production server, a deploy log or
a shell command line. Losing the private key and its backup strands every
installed desktop app on its current trust root; there is no in-band recovery,
so those users must install a newly signed app manually.

The desktop content identity is the version in
`desktop/src-tauri/tauri.conf.json` plus `git rev-parse <ref>:desktop`.
Production exposes it from `GET /api/release` only when known and clean:

```json
{
  "desktop": {
    "version": "0.1.0",
    "tree": "40hex desktop tree",
    "platforms": ["darwin-aarch64", "darwin-x86_64"]
  }
}
```

Unknown or dirty desktop identities are `null`, as for the other release
pieces. `scripts/verify-release.sh` compares this block, the served
`/desktop/latest.json`, one served updater artifact and its minisign signature
against the public key committed at the selected ref. Use `--skip-desktop` only
when intentionally verifying a release that predates the app or an environment
where the static desktop origin is unavailable.

## The macOS consent dialogs

People judge SPAWN D by the permission dialogs it causes, so it is worth being
exact about which of them a release removes and which are simply what the
daemon is. Two different systems produce them and they have nothing to do with
each other.

**Gatekeeper — the two trips to Privacy & Security are a local-build artifact.**
An unnotarized app is refused on first launch with no button but "Move to Bin",
and clearing it means System Settings → Privacy & Security → Open Anyway. It
happens *twice* for a locally built DMG because Gatekeeper judges the disk image
and the app separately: once when the image is opened, once for the copy dragged
to `/Applications`, which inherits `com.apple.quarantine` from the browser that
downloaded it. Neither survives a real release — `desktop.yml` Developer ID
signs and notarizes the app *and* staples the DMG, and a stapled DMG opens with
no dialog at all while the app gets the ordinary one-click "downloaded from the
Internet" confirmation every Mac app gets. To confirm a build is clean, use
`syspolicy_check distribution "<app>"` and `xcrun stapler validate`, not
`spctl --assess`, which reports "rejected" for good builds on some Macs. Nothing
in the product can remove these locally: a browser quarantines what it
downloads, and a local build has no notarization to answer with.

**Keychain — gone, and it was most of the noise.** The app used to keep its
session token and device seed in the macOS keychain, and a keychain item's ACL
names the code signature that created it. When that signature stops matching —
a development rebuild, or a build signed differently from the one that first
stored the item — macOS asks on *every read*, and the app read the token on
every authenticated request: six dialogs in fourteen seconds during one
possession, all for the same two items. Those secrets now live in a mode-0600
`credentials.json` in the app's Application Support directory
(`desktop/src-tauri/src/storage.rs`), handled by `spawnd::secret_file`, and the
app never asks for the keychain again. The trade-off is argued in that module's
comment; the short version is that the daemon's more powerful credentials
already live in such a file, so the keychain was a stronger door on the lesser
prize, and the dialog cost more trust than it bought.

Two things a release needs to know. **The migration runs once** and its cost
depends on the signature: notarized app reading items a notarized app wrote is
silent, so an ordinary upgrade asks nothing; a signature that changed since the
item was written gets up to two dialogs, once, and never again.

That an ordinary upgrade is silent is a property of the ACL, not an assumption.
macOS records the requirement as `identifier "dev.spawnd.desktop" and anchor
apple generic and certificate leaf[subject.OU] = "9RT4S4TGA3"` — scoped to the
**team**, not to one certificate, so renewing or replacing the Developer ID cert
within team `9RT4S4TGA3` (Dreamhome AI Limited, the identity
`APPLE_SIGNING_IDENTITY` names) keeps satisfying it. The one change that would
put an unexplained keychain dialog in front of every existing user is signing a
release under a **different Apple team**; if that is ever on the table, expect
it and say so in the release notes. **Items for
origins and accounts an install no longer uses stay behind** — `keyring`
addresses an item by name and cannot enumerate — and they are inert because
nothing reads the keychain any more. `security delete-generic-password -s spawn`
(repeat until it reports nothing) clears them if you want a clean machine.

**TCC — inherent, but it should be asked once and in our own words.** The daemon
reads the home directory, so macOS gates Desktop, Documents and Downloads, and
it attributes the request to the *responsible* process. That is `spawnd`, even
when the thing reading the folder was an agent the person started in a session:
in the field every consent dialog on the machine named `spawnd`, including ones
for the photo and music libraries that nothing in the daemon ever sets out to
read. No release removes these. What a release controls is what they say:

- `daemon/Info.plist` is linked into both binaries' `__TEXT,__info_plist`
  section by `build.rs`, and carries `CFBundleName` plus one
  `NS*UsageDescription` per gated location. Those strings are the second line of
  the dialog, printed verbatim.
- **They only take effect if the binary is re-signed.** The signature the linker
  applies by itself seals nothing it did not write, and `codesign -dv` on such a
  binary reports `Info.plist=not bound`. `prebuilt.yml` therefore re-signs all
  four darwin binaries and fails the build unless `codesign -dv` afterwards
  reports both `Identifier=dev.spawnd.daemon` and `Info.plist entries=`.
- On first registration after possession the daemon asks for Desktop, Documents
  and Downloads in that order and records the answers, so it never asks twice.
  It asks only behind the desktop app's consent screen: the app leaves a request
  marker, the daemon waits up to two minutes for the answer, and with no marker
  it primes nothing — an `install.sh` or SSH possession keeps ordinary lazy
  prompts and is never auto-refused. The markers and the report share one
  `<config>/spawn/` directory because TCC grants the binary once, whoever it is
  running for. `SPAWND_NO_PERMISSION_PRIME=1` turns it off. See
  `daemon/src/permissions.rs`.

**Making a grant survive a self-update** needs a Developer ID. TCC keys a grant
on the signing identity, and an ad-hoc identity is a hash of the binary, so it
changes with every release and every folder is asked for again. Setting the
repository variable `SIGN_DAEMON_WITH_DEVELOPER_ID` to `true` makes
`prebuilt.yml` sign with the certificate `desktop.yml` already holds. Turning it
on is a one-time cost paid by every existing host — their ad-hoc-keyed grants do
not transfer, so each is asked once more — and it should be done deliberately,
with a release, rather than discovered. Verify afterwards with `codesign -dv
--verbose=4` on a downloaded binary: `Authority=Developer ID Application: …`
and `TeamIdentifier` set rather than `adhoc`.

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
# linux, via Docker. ubuntu:22.04 because that is what CI builds on, and the
# floor has to be the same either way — see "The Linux compatibility floor".
linux_build='apt-get update -qq && apt-get install -y -qq curl build-essential git >/dev/null \
  && curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && . "$HOME/.cargo/env" && git config --global --add safe.directory /src \
  && cd /src/daemon && cargo build --release --locked --bin spawnd --bin spawn-worker'
docker run --rm --platform linux/arm64 -v "$(git rev-parse --show-toplevel)":/src \
  -e CARGO_TARGET_DIR=/src/daemon/target-jammy/arm64 ubuntu:22.04 \
  bash -c "$linux_build"
docker run --rm --platform linux/amd64 -v "$(git rev-parse --show-toplevel)":/src \
  -e CARGO_TARGET_DIR=/src/daemon/target-jammy/amd64 ubuntu:22.04 \
  bash -c "$linux_build"
```

### The Linux compatibility floor

**glibc 2.35 — Ubuntu 22.04.** Hosts older than that get no prebuilt and fall
back to a source install. It is set in one place, `.github/workflows/prebuilt.yml`
(`runs-on: ubuntu-22.04`), because CI is what publishes the rolling release on
every daemon change; the recipe above only exists for when CI cannot run, and it
matches that base deliberately.

Do not build the Linux binaries on an older base to "support more hosts". It
works, and that is the problem: the hand-built release quietly admits hosts
CI does not, they install and update happily, and the next ordinary CI build
takes their prebuilt away again with nothing in the failure to explain why.
Lowering the floor is a change to `prebuilt.yml` and to this section, together.

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
host manifest, signs it locally, and refuses to publish a partial target pair
or to publish without the readable release-signing key. For a focused
diagnostic, compare the served signature and bytes with the rolling release:

```bash
scripts/verify-prebuilts.sh https://spawnd.dev
```

## Pre-release version skew and canaries

Before a release that changes the daemon/server contract, exercise the four
cells that can coexist during one release-and-rollback window: previous server
with previous daemon, previous server with the new daemon, new server with the
previous daemon, and new server with the new daemon. Build the previous side
from the last deployed tag in a temporary worktree. For each cross-version
cell, prove registration and a PTY smoke; for old daemon/new server also prove
the auto-update path, and for new daemon/old server prove that the downgrade
guard fires without an update loop. Do the equivalent old-web/new-server
protocol-refusal check when the browser contract changes. This is a weekly or
pre-release ritual, not a per-commit test matrix.

Here “A/B” means **interleaved canary cohorts**, not a statistical experiment:
hold one host back with `settings.daemon_auto_update` off while another host
updates, compare update stages, time-to-register and reconnect log classes,
then advance the held-back host. A small EAS percentage rollout across the
operator's own devices, with `eas update:revert-update-rollout` ready, is the
mobile equivalent.

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

## Production network

Read [NETWORK.md](NETWORK.md) before changing nginx, firewall rules, WebSocket
timeouts, ICE/TURN settings, coturn, or the `spawn-server` worker count. It
records the verified production topology and the checked-in nginx/coturn
examples. Two constraints are release blockers:

- keep an ordinary UDP `turn:` endpoint; the daemon's current WebRTC stack
  cannot use TURN over TCP or TLS;
- run exactly one uvicorn worker until terminal session signalling resolves
  daemon ownership through Redis like the host-control path does.

`turns:` on 443 is recommended for browser/phone fallback after it has its own
IP or an SNI/TURN-aware router; it is not enabled in current production.

## Release checklist

1. Confirm the checkout is clean, the intended commit is pushed, daemon CI has
   finished when `daemon/` changed, and the local release-signing key is
   present and readable when prebuilts will be published.
2. If `desktop/` changed, publish the desktop app **before** the server deploy,
   following "The desktop app" above through `scripts/publish-desktop.sh`.
   The order is not a preference. `/api/release` advertises the version in the
   *deployed checkout's* `desktop/src-tauri/tauri.conf.json` without checking
   that an artifact for it exists, and the download page builds its URL from
   that number — so a deploy that lands first points the Mac download button at
   a 404 until the publish catches up. Confirm `/desktop/latest.json` names the
   same version the checkout does before moving on.
3. Run `scripts/deploy-prod.sh <ssh-host>`. Do not continue past a hard gate by
   habit; fix the release or record why the emergency prebuilt override is safe.
4. If `mobile/` changed, run
   `scripts/update-mobile-prod.sh -m "<same summary as the deploy>"`. If native
   code, configuration, entitlements, or the runtime version changed, publish a
   real store build as well.
5. Exercise the changed user flow. For network or signalling changes, also run
   `scripts/health-check.sh` with the production `SPAWN_TURN_URLS`; this checks
   the public WebSocket upgrade and the configured UDP TURN listener. Keep the
   migration compatibility rule above in mind while the previous processes are
   still draining.
6. Last, prove the independently shipped identities and served daemon bytes:

   ```bash
   scripts/verify-release.sh https://spawnd.dev
   ```

   The verifier expects `origin/master` by default. Use `--ref <git-ref>` for
   an intentional branch deploy and `--skip-mobile` only when this environment
   cannot reach Expo. It prints `PIECE / EXPECTED / ACTUAL / RESULT` and exits
   non-zero on any mismatch. A release is not finished until this final proof
   passes or the skipped external dependency is explicitly handed off.
