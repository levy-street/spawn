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

Windows adds a separate, layered publisher proof. CI uses Microsoft Artifact
Signing through GitHub OIDC to Authenticode-sign and RFC 3161 timestamp
`spawnd-x86_64-pc-windows-msvc.exe` and
`spawn-worker-x86_64-pc-windows-msvc.exe` before `SHA256SUMS` is created.
Authenticode proves the Windows publisher and PE integrity; it does not
authorize a daemon update. The detached Ed25519 manifest still authorizes the
exact version, targets and post-Authenticode hashes accepted by `spawnd`.
Artifact Signing keeps its private key in Microsoft's HSM and CI receives only
a short-lived OIDC authorization for the certificate profile. The offline
daemon release key and offline Tauri updater key never enter CI.

Protect the `windows-code-signing` GitHub environment to `master`, scope the
federated credential to that environment, and grant its service principal only
`Artifact Signing Certificate Profile Signer` on the chosen profile. The named
secrets are `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
`AZURE_SUBSCRIPTION_ID`; the variables are
`AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`,
`AZURE_ARTIFACT_SIGNING_PROFILE`, and `WINDOWS_SIGNING_SUBJECT` (the complete
expected distinguished name). Revoke the federated credential/profile quickly
if a permitted CI run is compromised: it still cannot mint the offline
Ed25519 manifest, but it can request publisher-valid PE signatures.

The Windows prebuilt job deliberately remains buildable while Artifact Signing
is being provisioned: when all three Azure secrets are absent it uploads an
unsigned Actions artifact, while a partial signing configuration is a hard
failure. An unsigned Windows pair must not be treated as release-ready or
promoted in Windows-facing UI. Once credentials exist, signing, exact subject,
timestamp and SignTool verification are hard gates before artifact upload.

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

The native Windows emergency reinstall is:

```powershell
irm https://spawnd.dev/install.ps1 | iex
```

The pipeline form cannot pass switches. The PowerShell equivalent of
`sh -s -- --new-account` is:

```powershell
& ([scriptblock]::Create((irm https://spawnd.dev/install.ps1))) -NewAccount
```

For `cmd.exe`, use a process-scoped execution-policy override:

```bat
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod 'https://spawnd.dev/install.ps1' | Invoke-Expression"
```

That override applies only to the new PowerShell process. It does not bypass
MachinePolicy/UserPolicy Group Policy, WDAC/AppLocker, or Constrained Language
Mode; use `Invoke-Expression` only with the fixed HTTPS SPAWN D origin.

For an inspect-then-run recovery, download the fixed HTTPS origin, read the
file, then run it under the user's policy:

```powershell
Invoke-WebRequest https://spawnd.dev/install.ps1 -OutFile .\install.ps1
Get-Content .\install.ps1
& .\install.ps1
```

Keep the Unix recovery unchanged:

```bash
curl -fsSL https://spawnd.dev/install.sh | sh
```

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
notarizes the Apple-silicon and Intel apps and DMGs, and builds and Authenticode
signs the x86-64 Windows app and NSIS installer. The Mac artifacts are the
notarized DMGs plus `.app.tar.gz` updater payloads. The Windows artifact is the
canonical `SPAWN-D_<version>_windows-x86_64-setup.exe`; the same EXE is both the
public download and updater payload. The workflow produces no MSI.

The Apple credentials are
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_PRIVATE_KEY`, `APPLE_API_KEY`, and `APPLE_API_ISSUER`. The workflow
uses GitHub OIDC for Azure Artifact Signing with secrets `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`, plus repository variables
`AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and
`AZURE_ARTIFACT_SIGNING_PROFILE`, plus the expected certificate-subject fragment
`AZURE_ARTIFACT_SIGNING_PUBLISHER`. It signs and RFC 3161 timestamps the inner
`spawn-desktop.exe`, bundles that exact file with per-user NSIS, then signs and
timestamps the final setup EXE. The workflow does not publish a release and it
never receives `SPAWN_DESKTOP_UPDATER_KEY`.

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
Windows release artifacts must come from the `windows-latest` workflow job so
both Authenticode signatures and their timestamps are proved on Windows. Then
continue from step 1 below. Note that `spctl --assess` reports a
notarized, stapled build as "rejected" on some Macs; `syspolicy_check
distribution` and `xcrun stapler validate` are the checks to trust.

Updater promotion is deliberately local and offline:

1. Download all three workflow artifacts and verify their checksums, versions,
   both Mac code signatures/notarization tickets, and the Windows Authenticode
   evidence for both the inner app and outer setup EXE. On Windows,
   `Get-AuthenticodeSignature` must report `Valid` and a timestamp certificate
   for each signed file. Never alter or Authenticode-sign the setup EXE after
   this point.
2. With the updater private key exposed only through
   `SPAWN_DESKTOP_UPDATER_KEY`, create the three detached Tauri signatures:

   ```bash
   cargo tauri signer sign -f "$SPAWN_DESKTOP_UPDATER_KEY" SPAWN-D_<version>_darwin-aarch64.app.tar.gz
   cargo tauri signer sign -f "$SPAWN_DESKTOP_UPDATER_KEY" SPAWN-D_<version>_darwin-x86_64.app.tar.gz
   cargo tauri signer sign -f "$SPAWN_DESKTOP_UPDATER_KEY" SPAWN-D_<version>_windows-x86_64-setup.exe
   ```

   The resulting `.sig` files stay local; their text is embedded in the
   manifest. The Windows Tauri signature must cover the already Authenticode-
   signed, canonically named EXE.
3. Assemble `latest.json` locally with the exact app version, release notes,
   publication time and exactly `darwin-aarch64`, `darwin-x86_64`, and
   `windows-x86_64` URL-and-signature entries. Mac updater URLs end in
   `.app.tar.gz`; the Windows updater URL is the canonical `-setup.exe`. Do the
   same under `desktop/beta/` for a beta.
4. Publish with `scripts/publish-desktop.sh <ssh-host> <artifact-dir>`. It
   refuses the set unless `latest.json` names the committed version and both
   Mac platforms plus Windows, every URL points at the payload beside it under
   this origin's `/desktop/` tree, and every signature verifies against
   `desktop/updater.pubkey`; then it uploads the payloads and DMGs first and
   the manifest last, through a rename, and reads every URL back. Set
   `SPAWN_DESKTOP_CHANNEL=beta` to publish under `desktop/beta/`. Never
   assemble or sign this manifest in CI.

The static origin behind those URLs is nginx, not the server or Next: the
`location /desktop/` block in `infra/nginx-spawnd.conf.example` serves
`/var/www/spawnd/desktop/` directly (`SPAWN_DESKTOP_DIR` for the script), so
the updater and the download page never depend on the app being up. It holds
the DMGs the download page links to (`SPAWN-D_<version>_<platform>.dmg`), the
`.app.tar.gz` updater payloads, the one Windows setup EXE, and `latest.json`.
Detached `.sig` files are not public objects.

Publish before deploying a commit whose `desktop/` tree is new. `GET
/api/release` reports the `desktop` block — and the download page lights its
platform links — from the deployed checkout alone, without checking that a DMG
or EXE at that URL exists, so a deploy that precedes the publish hands out a
404.

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
    "platforms": ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]
  }
}
```

Unknown or dirty desktop identities are `null`, as for the other release
pieces. `scripts/verify-release.sh` compares this block, the served
`/desktop/latest.json`, all three served updater artifacts and their Tauri
signatures against the public key committed at the selected ref. Authenticode
chain/SmartScreen validation remains a Windows CI and release-QA check; the
Unix verifier proves byte identity and the offline updater trust root. Use
`--skip-desktop` only
when intentionally verifying a release that predates the app or an environment
where the static desktop origin is unavailable.

## The daemon prebuilts

Installers download daemon binaries from the production server, and the server
hands out whatever `deploy-prod.sh` last published to it from the rolling
`prebuilt-latest` GitHub release. Normally CI
(`.github/workflows/prebuilt.yml`) rebuilds that release on every daemon
change to master, the deploy verifies the release's `COMMIT` still matches the
daemon tree being deployed and its `TREE` is exactly
`git rev-parse <deployed-ref>:daemon`, and nothing more is needed.

The release has five public targets:

| Public target | Rust triple |
| --- | --- |
| `darwin-aarch64` | `aarch64-apple-darwin` |
| `darwin-x86_64` | `x86_64-apple-darwin` |
| `linux-aarch64` | `aarch64-unknown-linux-gnu` |
| `linux-x86_64` | `x86_64-unknown-linux-gnu` |
| `windows-x86_64` | `x86_64-pc-windows-msvc` |

Unix filenames remain extensionless. The Windows release assets and
`SHA256SUMS` entries are exactly
`spawnd-x86_64-pc-windows-msvc.exe` and
`spawn-worker-x86_64-pc-windows-msvc.exe`; their canonical server files are
`prebuilt/windows-x86_64/spawnd.exe` and `spawn-worker.exe`. The HTTP API paths
remain logical and extensionless at `/api/install/spawnd/windows-x86_64` and
`/api/install/spawn-worker/windows-x86_64`, with `.exe` in each response's
download filename. Windows is required; unlike the existing best-effort Linux
ARM target, a missing half of its pair blocks release preparation.

Signing and hashing order is immutable: stage both Windows PEs, Authenticode-
sign and timestamp both, verify the exact publisher and timestamp with
`Get-AuthenticodeSignature` and SignTool, then construct `SHA256SUMS`. Only
after all five pairs are staged does the operator render and sign the offline
Ed25519 manifest. Never modify a PE after Authenticode signing or construct the
manifest from pre-signing hashes.

When CI cannot run (out of credits, broken runner), the release goes stale and
the deploy will refuse — correctly. Refresh it by hand from the **pushed**
master commit. Build Darwin and Linux as before:

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

Build Windows on a real x86_64 Windows 11 or Server machine with Visual Studio
Build Tools' “Desktop development with C++” workload and stable Rust MSVC:

```powershell
rustup target add x86_64-pc-windows-msvc
Set-Location daemon
cargo check --locked --target x86_64-pc-windows-msvc --bin spawnd --bin spawn-worker
cargo clippy --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings
cargo test --locked --target x86_64-pc-windows-msvc
cargo build --release --locked --target x86_64-pc-windows-msvc --bin spawnd --bin spawn-worker
```

Stage the two exact `.exe` asset names, sign them through Artifact Signing (or
the pre-approved HSM fallback), and run the same subject, timestamp, SignTool,
hash, and `scripts/smoke-install-prebuilt.ps1` gates as CI. There is no
project-supported Docker or Wine substitute for native Windows runtime,
locking, service and installer validation. `cargo-xwin` is an emergency
compilation aid only; its output must still pass through a real Windows signing
and validation host before publication.

When only GitHub runner capacity is unavailable and Artifact Signing itself is
healthy, use Microsoft's local SignTool/dlib integration on that Windows host:

```powershell
winget install -e --id Microsoft.Azure.ArtifactSigningClientTools
winget install -e --id Microsoft.AzureCLI
az login

@'
{
  "Endpoint": "https://<region>.codesigning.azure.net/",
  "CodeSigningAccountName": "<account>",
  "CertificateProfileName": "<profile>"
}
'@ | Set-Content -LiteralPath .\metadata.json -Encoding ascii

$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
  -Filter signtool.exe -File -Recurse | Where-Object FullName -Match '\\x64\\' |
  Sort-Object FullName -Descending | Select-Object -First 1
$dlib = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft\ArtifactSigningClientTools" `
  -Filter Azure.CodeSigning.Dlib.dll -File -Recurse |
  Where-Object FullName -Match '\\x64\\' | Select-Object -First 1
if (-not $signTool -or -not $dlib) { throw 'Artifact Signing SignTool/dlib was not found' }

foreach ($file in @(
  '.\spawnd-x86_64-pc-windows-msvc.exe',
  '.\spawn-worker-x86_64-pc-windows-msvc.exe'
)) {
  & $signTool.FullName sign /v /debug /fd SHA256 `
    /tr http://timestamp.acs.microsoft.com /td SHA256 `
    /dlib $dlib.FullName /dmdf .\metadata.json $file
  if ($LASTEXITCODE -ne 0) { throw "Artifact Signing failed for $file" }
}
Remove-Item .\metadata.json
```

The local identity needs the same certificate-profile Signer role. Use Windows
SDK SignTool 10.0.2261.755 or later, .NET 8, and the matching x64 dlib; then run
the configured-subject/timestamp verifier and smoke before uploading. If
Artifact Signing itself is unavailable, use the pre-approved HSM vendor—never
an ad-hoc or self-signed production certificate.

Then assemble the assets the way the workflow's single publish job does — the
five `spawnd-<triple>[.exe]` plus five `spawn-worker-<triple>[.exe]` binaries,
`SHA256SUMS`, `COMMIT`, `TREE`, and `VERSION`. From the repository root, after
placing the already-signed binaries in `out/`:

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
host manifest, installs Windows payloads on the Linux API host as mode `0644`,
signs the manifest locally, and refuses to publish a partial required Windows
pair or to publish without the readable release-signing key. For a focused
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

For a Windows launch or any release that changes the native Windows handoff,
ship in this order:

1. Observe a successful native `windows-check` lane. Build the Windows daemon
   pair and desktop app on `windows-latest`; Authenticode-sign and timestamp
   every PE, including the final NSIS setup EXE, and verify the configured
   publisher before upload.
2. Download the already-signed daemon assets, verify their release identity,
   construct `SHA256SUMS`, render the five-target daemon manifest, and sign its
   exact bytes with the offline Ed25519 key.
3. Publish the desktop payloads and updater manifest, then deploy the server
   and all five daemon prebuilt pairs. Manifests are published last through an
   atomic rename.
4. Verify the public manifest signature, public binary bytes/hashes and Windows
   `.exe` response filenames. On Windows, independently verify Authenticode and
   run the public PowerShell installer.
5. Only then deploy web/mobile copy or controls that hand users
   `irm https://spawnd.dev/install.ps1 | iex`. A native Windows handoff must
   never point at an unsigned/missing daemon pair or a missing signed desktop
   installer.

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

On Windows, `spawnd.exe` is the program that binds UDP 50000–50100. The
per-user installer does not elevate or silently create a firewall exception.
Windows Firewall, Defender/SmartScreen, and Smart App Control are independent
validation surfaces; Authenticode does not remove the firewall prompt. If
inbound ICE is blocked, ordinary outbound UDP TURN remains the fallback.

An administrator who explicitly wants direct candidates on a Private network
may add a program-scoped rule for the installed binary:

```powershell
$spawnd = Join-Path $env:LOCALAPPDATA 'spawn\bin\spawnd.exe'
New-NetFirewallRule -DisplayName 'SPAWN D direct WebRTC (Private)' `
  -Direction Inbound -Action Allow -Profile Private -Program $spawnd `
  -Protocol UDP -LocalPort 50000-50100

# Uninstall or rollback:
Remove-NetFirewallRule -DisplayName 'SPAWN D direct WebRTC (Private)'
```

Do not broaden this to any program or the Public profile. Test both direct ICE
and TURN fallback, and inspect the actual allow/block rules created when the
first-listen prompt is accepted, declined, or dismissed by administrator and
standard-user accounts.

## Release checklist

1. Confirm the checkout is clean and pushed. When daemon or Windows code
   changed, require the native `windows-check` check/clippy/test and PowerShell
   smoke to pass, plus the existing Unix suite. Confirm the local offline
   daemon release-signing key is present and readable.
2. Confirm the rolling release contains all five target pairs. For both Windows
   daemon files, verify `Get-AuthenticodeSignature` is `Valid`, its subject is
   exactly `WINDOWS_SIGNING_SUBJECT`, an RFC 3161 timestamp is present, and
   `signtool verify /pa /all /v` exits zero. Confirm their post-signing hashes
   are the `.exe` lines in `SHA256SUMS` and the offline-signed five-target
   manifest.
3. For a desktop release, apply the same Authenticode subject/timestamp gates
   to the inner desktop executable and final NSIS setup EXE, then complete the
   offline Tauri signing/publish procedure in “The desktop app”.
4. On a clean Windows 11 x64 VM, test the public installer from Windows
   PowerShell 5.1 and PowerShell 7 as a standard user. Complete possession in
   the attached console, prove `%LOCALAPPDATA%\spawn\bin\{spawnd,spawn-worker}.exe`,
   User PATH persistence and Scheduled Task health, then re-run and prove the
   pair's hashes/timestamps are unchanged. Exercise the documented switches.
5. Test Windows failure and policy surfaces: corrupt hash/download, locked
   worker rollback, clean recovery, expected enterprise-policy failure,
   SmartScreen/Defender/Smart App Control behavior, first-listen firewall
   choices, direct WebRTC, the optional Private program rule, and TURN fallback.
6. Run `scripts/deploy-prod.sh <ssh-host>`. Do not continue past a hard gate by
   habit; fix the release or record why the emergency prebuilt override is safe.
7. If `mobile/` changed, run
   `scripts/update-mobile-prod.sh -m "<same summary as the deploy>"`. If native
   code, configuration, entitlements, or the runtime version changed, publish a
   real store build as well.
8. Exercise the changed user flow. For network or signalling changes, also run
   `scripts/health-check.sh` with the production `SPAWN_TURN_URLS`; this checks
   the public WebSocket upgrade and the configured UDP TURN listener. Keep the
   migration compatibility rule above in mind while the previous processes are
   still draining.
9. Last, prove the independently shipped identities and all five served daemon
   target pairs:

   ```bash
   scripts/verify-release.sh https://spawnd.dev
   ```

   The verifier expects `origin/master` by default. Use `--ref <git-ref>` for
   an intentional branch deploy and `--skip-mobile` only when this environment
   cannot reach Expo. It prints `PIECE / EXPECTED / ACTUAL / RESULT` and exits
   non-zero on any mismatch. A release is not finished until this final proof
   passes or the skipped external dependency is explicitly handed off.
