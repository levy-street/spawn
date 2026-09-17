# Native connection acceptance

`.github/workflows/native-acceptance.yml` builds the exact requested candidate
into a Release iOS simulator app and a Release Android emulator APK. It uses
standard GitHub-hosted platform runners without EAS credentials, Apple distribution credentials,
Play publication, production access, or paid test services. The parent acceptance
workflow calls it with full candidate and deployed-baseline commit SHAs; manual
`workflow_dispatch` accepts the same inputs. The native suite exercises the
candidate. Its baseline field records acceptance cohort provenance only.

The real SPAWN D app runs with its normal providers, authenticated account gate,
shared daemon registry, `TerminalSurface`, `HostTransportSurface`, WebViews,
secure storage, crypto, and native app lifecycle. A fixture controller mounts
these surfaces and drives their public APIs. `adb` and `simctl` cause actual
background, foreground, and process termination/relaunch effects, so a separate
Maestro service is unnecessary. These tests cover the transport acceptance
boundary; they do not replace user interface navigation tests or physical
handset evidence.

On process relaunch, the controller reuses an identical stored fixture token
after validating its account with the API. It lets the real AuthGate restore
that account rather than resetting the ready identity during device registration.
Fresh logins and account switches still use the normal account-adoption path;
registration waits for the expected account to be ready.

## Build isolation

`prepare-native-acceptance.mjs` copies `mobile/` into a **new directory outside
mobile/** and runs `npm ci` there. It requires a clean tracked checkout at the
candidate SHA and copies only tracked files; ignored local configuration and
credentials cannot enter the bundle. It leaves the source checkout and its existing
`node_modules` untouched. Only this disposable copy receives:

- Application identifier `dev.spawnd.acceptance`, scheme `spawn-acceptance`,
  disabled OTA updates, and local HTTP permission.
- An iOS simulator keychain group for that application identifier. Xcode uses
  its local ad-hoc signing identity (`-`) and embeds the simulator entitlements;
  the build verifies the signature and entitlement sections before installation.
  No Apple team, certificate, or provisioning profile is used. Android's Release
  APK uses the template's disposable debug keystore. Neither app is published.
- The controller in `src/terminal/`, mounted inside the real `AuthGate`. A fresh
  login waits for the account query reset before registering the device;
  process relaunch preserves an identical restored login without resetting it.
- A worker bridge observation hook and an RTC wrapper. The wrapper creates real
  native `RTCPeerConnection` objects, replaces ICE configuration before peer
  construction with the isolated client TURN proxy, and samples `getStats()`
  and real data channel counters. It does not rewrite signed SDP or replace
  channels, transport readiness, or received data with simulations.
- A random fixture control token in private generated config. Never publish the
  build or upload this config, the fixture ready file, or bundled app assets.

The source app has no controller import or acceptance route. Source sentinels
fail preparation if the authenticated mount or worker bridge changes. Both the
build and running controller refuse external fixture origins. Runtime events
include the embedded candidate SHA, and the fixture rejects mismatched evidence.

The Android acceptance build keeps a 2 GiB JVM heap and raises the metaspace
limit to 1 GiB because Release lint exhausted the template's 512 MiB limit in
CI. `ExitOnOutOfMemoryError` makes the Gradle JVM exit if memory is
exhausted again. The build still runs Release lint and targets only x86_64.
After the isolated fixture prepares its private executable copies, the
Android job cleans its Cargo compilation outputs. After a successful APK build,
`compact-android-build.py` stages the APK beside its build metadata and removes
only that run's generated `android/` and `node_modules/` directories before SDK
installation. It requires the disposable `RUNNER_TEMP/native-app` directory;
required SDKs, fixture executables and evidence remain available.

`android-disk-preflight.py` requires 15 GiB before either compilation and
16 GiB before emulator setup on every involved filesystem. On the disposable
Ubuntu 24.04 runner it reclaims only the explicitly named unused preinstalled
tools when less than 40 GiB is free. Before/after free-space measurements avoid
recursive tool-size scans; the guard refuses other hosts. Android uses the hosted SDK and KVM;
macOS uses the installed Xcode and simulator runtimes. The workflow installs
coturn on both platforms and Ninja for Android compilation. No persistent CI
account, operator home or production credential is involved. See
[`CI_RUNNERS.md`](../../docs/CI_RUNNERS.md) for the current runner map.

The emulator threshold reserves room for downloads, extraction, writable AVD
data and logs. On 2026-09-11 the official API 35 Google APIs x86_64 r9 image and
Linux emulator 37.1.11 archives totaled 1.93 GiB compressed and 4.30 GiB expanded
(measured from ZIP central directories); simultaneous staging alone needs
about 6.23 GiB. The [pinned emulator action installs both after the app build](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/sdk-installer.ts).
The headroom checks fail the job early if available space is insufficient;
they do not replace native runtime acceptance.

The iOS runner allows one 600-second installation attempt after its bounded
300-second boot wait; a cold hosted run exceeded the previous 120-second
installation limit. The cause of that timeout was not captured. Simulator
selection is now saved before boot/install in `native-platform.json`, and
`native-runner.jsonl` records command timing, free disk space, separate stdout
and stderr, and failures with credentials redacted. Setup failures report a
failed `runner-error` event to the fixture and still fail the job; product cases
are not retried or accepted when setup fails.

The controller records fixed startup phases and redacted local failures in
`native.log`, even when fixture event reporting is unavailable. The bounded
HTTP trace includes known control routes and token-presence flags without
recording tokens or request content. Once fixture provisioning is ready, app
boot has its own 180-second limit; failure starts no connection cases. Runner
failures capture a screenshot and a bounded, redacted Android accessibility
dump on the validated emulator. Diagnostic failures preserve the original
failure, and temporary accessibility files are removed from that emulator.

Fixture preparation starts the API and relay and copies the exact daemon/worker
pair. Its authenticated build configuration contains the run, candidate and ICE
configuration, without requiring live accounts or sessions. After compilation,
emulator boot and app installation, the runner activates the daemon and sessions
once and waits up to 90 seconds for readiness. It checks process liveness and
fresh API host/session readiness before launching the app. Unexpected daemon or
relay exits permanently fail the run and produce timestamped diagnostics; the
fixture never restarts a failed process to obtain passing evidence. This keeps
cold build work outside live daemon acceptance without changing the daemon's
fail-closed credential deadline.

## Running with an isolated fixture

The runner needs Node 22, Python 3.13 for the fixture, Rust for the real daemon
pair, coturn, and either Xcode with an iOS Simulator runtime or the Android SDK
with an x86_64 emulator. See the workflow for exact setup commands. From the
repository root, prepare the API and relay before building; the fixture timeout
includes build time, while daemon activation waits until installation finishes:

```bash
cargo build --locked --manifest-path daemon/Cargo.toml --bin spawnd --bin spawn-worker
server/.venv/bin/python scripts/native-acceptance-fixture.py \
  --output /tmp/spawn-native-evidence --ready-file /tmp/spawn-native-ready.json \
  --client-host 127.0.0.1 --port 18100 --transport relay --timeout 7200 \
  --baseline "$BASELINE_COMMIT"
```

For Android use `--client-host 10.0.2.2`. Export `SPAWN_ACCEPTANCE_API_URL` and
`SPAWN_ACCEPTANCE_TOKEN` from the private ready file (`apiUrl` and `token`), then:

```bash
bash mobile/e2e/build-native-acceptance.sh ios /tmp/spawn-native-ios
python3 mobile/e2e/run-native-acceptance.py --platform ios \
  --build /tmp/spawn-native-ios --ready-file /tmp/spawn-native-ready.json \
  --output /tmp/spawn-native-evidence
```

Use `android` and a fresh build directory for Android. `--fixture-url` defaults
to the runner's `http://127.0.0.1:18100`; the app uses the platform host alias.
The native runner selects an installed iPhone simulator matching the active
Xcode simulator SDK's major/minor version, or the single running Android
emulator. A missing matching iPhone runtime fails setup; use `--device UUID`
for intentional coverage of another installed iPhone runtime. It refuses
physical Android devices. On iOS it warms Settings before starting the fixture
or test app, so initializing that system app is outside the timed cases.
Foreground resumes the existing app through its disposable `spawn-acceptance`
URL scheme; initial launch and process restart still use `simctl launch`.
The suite continues to require actual native lifecycle callbacks and a measured
short background interval below three seconds. It records the actual runtime,
simulator SDK, app build metadata, screenshots and sanitized native logs. The fixture
writes the acceptance verdict and verifies real shell input, upload hashes and
UDP fault counters. A native build, typecheck, Expo export, Jest result, or Expo
Go smoke alone does not produce a passing native verdict.

## Controller contract

All control HTTP requests use `X-Acceptance-Token`. Bootstrap supplies the exact
candidate, fixture account tokens, pinned host identity, two session IDs and
client TURN configuration. `/__acceptance/device` endorses the real registered
native public key through the fixture's normal signed account authority.

App commands from `GET /__acceptance/command` are `{id, action, payload}`:

| Action | Payload / effect |
| --- | --- |
| `mount` | `{sessions:["a","b"],tools:2}`; wait for real attachments to become ready |
| `unmount` | Detach all terminal and host-tool views |
| `snapshot` | Sample actual session/tool states and latest native peer observation |
| `retry-host` | Close/open the retained root through the public retry API without replacing or registering the device identity |
| `input` | `{session,text,takeControl}`; optionally await daemon-confirmed control, then write |
| `host-request` | `{tool,operation,payload}`; fixture permits `fs.home` / `fs.list` |
| `upload` | `{session,uploadId,name,totalBytes,readDelayMs}`; start real byte source upload and return its SHA-256 |
| `upload-status` | `{uploadId}`; latest actual upload progress/result |
| `rotate-identity` | Reset native identity and register/endorse the replacement |
| `sign-out` / `sign-in` | Real logout and fresh fixture account login |
| `switch-account` | `{account:"a"|"b"}`; account B owns no fixture hosts or sessions |

The native runner consumes `GET /__acceptance/native-command`: `background`
(optional `durationMs` up to 30000), `foreground`, `relaunch`, `screenshot`
(optional `name`), and `finish` (`status:"passed"|"failed"`, optional `reason`).
It exits with the fixture's finish verdict. HTTP control stays outside the UDP
proxy, so a broken RTC path remains observable and recoverable by the suite.

Events POST to `/__acceptance/event` with `type`, optional `commandId`, `status`,
and `details:{schema_kind,candidate_commit,platform,os_version?,launchId?,values}`.
App command values contain `{action,result}` or `{action,error,snapshot}`. Boot
values contain `{runId,snapshot}`. Native command values contain `{action,result}`.
The schema kinds are `native_simulator` and `native_emulator`; neither means a
physical phone passed.

A snapshot has `appState`, `launchId`, `lifecycleSequence`, `lifecycleTransitions`,
`accountReady`, `accountId`, `deviceId`, `identityGeneration`,
`sessions:{a|b:{sessionId,state,daemonState,owner}}`, `tools:[{index,state}]`,
`uploads`, `peer`, `peerAgeMs`, and `nativeDateMs`. The peer observation has `workerId`, `sampledAtMs`,
`livePeerCount`, `createdPeerCount`, and `peers`. Each peer includes its ID,
connection/ICE state, actual channel states/byte counters, and selected candidate
pair fields (`localCandidateType`, `remoteCandidateType`, `protocol`,
`relayProtocol`, bytes and RTT). Counts are per worker; compare `workerId` as
well as counts across lifecycle transitions. Destroyed/background workers can
leave stale observations, so readiness requires a fresh sample, and retirement
also needs independent daemon evidence.
App-state events include `nativeDateMs`, captured with the actual lifecycle
notification. The controller synchronously retains the last 64 observations as
`{sequence,state,nativeDateMs}` before attempting diagnostic HTTP delivery, which
can be interrupted during suspension. After foregrounding, snapshots supply this
journal for measured intervals. The suite requires contiguous observations after
the case's starting sequence, the same app launch, and actual background then
active callbacks; missing, overflowed or reversed evidence cannot pass. Background
case `recovery_ms` measures the full control round trip, including the background
wait and command overhead. `deviceId`
supports revoking the registered key through the normal browser-device API.

GitHub artifacts are `acceptance-native-ios` and `acceptance-native-android`.
They contain fixture `evidence.json`/events/logs and runner metadata/screenshots.
`api-requests.jsonl` records bounded API and acceptance-control response metadata:
route templates, methods, status codes, and whether bearer/client headers or a
control token were present. It omits header and token values, URL parameters,
query strings and request/response bodies.
The aggregate acceptance gate validates both candidate-bound verdicts. No
physical-device, Wi-Fi/cellular handover, production canary or user interface
navigation pass is implied by these simulator/emulator artifacts.

The build follows the official [Expo local native build commands](https://docs.expo.dev/more/expo-cli/#compiling-android)
and [Android Emulator Runner configuration](https://github.com/ReactiveCircus/android-emulator-runner).
Apple documents the application identifier's role in the
[default keychain access group](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).
