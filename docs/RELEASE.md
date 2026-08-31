# Releasing SPAWN D

Read this in full before deploying anything. A SPAWN D release has five moving
pieces — the server + web app, the mobile JavaScript, the mobile native app,
the daemon binaries, and the macOS/Windows desktop app. Ship every piece the change
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
  `desktop/src-tauri/tauri.conf.json`; `/api/release` advertises it only after
  the static desktop root proves the primary Mac image exists, and lists only
  the non-empty platform artifacts present there (see the checklist)

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
  `hard: true`, which is the release watcher's hard prompt: a full-screen
  overlay with a bar spending the countdown, then a reload.
- **the phone** handles `protocol.required` on its sockets the same way and
  routes it into the update path.

### The forced update, and when you are choosing it

A protocol bump is the *only* thing that forces an update, and you do not
switch it on separately — bumping the name is switching it on. There is no
"mandatory release" flag to remember, deliberately: a flag someone forgets is
a fleet stuck on a build the server refuses, and a flag someone sets by habit
is a person locked out of their work over a release that would have been fine.
The question is always the same one the bump already asks. Would a peer
speaking the old name be *wrong*, not merely behind?

What the bump then buys the person, on top of the machinery above:

- **the browser and the phone take the whole screen.** Not a dialog: a dialog
  implies something behind it you could go back to, and after a refusal there
  isn't — every socket in the app has just been closed. Both show a progress
  bar while the new version is fetched, and neither offers Later, because
  there is no version of "later" in which the app works.
- **the bar is indeterminate on the phone**, because `expo-updates` reports no
  progress; in the browser it spends the reload countdown, which is a real
  quantity. Neither invents a percentage. If you are tempted to add one, the
  number would have to come from somewhere that measures it.
- **an update the app cannot take strands the person gently.** A phone whose
  *native runtime* is too old cannot fix itself with an OTA, so it is sent to
  the store — and while there is no listing, it is told plainly and let out of
  the dialog rather than held in one with no button that works.

So before bumping, check the order below is possible at all; and after
deploying, watch that daemons actually land on the new build rather than
looping. A bump you cannot complete is worse than the drift it was fixing.

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

Windows adds a separate, layered publisher proof. CI Authenticode-signs and
RFC 3161 timestamps `spawnd-x86_64-pc-windows-msvc.exe` and
`spawn-worker-x86_64-pc-windows-msvc.exe` before `SHA256SUMS` is created.
Authenticode proves the Windows publisher and PE integrity; it does not
authorize a daemon update. The detached Ed25519 manifest still authorizes the
exact version, targets and post-Authenticode hashes accepted by `spawnd`.

The signer is Dreamhome AI Limited's existing RSA-HSM certificate in Azure Key
Vault, driven by AzureSignTool after a GitHub OIDC login. Microsoft Artifact
Signing was the earlier plan and was dropped: it meant a new signing account, a
new monthly charge, and a portal-only identity validation that sets its own
calendar — to obtain a second certificate for a company that already holds one.
The private key is non-exportable and never leaves the HSM; CI receives only a
short-lived OIDC authorization to request signatures with it. The offline
daemon release key and offline Tauri updater key never enter CI.

Protect the `windows-code-signing` GitHub environment to `master` and scope the
federated credential to that environment. The named secrets are
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`; the variables
are `AZURE_KEY_VAULT_URL`, `AZURE_KEY_VAULT_CERTIFICATE`,
`CODE_SIGN_TIMESTAMP_URL` and `WINDOWS_SIGNING_SUBJECT` (the complete expected
distinguished name). Revoke the federated credential quickly if a permitted CI
run is compromised: it still cannot mint the offline Ed25519 manifest, but
until it is gone it can request publisher-valid PE signatures.

### The Apple signing identity

The same rule as Windows, arrived at later: **a signing identity is reachable
only from `master`, and only through a protected environment.** A GitHub
`environment:` is the sole gate that survives a modified workflow, because an
attacker who pushes a branch can delete an `if:` but cannot grant themselves an
environment's secrets — so the Apple credentials must be *environment* secrets,
not repository secrets. Moving them is a settings change, not a code change, and
the workflows above assume it has been made:

| | |
|---|---|
| `macos-code-signing` | Custom branch policy naming `master` (not `protected_branches` — see the Windows note above, `master` carries no protection rule). Holds `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY`. |
| `unsigned-builds` | No protection rules, no secrets. Exists only so `prebuilt.yml` has somewhere to run off master. |

`desktop.yml` gates both platform jobs identically — protected environment plus
`if: master` — because both exist only to produce signed artifacts and neither
can do anything useful from a branch. Build the app locally instead. The `if` is
not redundant with the environment: without it a branch dispatch fails at the
environment gate, which reads as a broken pipeline rather than a job with
nothing to do.

The two daemon signing paths in `prebuilt.yml` are deliberately *not* symmetric,
and it is worth knowing which way:

- **macOS daemon binaries publish ad-hoc signed.** The Developer ID path is
  dormant behind the `SIGN_DAEMON_WITH_DEVELOPER_ID` variable, because turning
  it on changes what every existing host is asked, once — read "The macOS
  consent dialogs" before you do. Ad-hoc is not a failure: the binary runs, it
  just re-asks for folder access after each self-update, because TCC keys the
  grant on the signing identity and an ad-hoc identity is the binary's own hash.
- **Windows daemon binaries do not publish at all unless Authenticode-signed**,
  on master. An unsigned PE is not merely unpolished — it trips SmartScreen and
  makes no publisher claim at all.

So the Mac daemon ships today without a Developer ID and the Windows one refuses
to ship without a certificate. That asymmetry is a choice about consent prompts,
not an oversight.

`prebuilt.yml`'s macOS job still runs on any ref, because it also builds the
daemon binaries a dev host pulls. It picks its environment by ref, so off master
it runs in `unsigned-builds`, the certificate resolves empty, and the signing
step falls back to ad-hoc — which is what it did before the Developer ID was
introduced. The step also refuses the Developer ID off master on its own, so the
protection does not rest on the environment alone.

Both workflows pin every third-party action to a commit SHA. A mutable tag like
`@v0` or `@stable` is a standing invitation: whoever controls it runs code
inside a job holding the release identity. Re-pin deliberately when upgrading —
`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` — and keep the tag in the
trailing comment so the intent stays readable.

### The Windows signing identity

Provisioned on 2026-08-28; this is the record, not a to-do. Nothing below is a
credential — every value is an identifier, and the one secret involved never
leaves Azure.

| | |
|---|---|
| Certificate | `dreamhomeai-code-signing` in `kv-dreamhome-prod` (`rg-dreamhome-codesign-prod`) |
| Key | RSA-HSM 4096, non-exportable, code-signing EKU `1.3.6.1.5.5.7.3.3` |
| Thumbprint | `982B6765F17F6EDF4395E96AE5ED6F89345AC101` |
| Expires | 2027-07-16 |
| Subject | `E=hello@levystreet.com, CN=Dreamhome AI Limited, O=Dreamhome AI Limited, L=Wellington, S=Wellington, C=NZ` |
| Entra app | `spawn-windows-signing`, client id `cb2a7373-57b7-4b84-98e2-8105dfe754fc` |
| Federated subject | `repo:levy-street/spawn:environment:windows-code-signing` |

The service principal holds `Key Vault Certificate User` on that certificate
and `Key Vault Crypto User` on its key, and nothing else — no subscription,
resource-group or vault-wide scope, and no access to any other repository's
signing. The same certificate signed the World of ClaudeCraft 0.40.1 Windows
installers on 2026-08-26 and Windows reported both signatures `Valid`, so the
mechanism is proven; what is unproven for SPAWN D is only this repository's
wiring to it.

Three things about this arrangement that will cost an afternoon if forgotten.

`master` carries no branch protection rule, so an environment restricted to
`protected_branches` would match nothing and block every Windows job. What is
configured, and what actually works, is a custom branch policy naming `master`.
Revisit the day `master` gains a protection rule.

That restriction also means **the signing path cannot be exercised from a
branch**. A Windows job on any other ref never reaches `azure/login`, so the
merge to `master` is the first run that can prove it end to end. Plan to watch
that run rather than assume it.

`WINDOWS_SIGNING_SUBJECT` is compared for exact equality by both workflows, so
take it from a signature rather than typing it: sign anything once, read
`(Get-AuthenticodeSignature <file>).SignerCertificate.Subject`, and store that
string verbatim. Both workflows pass it through a step `env:` rather than
interpolating it into the PowerShell body — a distinguished name is full of
punctuation, and a value containing a quote should not be able to end the
string it sits in.

To provision this from nothing — a new tenant, or a rotated certificate — see
[AZURE_SIGNING_SETUP.md](AZURE_SIGNING_SETUP.md).

The Windows prebuilt job deliberately remains buildable while signing is
being provisioned: when all three Azure secrets are absent it still builds and,
**off master**, uploads an unsigned Actions artifact, while a partial signing
configuration is a hard failure. On `master` an unsigned pair is not uploaded at
all. That is the fail-closed half, and it matters: `prebuilt-latest` is the prod
install channel, so an absent Azure identity must leave Windows *missing* from
the rolling release — the same graceful degradation `linux-aarch64` already has,
loud at deploy (`publish_prebuilts`) and verify (`SKIP`) time — rather than
quietly publishing unsigned `.exe`s to users. An unsigned Windows pair must not
be treated as release-ready or promoted in Windows-facing UI. Once credentials
exist, signing, exact subject, timestamp and SignTool verification are hard
gates before artifact upload.

`desktop.yml` is deliberately not tolerant that way — a release build of the app
either signs or fails. The buildability it gives up is covered instead by the
`windows-package` job in `.github/workflows/windows.yml`, which does everything
`desktop.yml` does on Windows except sign: icons check, wizard build, desktop
crate tests, the unbundled release build and the NSIS bundle. It asserts its own
output is `NotSigned`, names it `...-setup.UNSIGNED.exe`, and uploads it for
seven days. That installer exists so the Windows handoff matrix can be run
before the signing identity does, and it is never a release artifact:
`publish-desktop.sh` refuses any Windows setup EXE with no Authenticode
certificate table, whatever it is called. Packaging is a full release build on
billed, doubled Windows minutes, so it is asked for rather than automatic: a
manual dispatch, or `[package]` in the commit subject — the latter being the
only way to reach it from a branch while `workflow_dispatch` cannot see the
workflow off the default branch.

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

The counter is also the downgrade boundary, and it takes two keys to cross it.
Automatic daemon updates never downgrade. A deliberate operator retry asks
through `POST /api/hosts/{id}/update` with `{"allow_downgrade": true}` — but
asking is not consent. The daemon honours it only when someone with a shell on
that host has also armed the rollback:

```
touch "$SPAWN_CONFIG_DIR/allow-downgrade"     # or ~/.config/spawn/allow-downgrade
```

The arming expires 30 minutes after that file's mtime, so a forgotten one does
not become a standing permission, and re-arming is another `touch`. The reason
for the second key is `docs/TRUST.md`: the control plane is untrusted, and a
server-side boolean would let a compromised one replay an older validly-signed
manifest and roll the fleet back to a known-vulnerable release. The signature
root of trust would still hold — nothing unsigned can be pushed — but rollback
protection is the one guarantee the counter exists to give, so it is not the
server's to waive. Use the override only when the older signed release is the
intended recovery; it does not permit unsigned updates.

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

## What a release needs, and what does it

Work out what a release owes before doing any of it. Every rule below is a
question about **which tree changed**, because that is what the identities at
`/api/release` are derived from — not what the change felt like.

| changed | the release owes | who does it |
| --- | --- | --- |
| `daemon/` | signed prebuilts for every target | `prebuilt.yml` builds on a master push; **you** sign the manifest, via `deploy-prod.sh` |
| `desktop/` | a signed, notarized app per platform | `desktop.yml` builds on a master push; **you** sign the payloads and write `latest.json` |
| `mobile/` | an EAS OTA on the matching channel | `deploy-prod.sh`, during the deploy |
| `server/`, `web/` | a deploy | `deploy-prod.sh` |
| a protocol name | all of the above, in the order below | see "The wire protocols" |

`scripts/release-plan.sh` is that table executed. Given two commits it reports
which rows are owed, so a pipeline can decide instead of a person remembering:

```bash
scripts/release-plan.sh --from <deployed commit> --to <commit being released>
scripts/release-plan.sh --json          # for a workflow to branch on
scripts/release-plan.sh --no-fingerprint  # offline; mobile_native becomes "unknown"
```

It compares **subtree hashes**, not paths, because a subtree hash is exactly
the identity `/api/release` publishes for that piece — no path glob to get
subtly wrong.

The mobile row is the one worth understanding, because "did `mobile/` change"
is the wrong question. An OTA carries JavaScript and assets, never native code,
and it only reaches installs whose `runtimeVersion` matches — which under this
project's `appVersion` policy means the version in `mobile/app.json`. So the
real question is whether the tree still fits the native shell already on
people's phones, and Expo answers it exactly: `eas fingerprint:compare` against
the last finished production build. Matching fingerprints mean an OTA is
enough. Differing ones mean a store build is owed — and shipping the OTA alone
would either be refused by every install or, worse, hand them JavaScript that
calls native code their shell does not have. Most releases do not need one;
this is how a release knows it is one of the ones that does.

Three of those rows say "you", and that is not an omission to be automated
away later. **The offline keys never enter CI** — the Ed25519 daemon release
key and the Tauri updater key both live on the operator Mac, and CI holds only
platform code-signing credentials (Apple notarization, Azure Authenticode).
That split is what stops one compromised CI run from shipping a daemon or an
app to every machine in the fleet. So the automation stops exactly where a
signature starts: CI produces artifacts and evidence, a person with the key
promotes them.

The mobile OTA is the one piece with no offline key, and it is still not a
workflow. It runs inside `deploy-prod.sh` because that is the only place the
*order* can be promised: the server is already up when the bundle is
published, so phones never fetch JavaScript newer than the API it talks to. A
workflow firing on a push to master could not make that promise. It used to be
a printed reminder, which is a step that gets skipped on exactly the release
where it mattered, and fails silently — the two frontends drift while
everything looks fine.

### The master pipeline, and the one decision it puts in front of you

`.github/workflows/release.yml` runs on every push to `master`. It calls
`release-plan.sh` first and gates every job on the answer, so a docs-only push
finishes in seconds and a daemon-only push deploys without touching the phone.
The order inside it is the forced one described above: prebuilts land before
the server that advertises them, and the OTA goes after the server is up.

It is **armed**, as of 2026-08-31. What that means, precisely, is worth stating
once rather than rediscovering during an incident.

Everything above says the offline keys never enter CI: the Ed25519 daemon
release key and the Tauri updater key live on the operator's Mac, and that split
is what stops one compromised CI run from shipping a daemon to every machine in
the fleet. A fully automatic master release cannot honour that split, because
publishing prebuilts *means* signing a manifest. So the daemon release key is
now a secret in the `production` environment, and the consequence is exact:

**anything that can run a workflow on `master` can sign a daemon build that
every host installs and runs as a service.** That is a deliberate trade for a
zero-human-step release, not an oversight. Treat the key as CI-exposed: rotate
it on any suspicion, keep the environment's branch policy at `master`, and
remember that the daemon's pinned key list in `release_key.rs` is what makes
rotation possible at all.

The Tauri updater key is **not** in CI, and desktop publication stays with a
person, because `latest.json` is assembled from artifacts someone has looked at.
That job prints exactly what to run.

What is configured, so it can be audited rather than guessed:

| `production` environment | branch policy `master` (custom policy — `protected_branches` matches nothing here) |
| --- | --- |
| `EXPO_TOKEN` | Expo access token, note "github-actions release.yml (spawn) verified". Local runs need none because `~/.expo/state.json` holds a session; CI has no session. |
| `SPAWN_DEPLOY_SSH_KEY` | A dedicated ed25519 deploy key, `github-actions-release@spawn` in the prod `authorized_keys`. Revoke by deleting that line. |
| `SPAWN_DEPLOY_KNOWN_HOSTS` | The pinned prod host key. The workflow never runs `ssh-keyscan`: trusting a host key on first connection is the one thing a production deploy must not do. |
| `SPAWN_RELEASE_SIGNING_KEY` | The offline daemon release key, per the trade above. |
| vars `SPAWN_DEPLOY_HOSTNAME`, `SPAWN_DEPLOY_USER` | The prod host and account. |

**The pipeline has never run.** `workflow_dispatch` cannot see a workflow that
is not on the default branch, so `release.yml` cannot be exercised before the
merge that puts it there — the first real run is the merge itself, and it wants
watching rather than assuming. The same is true of `desktop.yml` and
`windows.yml`.

### Things that will bite you off master

`workflow_dispatch` only sees workflows that exist on the **default branch**.
`windows.yml` and `desktop.yml` are not on master yet, so from a feature branch
they cannot be dispatched at all; `[package]` in a commit subject is the only
trigger that reaches `windows-package` from a branch. Merging is what fixes
this, and it fixes it for good.

Windows signing is restricted to `master` by the `windows-code-signing`
environment's branch policy, so **a branch build can never be Authenticode
signed**. Anything built from a branch is a rehearsal artifact: fine for a dev
deployment, never a release. `publish-desktop.sh` enforces this independently
by refusing a Windows setup EXE with no certificate table.

`prebuilt.yml` will build on a dispatch from any ref, but its publish job is
master-only on purpose — the rolling `prebuilt-latest` release is the
production install channel. Branch binaries come out as run artifacts, which is
the supported way to stage a dev host.

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
name — and the server looks in it before advertising a desktop version. The
primary Apple-silicon DMG gates the block, and its platform list is narrowed to
the non-empty Apple DMGs and Windows setup EXE actually present. A deploy that
lands before the publish therefore says nothing about the desktop app rather
than pointing the download button at a 404. If the directory does not exist at
all the server cannot check, so it fails open with all expected platforms and
logs an error naming this variable; a download that vanishes silently would be
the harder failure to notice.

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

A release build leaves `SPAWN_DESKTOP_SERVER_ORIGIN` unset, which is what makes
it point at `https://spawnd.dev` and what keeps it on the vendor's signed app
channel. A build that sets it — one made for a dev deployment — defaults to
that server instead **and takes its updates from that server too**, never from
production, so it can never quietly replace itself with the production app.
Setting it during a release is therefore a way to ship an app that talks to the
wrong fleet and updates from it; leave it alone unless that is the point
(`desktop/CLAUDE.md`).

### Serving a deployment's own app channel

A deployment that hands out desktop apps should serve the channel those apps
read, or they never hear about a fix. The layout is the vendor's, under that
deployment's `/desktop/`:

- `SPAWN-D_<version>_<platform>.app.tar.gz` — the macOS updater payload, made
  with `COPYFILE_DISABLE=1 tar -czf … -C bundle/macos "SPAWN D.app"`. The DMG
  is the *download*; the tarball is the *update*, and both must be published.
- `SPAWN-D_<version>_windows-x86_64-setup.exe` — on Windows one file is both.
- `latest.json` — `{version, notes, pub_date, platforms{<platform>{signature,
  url}}}`, where `signature` is the contents of the payload's `.sig` and `url`
  is absolute, on that deployment's origin.

Every payload is signed with the offline updater key
(`npx tauri signer sign -f ~/.tauri/spawn-desktop.key <payload>`, password in
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, never on argv). The app verifies against
the pubkey compiled into `tauri.conf.json`, which is the same on every channel,
so a dev channel is a different audience rather than a lower bar: an
unsigned or wrongly-signed payload is refused there exactly as in production.

Write `latest.json` last. A payload with no manifest entry is invisible, which
is safe; a manifest naming a payload that is not there yet is an update every
app will try and fail to take.

The Apple credentials are
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_PRIVATE_KEY`, `APPLE_API_KEY`, and `APPLE_API_ISSUER`. The workflow
uses GitHub OIDC for Azure Key Vault with secrets `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`, plus environment variables
`AZURE_KEY_VAULT_URL`, `AZURE_KEY_VAULT_CERTIFICATE`, and
`CODE_SIGN_TIMESTAMP_URL`, plus the complete expected certificate subject
`WINDOWS_SIGNING_SUBJECT`. It signs and RFC 3161 timestamps the inner
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

1. Download every workflow artifact this release has — the two Mac ones
   always, the Windows one once Windows has launched — and verify their
   checksums, versions, both Mac code signatures/notarization tickets, and,
   when present, the Windows Authenticode evidence for both the inner app and
   outer setup EXE. On Windows,
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
/api/release` checks `/var/www/spawnd/desktop/` on every request: it withholds
the whole desktop block until the non-empty Apple-silicon DMG exists, and then
lists only the non-empty Intel DMG and canonical Windows setup EXE that are
also present. When the directory itself is absent it deliberately fails open
with all expected platforms and logs loudly, because a silently vanished
download surface would hide the broken mount. Publish every platform this
release claims before deploying, so each advertised link resolves immediately.

Until Windows launches, a release is the Mac pair alone, and that is a complete
release rather than a degraded one: `publish-desktop.sh` requires the two Mac
platforms and treats Windows as optional, `/api/release` advertises only what is
mounted, and both frontends read that and say Windows is coming soon. What is
still refused is a half-published platform — name one of a platform's files and
all of them must be present, signed, and in the manifest. The day Windows
launches it moves into `REQUIRED_PLATFORMS` in that script and into
`PREBUILT_REQUIRED_TARGETS` in `scripts/release-lib.sh`, and its absence becomes
a release blocker again.

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
`/desktop/latest.json`, every served updater artifact the release claims and
their Tauri signatures against the public key committed at the selected ref. It
requires the Mac pair and reports an unclaimed Windows as a skip rather than a
failure. Authenticode
chain/SmartScreen validation remains a Windows CI and release-QA check; the
Unix verifier proves byte identity and the offline updater trust root. Use
`--skip-desktop` only
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
download filename. Windows will be required once it launches; unlike the
existing best-effort Linux
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

Stage the two exact `.exe` asset names, sign them with the Key Vault
certificate, and run the same subject, timestamp, SignTool,
hash, and `scripts/smoke-install-prebuilt.ps1` gates as CI. There is no
project-supported Docker or Wine substitute for native Windows runtime,
locking, service and installer validation. `cargo-xwin` is an emergency
compilation aid only; its output must still pass through a real Windows signing
and validation host before publication.

When only GitHub runner capacity is unavailable and Key Vault itself is
healthy, sign on that Windows host with the same tool CI uses:

```powershell
winget install -e --id Microsoft.AzureCLI
dotnet tool install --global AzureSignTool --version 7.0.1

# An identity holding Key Vault Certificate User on the certificate and
# Key Vault Crypto User on its key. AzureSignTool's -kvm resolves the ambient
# Azure credential, which after this is the signed-in CLI account.
az login

foreach ($file in @(
  '.\spawnd-x86_64-pc-windows-msvc.exe',
  '.\spawn-worker-x86_64-pc-windows-msvc.exe'
)) {
  azuresigntool sign `
    -kvu https://kv-dreamhome-prod.vault.azure.net/ `
    -kvm `
    -kvc dreamhomeai-code-signing `
    -fd sha256 `
    -tr http://timestamp.digicert.com `
    -td sha256 `
    $file
  if ($LASTEXITCODE -ne 0) { throw "AzureSignTool failed for $file" }
}
```

Then run the configured-subject/timestamp verifier and the smoke before
uploading. If Key Vault itself is unavailable, wait for it — never an ad-hoc or
self-signed production certificate, and never a second certificate obtained in
a hurry.

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

0. Close [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md) — the 61-row gate that
   proves the port on a real Windows 11 machine, since a runner can only prove
   it compiles. Most of it needs no signing identity: the `windows-package` job
   produces an unsigned installer for exactly that purpose.
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
   smoke to pass, plus the existing Unix suite. `windows-check` triggers on
   pushes touching `daemon/**`, `desktop/**` or its own workflow, so a release
   whose last commit changed neither will show no run — that is the filter
   working, not a missing gate; dispatch it if you want one anyway. For a first Windows launch,
   [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md) must be closed first. When prebuilts will be
   published, confirm the local offline daemon release-signing key is present
   and readable.
2. Confirm the rolling release contains every target pair it claims — four
   until Windows launches, five after. When the Windows pair is present, verify
   for both files that `Get-AuthenticodeSignature` is `Valid`, its subject is
   exactly `WINDOWS_SIGNING_SUBJECT`, an RFC 3161 timestamp is present, and
   `signtool verify /pa /all /v` exits zero; then confirm their post-signing
   hashes are the `.exe` lines in `SHA256SUMS` and in the offline-signed
   manifest. An unsigned Windows pair is never promoted: publish without it
   instead, which is a Mac and Linux release rather than a broken one.
3. If `desktop/` changed, publish the desktop app **before** the server deploy,
   following "The desktop app" above through `scripts/publish-desktop.sh` and
   publishing every platform entry this release claims. When Windows is one of
   them, its row must contain the canonical
   `SPAWN-D_<version>_windows-x86_64-setup.exe` and its checksum; prove the
   configured publisher and RFC 3161 timestamp on both the inner desktop EXE
   and outer setup EXE; create the offline
   `SPAWN-D_<version>_windows-x86_64-setup.exe.sig`; and require the exact
   `windows-x86_64` URL-and-signature entry in `latest.json`. Complete the
   Mac signing/notarization and offline Tauri publish procedure in “The desktop
   app” either way. Confirm the two non-empty DMGs — and the non-empty setup EXE
   when Windows is included — are in `SPAWN_DESKTOP_DIR`, and
   `/desktop/latest.json` names the checkout's version.
   Publishing first ensures `/api/release` can prove every platform rather than
   withholding missing artifacts; an absent desktop directory fails open only
   to make a broken production mount loud.
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
