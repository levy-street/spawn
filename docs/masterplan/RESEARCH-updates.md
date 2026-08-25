# RESEARCH: industry practice vs the SPAWN D versioning + connection design

Researched 2026-08-25 against scratchpad/SPEC-versioning.md and
SPEC-connection.md. Sources are primary (project docs, engineering blogs,
specs) wherever they exist; claims that drive a recommendation carry a link.

---

## (A) Per-area findings

### A1. Auto-update architectures for daemons/agents

**Chrome / Omaha.** The Omaha protocol is app-layer over HTTP; update-check
integrity is protected by CUP (server signs responses against a key pinned in
the client, with a per-request client nonce) "even in the presence of
compromised TLS" — Google explicitly does not trust TLS alone for update
metadata. Rollout is server-side: `cohort`/`cohorthint`/`release_channel`
attributes let the server bucket clients, throttling is a server `X-Retry-After`
plus mandated client-side randomized desync, and every request carries a
128-bit `sessionid`/`requestid` for dedupe. There is **no client-side automatic
rollback**: Chrome's safety story is staged rollout plus a server kill switch
(stop serving, push a new version). Delta updates (`.puff`) exist but only pay
off at Chrome scale.
[Omaha protocol 3.1](https://chromium.googlesource.com/chromium/src/+/main/docs/updater/protocol_3_1.md) ·
[CUP design](https://github.com/google/omaha/blob/main/doc/ClientUpdateProtocol.md)

**Sparkle (macOS).** Updates are verified against an EdDSA (Ed25519) public
key shipped inside the app (`SUPublicEDKey`); the appcast carries
`sparkle:edSignature` per enclosure. The point of the design, stated outright:
a compromised update **web server** must not yield code execution on clients.
Key rotation is bootstrapped through Apple code signing (the new app's Apple
signature vouches for a changed Sparkle key). Validation happens **before**
install; there is no post-install health gate — macOS apps relaunch under the
user's eyes, so a broken update is immediately visible, which is not true of a
daemon.
[Sparkle docs](https://sparkle-project.org/documentation/) ·
[EdDSA migration](https://sparkle-project.org/documentation/eddsa-migration/)

**Syncthing.** The closest analogue to spawnd: a Go daemon that replaces its
own binary. It verifies a compiled-in ECDSA public key against a signature
over the **binary itself** before swapping; mismatch → delete temp files,
abort, keep running the old binary. Two channels (stable / RC), monthly
cadence. Again: verification is pre-swap only; no automatic post-swap revert.
[Release signing](https://docs.syncthing.net/dev/release-signing.html) ·
[Release channels](https://docs.syncthing.net/users/releases.html)

**Tailscale.** `clientupdate` implements per-platform update: where a package
manager installed the client, the package manager upgrades it; `NewUpdater`
**refuses auto-update entirely when the install method can't support it**
(`ForAutoUpdate` errors) — the same idea as our `self_update_blocked` classes,
validated. Downloads are verified by `distsign`: two-tier Ed25519 — offline
**root keys baked into the client at compile time** sign bundles of signing
keys; signing keys sign BLAKE2s package hashes (`SignPackageHash`); the client
verifies via `Client.Download`/`ValidateLocalBinary`. Rollout is fleet-level:
updates start "a few days after the release is built" once deemed stable, and
are **activity-aware** — deferred while the node is pushing traffic or has
open SSH sessions, forced after ~1 day so servers don't straggle. The control
plane can trigger an update (c2n), mirroring our `daemon.update` frame.
[distsign](https://pkg.go.dev/tailscale.com/clientupdate/distsign) ·
[clientupdate](https://pkg.go.dev/tailscale.com/clientupdate) ·
[Auto-updates GA post](https://tailscale.com/blog/auto-update-ga)

**Fleet Orbit / Kolide launcher (1Password Device Trust).** Security agents
that update osquery and themselves use full TUF (Orbit: go-tuf; Kolide: an
in-house client that they had NCC Group audit — a signal of the stakes they
assign to updater code). The Kolide/1Password agent checks hourly, downloads
into a **local update library of multiple versions**, and "whenever the device
is restarted, the agent chooses the appropriate update from its update library
to run" — i.e. more than one fallback generation is retained, not a single
`.prev`. Per-component channels (stable/beta/edge).
[Orbit README](https://github.com/fleetdm/fleet/blob/main/orbit/README.md) ·
[1Password agent autoupdate](https://1password.com/blog/how-the-1password-device-trust-agent-autoupdates) ·
[Fleetd updates](https://fleetdm.com/guides/fleetd-updates)

**systemd-sysupdate / Mender / RAUC (the rollback canon).** A/B schemes hold
the answer to the question our design leaves open. Mender's contract: after
the new version boots, the update is **not persistent until committed**, and
the commit happens only when the daemon comes up AND successfully reports to
the server; bootloader boot-counting reverts to the old slot if the new one
can't even boot, and a failed phone-home also rolls back. Custom health checks
can be added to the commit gate. This "new binary must phone home or the old
one comes back" pattern is precisely the missing piece in our
rename-swap+exec design, and it does not need A/B partitions — only a marker,
a deadline, and the retained `.prev`.
[Mender customize update process](https://docs.mender.io/overview/customize-the-update-process) ·
[Mender rollback discussion (Mender dev)](https://news.ycombinator.com/item?id=13745959) ·
[systemd-sysupdate(8)](https://man7.org/linux/man-pages/man8/systemd-sysupdate.8.html)

**Tauri / Electron.** Tauri: minisign (Ed25519) signature over the update
bundle, **verification cannot be disabled**. Electron/Squirrel.Mac: TLS plus
platform code signing (both the running and the new app must be signed).
[Tauri updater](https://v2.tauri.app/plugin/updater/) ·
[Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates)

**What this says about our design.** Verify-before-swap (`--version` sanity
run) is standard and we do it. Refuse-when-unable (`self_update_blocked`) is
standard and we do it. Server-triggered update (c2n-style) is standard.
Retaining `.prev` is standard-or-better. The two deviations from best
practice: (1) **no post-swap health gate with automatic revert** — the best
daemon updaters (Mender-class; Tailscale by staging + packaging) never leave
"new binary starts but can't register" unrecoverable, while ours crash-loops
or sits deaf until a human runs the reinstall curl; (2) **trust is
TLS-to-the-control-plane only** — every peer system surveyed (Sparkle,
Syncthing, Tailscale, Tauri, Orbit/Kolide, even Omaha via CUP) verifies
updates against a key pinned in the client, precisely so a compromised server
can't own the fleet.

### A2. Update security

**TUF's four attacks vs our TLS+server-sha256 scheme.**
[TUF security model](https://theupdateframework.io/docs/security/) ·
[TUF spec](https://theupdateframework.github.io/specification/latest/)

| TUF attack | Our scheme stops it? |
|---|---|
| Arbitrary install | **No.** The server that serves the binary also publishes its hash over the same channel. Control-plane compromise = signed-nothing malicious binaries to every daemon, running as the user on every machine. TLS only authenticates the server, not the release. |
| Rollback | **No.** The daemon installs whatever tree differs from its own; a compromised or mis-deployed server advertising an older tree downgrades the fleet. Nothing compares release recency. |
| Indefinite freeze | **No** (and mostly out of scope). No signed freshness; the server can serve stale metadata forever. TUF fixes this with expiring signed timestamps — the expensive part. |
| Mix-and-match | **Partially.** One manifest carries the spawnd+worker pair per target, so an honest server can't mismatch; nothing cryptographic binds them, and a failed half-swap on disk can still produce a mismatched pair locally. |

**The smallest meaningful step up** is the Sparkle/Syncthing/Tailscale-distsign
model, not TUF: one Ed25519 release keypair; the private half offline (or at
minimum outside the production host — the deploy runs from the Mac, which is
the natural signing point: `scripts/deploy-prod.sh` signs the manifest before
scp); the public half **pinned in the daemon binary**. Sign the prebuilt
manifest (commit, tree, version, per-target sha256 pairs, plus a monotonic
release date/counter); daemon verifies the manifest signature before trusting
any sha256, and refuses a signed manifest older than what it runs unless a
human forces it (rollback protection without TUF's timestamp machinery). The
daemon already ships Ed25519 verification for signed signalling
(`signed_signal.rs`), so the dependency cost is ~zero; the operational cost is
one keygen, one sign step in deploy, one verify function, and a documented
key-loss story (Sparkle's answer: ship a new pinned key inside an update
signed by the old one; keep an offline backup of the private key).
[Sparkle EdDSA rationale](https://sparkle-project.org/documentation/eddsa-migration/) ·
[Syncthing release signing](https://docs.syncthing.net/dev/release-signing.html) ·
[distsign key hierarchy](https://pkg.go.dev/tailscale.com/clientupdate/distsign)

**Sigstore** (cosign sign-blob / verify-blob, keyless OIDC identities,
transparency log) is the right tool for **public open-source releases** where
consumers can't pre-share a key; it adds online trust roots (Fulcio/Rekor) and
a fat verification dependency to the update path. For a private single-operator
fleet, a pinned key dominates. Full TUF's four-role, expiring-metadata design
is what Orbit/Kolide needed as vendors shipping agents into other people's
fleets; its cost (key ceremonies, metadata refresh automation, freshness
outages when metadata expires) is not worth it here.
[cosign](https://github.com/sigstore/cosign) ·
[Signing blobs](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)

### A3. Client/server version lockstep

**Web.** Vercel's Skew Protection is the current articulated industry position:
version skew is resolved by **version locking** — the client embeds its
deployment id in requests and the platform routes it to *its own* deployment
for a retention window, reloading only when a mismatch is detected on
navigation or the window expires. The norm is therefore *tolerate old clients
briefly, reload gracefully*, not *strict equality, reload now*. Our soft
prompt (5-min poll + visibilitychange + Later snooze) matches the standard
pattern exactly ([codemzy's SPA reload write-up](https://www.codemzy.com/blog/clients-reload-single-page-application-update)
is the canonical independent description); the hard-4003 auto-reload as a
backstop for actual protocol refusal is stricter than Vercel but justified
because our tabs hold live sockets, and matches what Discord does at the
socket layer.
[Vercel Skew Protection](https://vercel.com/docs/skew-protection) ·
[Introducing Skew Protection](https://vercel.com/blog/version-skew-protection)

**Sockets.** Discord's gateway is the reference for close-code-driven version
policy: application close codes partitioned into retryable and non-retryable,
with **4012 "invalid API version"** in the never-reconnect set. Our
4003-protocol-required → update-flow, 1008 → signed-out, 4000/4008/4010 →
reconnect partition is the same shape and is validated practice.
[Discord opcodes & close codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes)

**Compatibility windows.** Kubernetes is the canonical fleet-skew policy:
kubelet may lag kube-apiserver by up to three minor versions (n-3 since 1.25;
n-2 before), with the window explicitly documented and CI-tested. Contract-
testing practice adds the scoping rule: don't test all-pairs, test **the
versions that can plausibly coexist during the release-and-rollback window**.
Our strict tree-equality is the opposite pole — every deploy touching
`daemon/` churns every daemon. At the current fleet size that's fine (and the
spec's split between *outdated* = tree differs → non-forcing update, vs
*incompatible* = subprotocol refused → forced, is already a compatibility
window in embryo — the wire protocol, not the tree hash, is what actually
gates). The scaling cliff to note in the docs: when deploys become frequent or
the fleet large, (a) every deploy triggers a simultaneous fleet re-exec at
re-register (a thundering herd absorbed today only by natural reconnect
spread; Omaha handles this with server `X-Retry-After` plus mandated client
desync), and (b) any wire change forces same-day updates. The industry answer
is to promise "server supports daemon protocol N-1 for one release" and let
the tree-hash update ride behind, not to abandon content identity.
[Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/) ·
[Contract-testing version matrix scope](https://qaskills.sh/blog/contract-testing-consumer-version-matrix) ·
[Omaha protocol 3.1](https://chromium.googlesource.com/chromium/src/+/main/docs/updater/protocol_3_1.md)

### A4. Expo / React Native updates

**runtimeVersion.** Current expo-updates docs list three policies —
`appVersion`, `nativeVersion`, `fingerprint` — and no longer mark fingerprint
experimental (older third-party posts calling it experimental are stale;
Expo's own fingerprint blog is from Feb 2024 and the SDK docs now present it
as a standard option that "make[s] incompatible updates extremely unlikely").
`appVersion` (our policy) has exactly the two failure modes we suspected,
one in each direction: forget to bump on a native change → incompatible OTA
ships to an old runtime; bump `expo.version` for an App-Store release with
**no** native change → a brand-new runtimeVersion, so every older install is
orphaned off the OTA channel until the user visits the App Store, and our
release-watcher shows a false "update from the App Store" dialog even though
the JS would have run fine. `fingerprint` hashes the actual native project
state and dissolves both. Cost: fingerprint must be computed identically in
EAS build and `eas update` (CI determinism, `.fingerprintignore` tuning) —
real but bounded work.
[Runtime versions](https://docs.expo.dev/eas-update/runtime-versions/) ·
[expo-updates SDK doc](https://docs.expo.dev/versions/latest/sdk/updates/) ·
[Fingerprint blog](https://expo.dev/blog/fingerprint-your-native-runtime)

**Launch behavior.** Defaults: `checkAutomatically: ON_LOAD`,
`fallbackToCacheTimeout: 0` — never block launch on the network; Expo's
production guidance is to keep it that way and drive adoption through the JS
API (`useUpdates`) after render, which is exactly our release-watcher design
(foreground + 15-min checks, background `fetchUpdateAsync`, prompt to
restart). Keep 0; do not be tempted to raise it for the hard path — show the
in-app updating state instead.
[expo-updates SDK doc](https://docs.expo.dev/versions/latest/sdk/updates/) ·
[Expo OTA best practices](https://expo.dev/blog/5-ota-update-best-practices-every-mobile-team-should-know) ·
[Production playbook](https://expo.dev/blog/the-production-playbook-for-ota-updates)

**Safety nets we get for free and should document.** expo-updates has built-in
error recovery: an update that crashes at startup rolls back toward the
embedded bundle (`isEmergencyLaunch`/`emergencyLaunchReason`), and EAS
supports server-side rollback directives plus staged OTA rollout
(`eas update --rollout-percentage`, sticky per device;
`eas update:revert-update-rollout` to back out). For a one-developer fleet the
meaningful piece is the **rollback command as the OTA kill switch** — it
belongs in docs/RELEASE.md next to `update-mobile-prod.sh`.
[EAS rollouts](https://docs.expo.dev/eas-update/rollouts/)

**Apple review.** There is no guideline that blesses or bans forced-update
screens; the folk law from developer forums: apps do ship non-dismissable
"Update required" screens (and pass review), but an app that bricks itself
gratuitously risks rejection under the functionality umbrella, and reviewers
must never hit the wall themselves. Our design — soft prompt with Later in the
normal case, hard block only when the server has actually refused the
protocol (4003), App Store deep link via `itms-apps://` — is the shape
generally considered safe. Two cautions: make sure a freshly-reviewed build
can never see the hard dialog (the server it points at must accept that
build's protocol on release day — our deploy-ordering gate already enforces
this), and keep the hard dialog reachable-but-rare.
[Apple dev forums on force update](https://developer.apple.com/forums/thread/92734) ·
[force update practice](https://appupgrade.dev/blog/how-to-force-upgrade-ios-swift-app)

### A5. Connection durability

**Perfect negotiation.** The full pattern (polite/impolite roles, rollback on
glare) exists to let *either* side renegotiate at any time. Our topology has a
fixed offerer (browser/phone offers, daemon answers) and a signed-envelope
signalling protocol, so wholesale adoption is wrong; the applicable residue is
exactly what SPEC-connection already specifies — explicit `ice_restart: true`
offers on the same binding, same-id collision rejection otherwise. Validated,
not a gap.
[MDN perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) ·
[Mozilla: perfect negotiation](https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/)

**ICE restart triggers.** W3C/MDN guidance: restart is *required* on
`iceConnectionState → failed`; on `disconnected` it is optional and should be
evidence-gated (e.g. getStats byte counters flat over a couple of seconds)
rather than immediate. Our 5-s grace on `disconnected` + immediate on
`failed` + wake/network-change triggers matches; a getStats flat-line check
during the grace would be the only refinement.
[MDN restartIce](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce) ·
[Hancke on ICE restarts](https://medium.com/@fippo/ice-restarts-5d759caceda6)

**TURN deployment.** Practice for UDP-hostile networks: `turns:` on TCP/443
with a real certificate — port 5349 TLS is commonly blocked too, and some
networks drop non-TLS 443. coturn cannot share 443 with nginx on the same IP
(`tls-listening-port=443` wants the whole listener; the coturn tracker
confirms no SNI pass-through) → second IP, or an SNI router in front.
BigBlueButton's docs are the sober deployment reference. Big meetings vendors
run WebRTC-over-TURN-over-TLS at scale daily, so it is production-viable —
just materially worse latency (TCP-in-TLS head-of-line). Note the asymmetry
for us: `turns:443` helps **browsers and phones only**; the daemon
(webrtc-rs/webrtc-ice 0.17) has no TURN-TCP/TLS, so daemon-side relay stays
UDP `turn:` — already correctly in the spec.
[BigBlueButton TURN docs](https://docs.bigbluebutton.org/administration/turn-server/) ·
[coturn 443 issue](https://github.com/coturn/coturn/issues/1626)

**SCTP message size (ErrChunk-adjacent).** The canonical interop write-up
(Grahl): the only universally safe data-channel message size is **16 KiB**
(Firefox→Chromium ordered+reliable tops out there via deprecated-PPID
fragmentation Chromium can't reassemble); Chromium **closes the channel** on
messages above its 256 KiB cap; older stacks silently discard. So "peer sends
too-big message → connection dies" is an established failure mode, which makes
the clients' 16 KiB input chunking in SPEC-connection the textbook fix — and
implies the **daemon's outbound** frames (PTY output bursts, file transfer)
need the same discipline: honour the peer's SDP `max-message-size` and chunk
at 16 KiB. webrtc-rs's tracker has directly relevant reports: intermittent
data-channel closes with `chunk too short` / DTLS fatal-alert errors
(webrtc-rs #107), rare SCTP handshake failures (#414), and close-path races
(#517) — worth pinning against the ErrChunk investigation's findings.
[Grahl: DC size limits](https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html) ·
[webrtc-rs #107](https://github.com/webrtc-rs/webrtc/issues/107) ·
[webrtc-rs #414](https://github.com/webrtc-rs/webrtc/issues/414) ·
[webrtc-rs #517](https://github.com/webrtc-rs/webrtc/issues/517)

**Keepalive norms.** Industry numbers cluster exactly where the spec landed:
ping every 20–30 s (below the shortest proxy idle timeout — nginx default
60 s, GCP LB 30 s), declare dead after ~2–3 missed intervals; the Python
`websockets` library ships 20 s/20 s; heartbeats are explicitly the mechanism
for half-open TCP detection since the OS won't tell you. Our 25 s server ping
with an 80 s client watchdog (and the daemon's 15 s WS ping / 2-miss rule) is
squarely in the norm — validated, not a gap.
[websockets keepalive](https://websockets.readthedocs.io/en/stable/topics/keepalive.html) ·
[websocket.org heartbeat guide](https://websocket.org/guides/heartbeat/)

**Backoff.** The canon is AWS "full jitter": `sleep = random(0, min(cap,
base·2^attempt))` — under contention it halves total calls vs plain
exponential; "equal jitter" and small ±% jitter are measurably worse, and
decorrelated jitter has known pathologies. SPEC-connection's ±25 % jitter is
the weakest of the standard variants; since `backoffDelay()` is being written
fresh in three codebases, write it as full jitter.
[AWS: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) ·
[Brooker: jitter](https://brooker.co.za/blog/2015/03/21/backoff.html) ·
[decorrelated jitter critique](https://thomwright.co.uk/2024/04/24/decorrelated-jitter/)

**QUIC/WebTransport/MASQUE (horizon).** WebTransport reached cross-engine
Baseline in mid-2026, but RFC 9220 (WebSocket over h3) has no production
support, and the sober guidance is still "WebSockets for most apps".
MASQUE (RFC 9298 CONNECT-UDP, and CONNECT-UDP-Listen) is the emerging
TURN-equivalent relay — it already underpins iCloud Private Relay and
Cloudflare WARP — and is what to watch as the eventual `turns:443`
replacement. Nothing to build now; note both in docs/NETWORK.md as the exit
ramp.
[Ably: WebTransport vs WebSockets](https://ably.com/blog/can-webtransport-replace-websockets) ·
[websocket.org future guide](https://websocket.org/guides/future-of-websockets/) ·
[MASQUE explained](https://http.dev/masque) ·
[smallstep on MASQUE relays](https://smallstep.com/blog/masque-relays-vs-vpns/)

### A6. Testing updaters and version skew

**What real projects do.** Omaha publishes the protocol so fake servers are
trivial; Tailscale tests `clientupdate` against a fake pkgs server; Mender's
model is testable because commit/rollback is an explicit state machine. The
transferable lesson: make the updater a pure-ish pipeline
(download→verify→swap→exec→health) where every stage can be forced to fail,
and test the *stages*, not just the happy path. Contract-testing guidance
scopes the skew matrix: only versions that can coexist during one
release+rollback window — for us that is {previous release, HEAD} × {daemon,
server}, four cells, two of which (new×new, old×old) CI already covers.
[Contract-testing matrix scope](https://qaskills.sh/blog/contract-testing-consumer-version-matrix)

**Local network-condition tools for this Mac.**
- **toxiproxy** (Shopify) — deterministic per-connection TCP faults, no root,
  scriptable over HTTP; toxics: `latency` (+jitter), `timeout`, `slicer`,
  `limit_data`, `bandwidth`, plus per-toxic `toxicity` percentage. The right
  tool for CI-able updater and WS chaos. TCP-only — it cannot shape WebRTC/UDP.
  [toxiproxy](https://github.com/Shopify/toxiproxy)
- **Network Link Conditioner** (Xcode Additional Tools) — system-wide profiles
  (100% Loss, Very Bad Network, custom loss/latency/bandwidth); the reliable
  whole-system and UDP-capable option on modern macOS.
  [NLC background](https://spin.atomicobject.com/simulating-poor-network-connectivity-mac-osx/)
- **dnctl + pfctl** (built-in dummynet) — scriptable loss/latency/bandwidth
  pipes; historically flaky on recent macOS releases, so treat as best-effort
  and fall back to NLC for shaping, pfctl plain `block` rules for hard cuts
  (those always work).
  [dummynet on macOS](https://spin.atomicobject.com/simulating-poor-network-connectivity-mac-osx/)
- **mitmproxy** — scripted HTTP fault injection (corrupt bytes, stall,
  truncate) for the update download path specifically.

Concrete programme in section (C).

---

## (B) Gap list vs the SPEC design

### ADOPT-NOW (cheap, high value)

1. **Post-update health gate with automatic revert** (the Mender commit
   pattern; the single biggest gap). Today: `--version` is checked pre-swap,
   but a new daemon that starts and then cannot connect/register strands the
   host until a human runs the curl. Fix inside the existing design: when the
   swap happens, write `spawnd.updating` (attempt count + old tree) beside the
   binary. On startup, if the marker exists, the daemon is in *probation*: it
   must reach `Registered` within a deadline (5 min). On success → delete
   marker and `.prev` (move the spec's ".prev deleted at next startup" to
   "deleted at next successful **register**"). On failure — probation deadline
   hit, or startup crash so launchd restarts it and it finds the marker with
   attempts ≥ 2 — rename `.prev` back over both binaries and exec the old
   spawnd, then report `update_result ok:false stage:health` on the next
   connect so the server marks `failed` and never re-pushes that tree. Covers
   crash-loops, TLS/DNS regressions, and glibc-passes-`--version`-but-panics
   cases. (Mender: update persists only after the daemon reports in;
   [docs](https://docs.mender.io/overview/customize-the-update-process).)

2. **Sign the release manifest with one pinned Ed25519 key.** Every surveyed
   peer verifies updates against a key pinned in the client (Sparkle,
   Syncthing, Tailscale distsign, Tauri, Orbit/Kolide, Omaha via CUP); ours is
   the only design where control-plane compromise = fleet compromise. Minimal
   version: deploy-prod.sh signs the manifest JSON (canonicalised) on the Mac;
   the public key is a const in the daemon; the daemon verifies before
   trusting any sha256; `spawnd update` and the frame path share the check.
   The daemon already has Ed25519 verify machinery for signed signalling.
   Document key custody + a key-loss plan (new key shipped in an update signed
   by the old key). (Sparkle/Syncthing/distsign links in A2.)

3. **Downgrade monotonicity guard.** Include a strictly-increasing release
   counter (or commit timestamp) in the (signed) manifest; the daemon refuses
   an update older than itself unless the frame carries an explicit
   `allow_downgrade` the operator set. Stops rollback-by-stale-server and
   accidental downgrades after a botched deploy; this is TUF's rollback
   protection at 1% of the cost. ([TUF security model](https://theupdateframework.io/docs/security/))

4. **Worker/daemon pair cross-check at startup** (local mix-and-match guard).
   On start, spawnd runs `spawn-worker --version` (or compares embedded tree
   stamps) and reports a mismatched pair as `self_update_blocked:
   "worker_mismatch"`-class state instead of spawning sessions against a wrong
   worker. Cheap, and closes the half-swap window the two-rename design has.

5. **Full-jitter backoff** in the new shared `backoffDelay()` (web ts, mobile
   ts, daemon rs): `random(0, min(cap, base·2^n))` instead of ±25 %. Same
   effort, canonical behaviour. ([AWS](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/))

6. **Daemon outbound data-channel chunking + max-message-size respect.**
   Clients already chunk input at 16 KiB; the daemon's PTY output/file frames
   need the same cap (honour peer SDP `max-message-size`, never exceed 16 KiB
   per message for portability) — oversize outbound is a documented
   channel-killer and a live ErrChunk suspect. ([Grahl](https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html))

7. **Document the OTA kill switch** in docs/RELEASE.md: `eas update:rollback`
   / `eas update:revert-update-rollout`, plus the note that expo-updates
   auto-recovers a crashing update via emergency launch — operator knowledge
   that costs a paragraph. ([EAS rollouts](https://docs.expo.dev/eas-update/rollouts/))

8. **Updater fault-injection tests** (section C, items 1–3): the stage-by-
   stage failure tests and the bad-binary probation test are cheap once the
   health gate exists, and they are the tests that catch the only truly
   dangerous class (updater bricks daemon).

### ADOPT-LATER (valuable, real cost)

9. **Expo `fingerprint` runtimeVersion policy.** Kills both appVersion failure
   modes (orphaned installs after a store-version bump with no native change —
   which our tree-hash watcher would surface as a *false* App Store dialog —
   and forgotten bumps on native change). Cost: fingerprint determinism across
   EAS build and `eas update`, `.fingerprintignore` curation, and re-testing
   the release-watcher's runtime comparison. Do it as its own change, not
   inside this branch. ([Runtime versions](https://docs.expo.dev/eas-update/runtime-versions/))

10. **`turns:` on TCP/443 for browsers/phones.** Real unlock for corporate
    networks; needs a hostname + cert and a second IP (or SNI router) because
    coturn can't share nginx's 443. Daemon side unaffected (webrtc-rs UDP-only
    TURN — already in the spec). ([BigBlueButton](https://docs.bigbluebutton.org/administration/turn-server/), [coturn #1626](https://github.com/coturn/coturn/issues/1626))

11. **Staged rollout / activity awareness for daemon updates.** Tailscale-style
    percentage waves and busy-host deferral matter from ~dozens of hosts up;
    at today's fleet size auto-update-at-register with natural reconnect
    spread is fine. Revisit alongside item 12. ([Tailscale](https://tailscale.com/blog/auto-update-ga))

12. **A declared compatibility window** ("server supports daemon protocol
    N-1 for one release") replacing tree-equality *urgency* — tree hash keeps
    identifying, but only protocol breaks force. This is the k8s-style answer
    when deploy tempo or fleet size makes every-deploy-churn hurt; it also
    dissolves the thundering-herd cliff. ([k8s skew policy](https://kubernetes.io/releases/version-skew-policy/))

13. **Update library (N retained versions)** à la Kolide instead of single
    `.prev`, if update frequency ever makes two-generation fallback too thin.
    ([1Password agent](https://1password.com/blog/how-the-1password-device-trust-agent-autoupdates))

14. **WebTransport signalling / MASQUE relay** — horizon watch only; note in
    docs/NETWORK.md. (Links in A5.)

### REJECT (doesn't fit)

15. **Full TUF.** Four roles, key ceremonies, expiring metadata that takes the
    fleet's update path down when it lapses — designed for vendors shipping
    agents into third-party fleets (Orbit, Kolide, PyPI). Pinned-key signing
    (#2) + monotonicity (#3) capture the dominant threats at ~5 % of the cost.
16. **Sigstore/cosign for daemon updates.** Keyless + transparency logs solve
    public-OSS trust bootstrapping; they add online dependencies (Fulcio,
    Rekor) to a private fleet's update path for no threat-model gain over a
    pinned key. Fine later for public GitHub release artifacts as a courtesy.
17. **CUP-style request signing.** Solves Google's "TLS may be MITM'd by
    enterprise middleboxes and we still must update Chrome" problem; we
    control both ends and both trust anchors.
18. **Omaha-style delta/differential updates.** Binary is small, fleet tiny;
    complexity with no payoff.
19. **Perfect negotiation wholesale.** Fixed offerer/answerer roles + signed
    envelopes make polite/impolite machinery dead weight; the ICE-restart
    subset is already specified.
20. **Squirrel/Electron-style "platform code signing is the verification".**
    spawnd isn't notarized/signed per-platform today and runs headless on
    Linux too; a pinned application-layer key (#2) is the portable equivalent.

---

## (C) Recommended local test programme (this Mac)

Everything below is runnable locally; the pieces marked (CI) also fit
`scripts/test-all.sh` gating.

### 1. Updater end-to-end harness (CI) — `scripts/test-update-e2e.sh`

Sandbox: scratch dir with a "v-old" and "v-new" build of spawnd+spawn-worker
(two builds of HEAD with different `SPAWND_DAEMON_TREE` env stamps is enough —
identity is the env stamp, not real history). Local server run with a
prebuilt manifest pointing at v-new.

1. Start server; start v-old daemon; assert register shows old tree and
   server auto-sends `daemon.update`.
2. Assert: download → verify → swap → exec; same PID after exec; re-register
   within deadline with new tree; `.prev` present until register, gone after;
   `update_state` cleared.
3. **Session survival**: open a PTY session before the update, assert bytes
   flow after re-register without a client reconnect (the worker-adoption
   claim, proven, not assumed).
4. Idempotence: second `daemon.update` for the same tree → no-op result.

### 2. Stage-by-stage fault injection (CI)

Point the daemon's download path through a fault proxy and assert each
`update_result.stage` lands and the old binary keeps running:

- **toxiproxy** in front of the server port:
  `toxiproxy-cli toxic add -t timeout -a timeout=0 spawn-api` (hang →
  stage `download`); `-t limit_data -a bytes=100000` (truncate → sha256
  mismatch → stage `verify`); `-t latency -a latency=8000` (slow → overall
  5-min budget behaviour); `-t bandwidth -a rate=16` (trickle).
- **mitmproxy** script that flips one byte of the binary body → stage
  `verify` (proves hash checking, and later, signature checking).
- Read-only install dir → stage `precondition`/`swap` (`unwritable`).
- Binary whose `--version` exits 1 / prints wrong version / sleeps 20 s →
  stage `verify`, old binary intact.

### 3. Bad-binary probation test (the health gate, once built) (CI)

Manifest points at a spawnd that passes `--version` but exits 1 on real
startup (a tiny wrapper script in the test). Assert: swap happens, exec
happens, probation marker found on restart, revert to `.prev`, old daemon
registers, server shows `failed` with `stage: health`, and no auto-re-push
for that tree.

### 4. Version-skew matrix (weekly / pre-release, not per-commit)

Cells worth having (contract-testing scoping — one release window):

| | old server | new server |
|---|---|---|
| old daemon | (CI already) | register + PTY smoke + auto-update path |
| new daemon | register + PTY smoke (downgrade guard fires, no update loop) | (CI already) |

Build "old" from the last deployed tag in a git worktree
(`git worktree add /tmp/spawn-old <tag>`); run each cross cell with the e2e
harness's register+session smoke. Add the same two cells for web-tab (old
bundle against new server: 4003 path shows the hard dialog, not a spin) using
the existing e2e mocks.

### 5. Connection chaos drills (manual, scripted where possible)

- **Half-open daemon**: `kill -STOP <spawnd pid>`; assert server marks host
  offline within one keepalive window (the derived-status rule) and browsers
  show it; `kill -CONT` → recovers without supersession storm.
- **Server vanish**: `kill -9` uvicorn mid-session; assert daemon keeps PTY
  peers (orphan grace), browser keeps its channel, both re-register/rebind on
  server return — the Addendum's acceptance test, executed.
- **WS cut without process death**: `sudo pfctl` anchor rule blocking the
  server port for 30 s → watchdog fires, reconnect + `rtc.resume`, no terminal
  reload.
- **UDP kill (relay + failure paths)**: NLC "100% Loss" is too blunt; use a
  pfctl `block drop proto udp` rule scoped to the daemon's pinned ephemeral
  range (50000–50100 — the spec's range makes this targetable) to force TURN;
  block UDP to the TURN host too and assert the daemon's clean failure +
  logged warning (it cannot TURN-TCP).
- **Lossy path**: Network Link Conditioner "Very Bad Network" while a PTY
  streams `yes`; assert pacing + `pty_gap` behaviour instead of channel death.
- **Sleep/wake + network flip**: close lid 2 min / toggle Wi-Fi → assert ICE
  restart path (not full rebuild) reconnects within the 10-s restart budget.

### 6. What "A/B" means for one developer

Not statistics — **interleaved cohorts as a canary**: two hosts (this Mac via
launchd + one Linux VM), `settings.daemon_auto_update` on for one, off for the
other (the setting is already the cohort switch). Deploy; compare the
updated host's `update_result` stages, time-to-register, and reconnect
log-classes against the held-back host before flipping it. On mobile, EAS
`--rollout-percentage 10` against your own devices plus
`eas update:revert-update-rollout` is the same drill.
([toxiproxy](https://github.com/Shopify/toxiproxy) ·
[NLC/dummynet](https://spin.atomicobject.com/simulating-poor-network-connectivity-mac-osx/) ·
[EAS rollouts](https://docs.expo.dev/eas-update/rollouts/))
