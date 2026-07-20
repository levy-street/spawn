# spawn — trust architecture

This document defines spawn's trust model and the migration from a
server-centric data plane to an **operator model**: the control plane
negotiates identity, authorization, and connections, but is structurally
unable to read the content that flows between a user and their machines.

It is the governing document for the data-plane redesign. Where DESIGN.md
and this document disagree, this document describes the target and
DESIGN.md describes the mechanics.

## The principle

> The only parties that handle protected content are the host daemon, the
> user's browser(s), and — when NAT requires it — a TURN relay that
> carries ciphertext it cannot decrypt. The server introduces the
> parties; it never sees the conversation.

"Protected content" in this document means: PTY input/output,
scrollback/history, terminal snapshots and viewport controls; agent and host
file names and contents; directory paths, entry sizes/mtimes, and operation
errors; uploads, downloads, and cross-host transfers; tool check/install
commands, executable paths, installed/latest versions, stdout/stderr, and
detailed errors; agent and preset environment values; launch working
directories/arguments; skill bodies; MCP credentials; and any label or error
string derived from those values. Everything on that list either already has an
end-to-end path today or gets one in a migration phase below.

The precise claim we are building toward is **"the server cannot see your
protected content"** (cryptographic), not merely **"the server does not look"**
(policy). We do not use the unqualified phrase "cannot see your data," because
the control plane deliberately retains the metadata disclosed below. Each phase
states which guarantee it delivers.

## Roles

| Party | Holds | Sees |
|-------|-------|------|
| **Host endpoint** (`spawnd` + workers) | session workers, PTYs, encrypted bounded replay state, host identity key | everything on its own host (it is the user's machine) |
| **Browser client(s)** | rendered terminal, device identity key | protected content for hosts and agents it connects to |
| **TURN relay** | nothing durable | ciphertext, peer IPs, traffic volume/timing |
| **Control plane** (`spawn-server`) | accounts, host/agent registry, public keys, signaling | disclosed metadata only, including coarse activity and unattended-update state; it also observes endpoint connection and traffic timing (see "What the server still sees") |

## Why the cryptography already works in our favor

WebRTC DataChannels are encrypted with DTLS negotiated **between the two
peers**. The keys live at the endpoints; a TURN server allocated for the
session relays opaque ciphertext by design. So adding TURN for
reachability does not weaken the model at all — the fallback ladder

```
direct P2P  →  STUN-assisted P2P  →  TURN relay
```

preserves end-to-end confidentiality at every rung. The parts that do
not come for free:

1. **Signaling integrity.** DTLS authenticates the peers against
   certificate fingerprints exchanged in the SDP — which today flows
   through the server as `rtc.offer` / `rtc.answer` frames. A malicious
   control plane could substitute fingerprints and man-in-the-middle a
   session. Fixing this requires endpoint identity keys that sign the
   SDP (Phase 3).
2. **Historical relay data and the remaining content surfaces.** The reviewed
   P2-AGENT-02/P2-TERM-02 cut at `5722288` removes `spawn.v1`, daemon WS PTY
   binary frames, transcripts, content pubsub, snapshots/history, and viewport
   routes. The reviewed P2-HOST-02 cut at `4e7c89b` removes host filesystem
   operations. P2-TERM-01 is independently reviewed and merged at `5d99ebb4`;
   current source has no server-visible agent-upload path. Tool operations,
   launch manifests, skill bodies, detailed errors, coordinated deployment,
   and historical purge remain tracked in the Phase 2 ledger. P2-HOST-03A and
   P2-DATA-01 remain independent-review candidates, not accepted behavior.
3. **Client code delivery.** See "Residual risks" — end-to-end
   encryption where one endpoint is JavaScript served by the operator is
   only as trustworthy as the code delivery.

## Threat model

Adversaries and what they get, once the migration is complete:

| Adversary | Can | Cannot |
|-----------|-----|--------|
| **Curious/compelled control-plane operator** | see account + host/agent metadata, presence, connection/signaling timing and volume, user-input/meaningful-output times, and unattended-update metadata; refuse service; delete accounts | read PTY data, transcripts, host or agent file data, viewport controls, tool details, env vars, skill bodies, MCP credentials |
| **Malicious control-plane operator** (or compromised server) | everything above; record DTLS/TURN traffic; alter signaling or operator-hosted client code; attempt key-substitution MITM at pairing or signaling time | passively decrypt recorded DTLS traffic when the negotiated suite provides forward secrecy and endpoint/session keys remain uncompromised; obtain the endpoint-local protected-store keys from server persistence. Phase 3 makes signaling substitution detectable only to trusted/verifiable endpoint code; it does not constrain hostile hosted JavaScript |
| **Network attacker (on-path)** | observe/black-hole encrypted flows, learn peer IPs | read or modify session content (DTLS), impersonate either peer |
| **TURN operator** | observe ciphertext volume/timing and peer IPs | decrypt anything |
| **Malicious co-tenant** | attack the API surface | reach another user's daemons or agents (all REST + WS paths filter by `owner_user_id`; daemon tokens are host-scoped) |
| **Attacker with the user's browser device** | full access as that user | — out of scope; this is device security |
| **Compromised host daemon** | everything on that host | other hosts' sessions (per-host tokens and keys) |

Past-session confidentiality is not based on ciphertext being absent. A control
plane, TURN operator, or network observer can record ephemeral-session DTLS
ciphertext. Its resistance to later decryption depends on the negotiated cipher
suite's forward-secrecy properties and on endpoint/session key material not
being compromised. Phase 2 does not add a durable server-side ciphertext
archive: restart manifests, preset operational values, and skill bodies are
canonical on the host endpoint under `docs/DURABLE_SENSITIVE_DATA.md`, while
the live worker replay remains separately bounded and ephemeral-keyed. A later
optional opaque backup would need its own reviewed key/recovery threat model.

Explicitly **in scope**: protecting user content from spawn's own
infrastructure and anyone who compromises or compels it.

Explicitly **out of scope**: a compromised endpoint (browser device or
host), traffic analysis (the control plane and TURN necessarily learn
who talked to which host and when), and availability (the operator can
always refuse service).

## What the server keeps or historically held

Honest inventory, from the current wire protocol:

**Metadata the server keeps seeing by design** — accounts and password hashes;
host names/OS/arch/version/last-seen; explicit or neutral agent names and
lifecycle status; preset and skill names/descriptions; exit codes; presence;
connection and signaling timing; IP addresses; and per-agent timestamps for
meaningful output and user input. For unattended tool updates it may also keep
the enabled policy, host/preset identifiers, check/update/result timestamps,
and content-free success/failure/exit-code status. The proposed endpoint-local
durable store does not expose its object sizes, revisions, or store-access log
to the server, although signaling/TURN and metadata API traffic still disclose
connection timing and approximate transfer volume. Activity frames
contain no terminal bytes and are throttled, but their timing is behavioral
metadata and can reveal when a person or agent is active. Self-hosting is the
answer for users for whom this metadata is itself sensitive.

**Protected-content migration inventory:**

| Content class | Current or historical path | Migration state |
|---------------|----------------------------|-----------------|
| PTY bytes (retired live relay) | former binary frames on `/ws/browser`, `/ws/daemon` | removed in P2-AGENT-02/P2-TERM-02, reviewed and merged at `5722288`; deployment/purge pending |
| Transcripts (~64 MB/agent historically on server disk) | retired `transcript.py`; historical files/Redis/backups may remain | code path deleted; bounded endpoint replay; historical copies still require P2-PURGE-01 |
| History replay | former `{"type":"history"}` on `/ws/browser` | removed from server; `spawn.ctl` endpoint stream |
| Agent file uploads | retired `upload`/`agent.upload` frames and REST `bytes_b64`; historical logs/backups may remain | bounded, hash-checked per-agent `spawn.ctl` file stream reviewed and merged in P2-TERM-01 at `5d99ebb4`; deployment/purge pending |
| Terminal snapshots / card previews | retired `agent.snapshot` frames | removed from server; rendered from endpoint replay/output |
| REST terminal input and snapshots | retired `/api/agents/{id}/input`, `/snapshot` | removed; browser uses `spawn.pty` / `spawn.ctl` directly |
| Terminal geometry and viewport actions | retired REST/WS resize/scroll/redraw/display-control paths | removed from server; per-agent `spawn.ctl` only |
| Agent `env` (may contain real secrets) | current master: `agent.create`, persisted in `agents.env` | DATA-02 target: E2E and endpoint-local only; not implemented |
| Preset environment templates | current master: `presets.env_template`, merged into agent `env` | DATA-02 proposed target: canonical in a per-host endpoint store; review pending and not implemented |
| Launch paths/arguments and preset commands | current master: `agents.cwd`/`argv`, `presets.default_argv`/`install`, `agent.create` | DATA-02 target: canonical per-host launch manifest over `spawn.host.ctl`; not implemented |
| Default agent names derived from `cwd` | current master: `_default_agent_name` copies the cwd basename into `agents.name` | DATA-02 target: explicit/neutral metadata and scrubbed legacy names; not implemented |
| Skill bodies | current master: `agent.create`, `skills` table | DATA-02 target: endpoint-local and E2E only; not implemented |
| ~~MCP server registry (headers incl. bearer tokens), `/mcp` endpoint~~ | — | **removed entirely, 2026-07-09** — see below |
| Host paths, directory entry names/sizes/mtimes, reads, writes, and detailed operation errors | former REST host-file routes plus `host.fs.*` frames | removed in reviewed/merged P2-HOST-02 at `4e7c89b`; current source uses `spawn.host.ctl` only |
| Cross-host file transfer | former server source-read/forward path | removed in reviewed/merged P2-HOST-02 at `4e7c89b`; current source is browser-mediated across two host channels |
| Tool check/install commands, paths, installed/latest versions, output, and detailed errors | current master: `host.tools.*`; policy errors can persist in Postgres | P2-HOST-03A E2E candidate implemented, independent review pending; legacy server route remains until HOST-03B |
| Free-form daemon errors | current master: `Outbound::Error.message` and other detailed status strings are forwarded and logged by `ws/daemon.py` | P2-ERROR-01 target: stable content-free server code plus E2E detail; not implemented |

Preset names, skill names/descriptions, and explicitly chosen or neutral agent
names remain server-visible metadata; users must not place secrets in those
labels. The current default agent name is not valid metadata because it embeds
the `cwd` basename. `cwd`/`argv` and any derived label are protected content:
they move E2E with the rest of the launch manifest in Phase 2, and existing
derived names are scrubbed before their source columns disappear.

## Identity and pairing

The device-code flow now binds the host and approving browser keys described
below. Browser identity registration and bounded first-contact pins are Phase 3
foundations; live signaling remains unsigned at L0 until the separately gated
signed-WebSocket and TOFU integration is implemented and reviewed:

- **Host identity**: `spawnd login` generates an Ed25519 keypair, stored
  beside the daemon token in the OS keyring (or the existing mode-0600 Unix
  headless fallback). It is preserved across retries/re-login and removed only
  by the existing explicit `spawnd logout` credential reset. The public key is
  submitted with `device/start` and shown (as a short fingerprint) on the
  `/device` approval page. Before showing the user code, the daemon signs the
  exact fresh device-code/approval-nonce ceremony challenge; browser review,
  approval, and token issue remain unavailable until the server verifies that
  proof against the submitted host key. Same-owner re-login reuses the pinned
  Host; host deletion revokes its token authority and removes the server-side
  Host/browser pins while retaining the original account's key claim. It does
  not silently erase a daemon-local browser pin. Private key material never
  enters a request, log, or status/API response.
- **Browser device identity**: on first login, the browser generates a
  non-extractable WebCrypto keypair (IndexedDB). The public key is
  registered with the account.
- **Signed signaling target (not live yet)**: after P3-IDENTITY-02 is
  implemented and independently reviewed, every `rtc.offer` / `rtc.answer`
  will carry a signature by the sender's identity key over an unambiguous,
  versioned canonical transcript: `(protocol_version, session_id, scope_type,
  scope_id, sender_role, peer_identity_public_key, SDP)`. `scope_type` will be
  `agent` or `host`, and `scope_id` the corresponding agent or host UUID; the
  role will distinguish browser from daemon. Binding all of these fields is
  intended to prevent a valid offer or answer from being replayed across
  sessions, agents, hosts, protocol versions, roles, or intended peers. Each
  ingress must verify through the live adapter against an independently pinned
  expected peer key before L1 can be claimed. Only then will the DTLS
  fingerprints inside the signed SDP inherit endpoint identity and server
  transcript changes be detectable, **provided the endpoint verifier and its
  delivered build are themselves trusted/verifiable**.
- **Assurance levels** (mirror how Tailscale layers tailnet lock):
  - **L0 (today)** — trust the server for introductions. No content
    visibility once Phases 1–2 land, but a malicious server could MITM
    at session setup.
  - **L1 (Phase 3)** — signed signaling + TOFU pinning. For a trusted or
    independently verifiable endpoint build, server key substitution is
    detectable except at first contact. Operator-hosted, unverified JavaScript
    does not receive this assurance from protocol signatures alone.
  - **L2 (later)** — out-of-band verification UX (compare fingerprint
    shown by `spawnd status` with the web UI) and/or a key-transparency
    log, closing the first-contact gap.

Key rotation and revocation ride the existing host revocation path
(`DELETE /api/hosts/{id}`): revoking a host drops its live token authority,
server Host/browser pins, and all older device-code ceremonies. It deliberately
retains the stable Ed25519 key's original account ownership claim, so deletion
cannot become an implicit cross-account key transfer; only the original account
may intentionally re-pair that key. Browsers refuse sessions with unpinned keys
at L1+.

## ADR: how a new device bootstraps trust

**Status:** accepted 2026-07-20. Supersedes the implicit decision that the
`spawnd login` terminal ceremony is the only root of trust — which was never
argued for, it was simply the first thing built.

### The constraint

Exactly one combination is impossible, and it is impossible for an
information-theoretic reason rather than an engineering one:

> a brand-new device holding nothing but an account session, with no other
> paired device present and no secret the operator carries, **and** a server
> that cannot machine-in-the-middle it.

If everything a device holds came from the server, the only party it can
authenticate is the server. Every workable design therefore has to introduce
exactly one piece of truth the server did not supply.

The mistake to avoid is conflating two different jobs. OAuth authenticates the
*operator to the server*. Something else must authenticate the *server's claims
to the operator*. Once those are separate, "any device" and "untrusted server"
stop being in tension.

### Options considered

1. **Terminal ceremony** (what existed). The operator reads the host
   fingerprint off the host's own terminal. Unforgeable, and unusable as the
   only path: onboarding a phone requires a shell on the host.
2. **Device endorsement.** An already-trusted browser signs a statement
   vouching for a new browser's key, which the daemon verifies against a key it
   already trusts. No terminal — but useless on a fresh device when no paired
   device is to hand.
3. **Operator-held secret unlocking a trust bundle.** Host public keys and an
   account-level signing key are encrypted client-side and stored as ciphertext
   the server cannot read. Any device, no terminal, no second device.
4. **Trust on first use.** Accept first contact, refuse loudly on any later
   substitution. Cheap, and what the gate already does for unpinned hosts.

### Decision

**Passkey PRF as the primary path, endorsement as the fallback, TOFU as the
default underneath.**

The WebAuthn `prf` extension derives a stable symmetric secret from a passkey,
which unlocks the trust bundle of option 3. Passkeys already sync across an
operator's devices, so this yields "sign in on a new phone and it just works"
without the server ever being able to forge a host key. It trusts the platform
passkey sync provider, but explicitly *not* the spawn server, which is the
threat this document exists to address.

Endorsement covers devices where PRF is unavailable and the loss-of-passkey
recovery path. Both paths write the same origin-scoped pin store the signed-RTC
gate already reads, so the gate itself does not change.

TOFU remains the behaviour for an unpinned host, because refusing every
un-bootstrapped device would make the product unusable long before the above
exists.

### Consequence for enforcement

`SPAWND_REQUIRE_SIGNED_RTC` must stay **off** until this ADR is implemented.
Enforcement removes the unpinned fallback, at which point "cryptographically
protected" and "able to connect at all" collapse into the same condition — and
with only the terminal ceremony available, every new device would need a shell
on the host first. Enforcement is gated on device bootstrapping, not merely on
HTTPS.

### What this does not fix

The server ships the client. Perfect key distribution to a browser whose code
the server controls is partly ceremonial: a hostile server can serve a client
that skips the checks entirely. This work is still the prerequisite for a
verifiable client and already defeats network attackers and any server
unwilling to tamper with code delivery — but browser-in-a-tab cannot reach the
full claim on its own. See the client verifiability note below.

## ADR: client verifiability

**Status:** accepted 2026-07-20.

A reproducible build plus an in-repo verifier (`scripts/verify-served-client.sh`)
lets anyone rebuild the client from a commit and compare it against what a
target server actually serves.

Stated honestly: **this detects broad tampering and cannot prevent targeted
tampering.** A hostile server can serve a clean bundle to a verifier and a
backdoored one to a single session keyed on cookie, IP, or user-agent. The
value is that it forces attacks to be targeted to stay hidden, which makes mass
compromise impossible to conceal — not that the tab becomes trustworthy.

Closing the remainder needs an append-only transparency log of signed build
manifests, so that serving a malicious build requires either publishing it
permanently in public or serving something no verifier can find. An extension
that verifies before execution is the endgame; the log is the high-value step
before it.

Prerequisites, none of which hold yet: `generateBuildId` is unset so every Next
build differs; the toolchain is unpinned (no `engines`, no `.nvmrc`); and build
inputs bake into the bundle (`SPAWN_API_PROXY_TARGET`,
`NEXT_PUBLIC_SPAWN_WS_URL`), so they must be declared publicly or honest builds
will not match.

## Feature relocation map

What moves where, and the regressions we accept:

- **Scrollback/replay** → endpoint-owned, resource-budgeted worker history
  rather than a new durable transcript archive. Worker replay uses its
  encrypted-at-rest rolling log: the default 8 MiB conservative total charge
  covers exact retained ciphertext/framing, twice the replay representation
  (return plus scratch allowance), and retained log/path bookkeeping. Whole
  oldest segments are deleted before admitting new records; a checkpoint that
  cannot fit by itself is rejected. An admission/checkpoint failure disables
  and destroys replay for that live worker rather than retaining partial or
  over-budget history. The non-persisted key dies with the worker. The browser
  fetches the available tail over the DataChannel at attach. A `spawnd` restart
  can adopt a surviving worker and recover only that retained history; once the
  worker and its history are gone, replay is unavailable. Server
  `transcript.py` and the content pubsub path are deleted; historical Redis,
  files and backups remain subject to the purge runbook.
- **Offline history** → **accepted regression.** The retired server path could
  replay a transcript while the host was asleep; after this cut, daemon
  offline = history unavailable. Mitigation later: optional
  client-side-encrypted transcript backup (browser holds keys, server
  stores ciphertext blobs it cannot read).
- **Live card previews** → rendered client-side from per-host
  DataChannel output. Offline hosts show status metadata only.
- **Resize, scroll, redraw, and display ownership** → per-agent `spawn.ctl`.
  The daemon arbitrates multi-viewer display state; the REST and browser/server
  control-plane paths are removed so dimensions, scroll deltas, and viewport
  event timing do not become operator metadata.
- **Multi-viewer / multi-device** → daemon fans out to N browser peers
  directly. Cost: upstream bandwidth from residential hosts; realistic N
  is small.
- **File upload** → a bounded/chunked/cancellable `spawn.ctl` stream, bound to
  a fresh channel capability and exact agent-backend generation. Stable upload
  UUIDs make bounded retries resumable/idempotent; exact length and SHA-256 are
  checked before an atomic no-clobber commit beneath the worker-retained cwd.
  Paths and detailed results remain endpoint-to-browser only. This also removes
  base64-over-JSON overhead and the server memory spike.
- **Host filesystem operations** → a host-scoped browser↔daemon WebRTC
  connection with a `spawn.host.ctl` DataChannel. It exists independently of
  any agent, because the file browser must work on a host with no running
  agent. The server authorizes the browser for the host and relays only
  signaling/ICE; paths, entry names/sizes/mtimes, file bytes, and operation
  errors stay on the DataChannel. Cross-host transfer is browser-mediated
  between two such channels, so the control plane never buffers the file.
- **Tool installation** → user-initiated requests and stdout/stderr use
  `spawn.host.ctl`. Installer output is not treated as low-sensitivity: it can
  contain paths, commands, versions, and secrets. Unattended update checks may
  report only preset/host identifiers, schedule timestamps, and content-free
  success/failure/exit-code metadata to the control plane; stdout/stderr and
  detailed errors remain daemon-local until an endpoint fetches them E2E.
- **Detailed operational errors** → the server receives only stable codes needed
  for lifecycle metadata. Human-readable spawn, snapshot, upload, filesystem,
  and tool errors travel on `spawn.ctl` or `spawn.host.ctl`; the server neither
  forwards nor logs them.
- **REST terminal surfaces** → removed once direct replacements ship. Terminal
  input uses `spawn.pty`; history/snapshot uses per-agent `spawn.ctl`. The
  server cannot implement a content-returning compatibility REST proxy without
  violating the model.
- **Launch manifests, preset environment values, and skill bodies** → delivered
  over `spawn.host.ctl` and retained in a per-host endpoint-local canonical
  store. The store/key/recovery/conflict/migration decision is normative in
  `docs/DURABLE_SENSITIVE_DATA.md`. The browser copies values directly between
  online hosts; the server is not a sync queue. The migration must establish
  and restart-test a working endpoint copy before clearing the current
  plaintext database fields.
  Default agent names become neutral and ID-based unless the user supplies an
  explicit metadata label; cwd-derived legacy names are scrubbed.
- **The spawn MCP surface** — *resolved: cut entirely (2026-07-09).* The
  `/mcp` endpoint sent terminal input and captured snapshots *through
  the server* by design, the managed MCP-server registry stored bearer
  tokens in server Postgres, and the OAuth 2.1 authorization server
  existed only to authenticate remote MCP clients. All three were
  removed (endpoint, registry + grants + their tables, OAuth AS +
  well-known metadata) rather than kept as an exception that falsifies
  the headline claim. Skills remain: their bodies are the only
  content-adjacent payload left in `agent.create`, tracked in the table
  above. If spawn-as-MCP-tool ever returns, it must terminate E2E on
  the daemon/client side.
- **Notifications** (future) → opaque "activity on agent X" signals or
  client-decryptable payloads only.

## Residual risks

Stated plainly, because a trust document that hides its weaknesses is
worthless:

1. **Web client delivery.** The hosted PWA is JavaScript served by the
   same operator the model distrusts; a hostile operator could ship
   exfiltrating JS or disable signature/pinning checks before connecting.
   Consequently, Phase 3's hostile-signaling-server guarantee applies only
   when the endpoint code is independently trusted or verifiable; an
   operator-hosted unverified web client remains an operator-trust endpoint.
   Mitigations, in increasing strength: open source +
   self-hosting (threat collapses to "trust your own machines"),
   reproducible web builds + signed releases, subresource integrity, and
   eventually a packaged client (PWA store build / Tauri) whose update
   channel is independently signed.
2. **First-contact key substitution** until L2 verification lands.
3. **Metadata.** The control plane necessarily learns who owns which hosts,
   when they connect, coarse meaningful-output/user-input times, and the
   unattended-update metadata listed above. The proposed endpoint-local store
   avoids durable server-side object/version/access metadata, but its E2E
   transfers still reveal timing and approximate volume. TURN learns IP pairs
   and volumes. We do not claim metadata privacy; self-host if that matters.
4. **Endpoint durable-store keys.** Confidentiality and availability depend on
   the per-host key, recovery export, rotation, and destruction design in
   `DURABLE_SENSITIVE_DATA.md`. Key compromise can expose retained local
   versions; key loss without an export makes them unrecoverable. A fallback
   key file stored beside the database does not protect a stolen full-disk
   image. Rotation does not erase old ciphertext unless old wrappers, backups,
   and keys are also destroyed.
5. **Endpoint compromise** is out of scope and undiminished: an agent
   with your credentials running on your machine is exactly as dangerous
   as it is without spawn.

## Open source

Open-sourcing is what makes the architecture *verifiable* rather than
merely asserted, and self-hosting is the strongest mitigation for both
residual risks 1 and 3. Checklist before the repo flips public:

- [ ] **License**: Apache-2.0 recommended (adoption-maximizing; the moat
      is the hosted service's convenience, not the code). AGPL is the
      alternative if preventing third-party commercial hosting matters
      more than adoption.
- [ ] **Git history secret scan** (the history contains deploy-era
      commits) — `gitleaks`/`trufflehog` over full history; rewrite or
      rotate anything found. Rotate all prod credentials regardless.
- [ ] `SECURITY.md` with a disclosure policy; this file as the threat
      model.
- [ ] **Reproducible daemon builds** + checksums, so the binary served
      by `/install.sh` is verifiable against source. Same for the web
      bundle (risk 1).
- [ ] Self-host guide: compose file for the full stack including
      optional coturn; document `SPAWN_WEBRTC_ICE_SERVERS`.
- [ ] CI runs `scripts/test-all.sh` publicly.

Note the honesty limit: open source proves what the code *can* do, not
what spawnd.dev *is running*. Only self-hosting or verifiable client
builds close that gap — say so in the README rather than implying
otherwise.

## Migration phases

Each phase ships independently; the product works throughout.

### Phase 1 — TURN + WebRTC as the only terminal path

*Delivered originally as a browser-side policy claim; the P2-AGENT-02
implementation now also removes the daemon mirror and transcripts, pending
review/merge/deploy/purge.*

*Status 2026-07-10: shipped for spawn.v2 clients.* coturn (already on the
prod box) now runs `use-auth-secret`; the server mints ephemeral HMAC
credentials per session (`turn.py`) instead of shipping a static TURN
password to every browser. The browser WS negotiates `spawn.v2`: the
server never sends binary PTY frames to v2 browsers (no pubsub pump) and
closes with code 4002 if one arrives; the web client is DataChannel-only for
live PTY. At the P2-AGENT-02 implementation checkpoint, `spawn.v1`, daemon
`0x01`/`0x02`, and server transcripts are removed; both `spawn.pty` and
`spawn.ctl` are mandatory and old protocols fail closed.

- Stand up coturn; control plane mints ephemeral HMAC TURN credentials
  per session (time-limited, per RFC 5766 REST-API convention) and
  delivers them in the existing `rtc.config` / `rtc.offer.ice_servers`
  fields.
- Treat DataChannel failure as a reconnect-and-retry, not a downgrade:
  remove browser-bound binary PTY frames from `/ws/browser` and
  daemon-bound `0x02` input frames from `/ws/daemon`.
- Keep `/ws/*` as control + signaling only. Bump subprotocol to
  browser `spawn.v2` and daemon `spawn.control.v2`; no content-compatible v1
  rollout window remains.
- Acceptance: no v2 browser uses a plaintext server relay in either direction
  (assert browser binary input is a protocol error and no v2 pubsub pump is
  started); sessions survive on TURN-only networks (test with UDP blocked).

### Phase 2 — endpoint-owned data, server data stores deleted

*Delivers: no plaintext protected-content path or recoverable plaintext store
on the control plane. Signaling remains vulnerable to active MITM until Phase
3.*

- Add per-agent `spawn.ctl` beside `spawn.pty` for history, snapshots, viewport
  controls/display ownership, agent uploads, and detailed agent errors. The
  P2-AGENT-02 checkpoint completes the terminal mirror/history/viewport cut;
  the independently reviewed P2-TERM-01 cut merged at `5d99ebb4` completes the
  agent-upload transport cut, while detailed errors remain a later task.
- Add a separate host-scoped WebRTC session and `spawn.host.ctl` DataChannel
  for directory listings, host file read/write/transfer, tool installer output,
  and launch manifests. A per-agent channel is insufficient because these
  operations exist without a running agent.
- Use the existing bounded endpoint replay source instead of adding a new
  durable transcript archive: the worker's encrypted rolling scrollback (8 MiB
  conservative total resource charge by default, whole oldest segments
  removed before new admission, key held only by the live worker). Browser
  requests the retained tail over
  `spawn.ctl`; daemon restart/adoption, rotation/retention boundaries, and loss
  after worker exit are acceptance-tested and disclosed.
- Delete `server/spawn_server/transcript.py`, the content Redis pubsub path, and
  all `agent.snapshot`/`upload`/`host.fs.*`/installer-output forwarding. Purge
  historical Redis ring keys. Remove the content-bearing REST/WS terminal,
  viewport/display-control, host-file, and free-form error forwarding/logging
  paths.
- Move `env`, `Preset.env_template`, `Preset.install`, `cwd`, `argv`, skill
  bodies, and detailed launch errors out of server-readable persistence and
  transport into the proposed per-host store in
  `DURABLE_SENSITIVE_DATA.md`. REST creates only the metadata row and a neutral
  default name; the launch manifest travels E2E over the host channel. Scrub
  cwd-derived legacy names. (The `/mcp` question is already resolved: the whole
  MCP surface was cut on 2026-07-09.)
- After all replacement paths are live and compatibility traffic is disabled,
  execute and verify the plaintext purge for transcript files, database rows,
  cwd-derived labels, legacy Redis ring keys, process memory/queues/swap/core,
  logs/observability, temporary exports, and every retained backup or deployment
  snapshot. Do not claim Phase 2 complete while any recoverable plaintext copy
  remains. See `docs/TRUST_PHASE2.md` for the staged purge.
- Acceptance: a route/frame inventory and tests show that no server code path
  can receive or return the protected-content classes listed above; a
  server-process memory inspection sees only signaling and disclosed metadata;
  primary disk, database, Redis, process memory, swap, core dumps, logs,
  observability systems, backups, and snapshots contain no recoverable
  plaintext protected content. Historical stores are checked independently of
  code grep. The detailed task gates live in
  `docs/TRUST_PHASE2_TASKS.md`.

### Phase 3 — endpoint identity and signed signaling (L1)

- P3-IDENTITY-01A (canonical crypto) and P3-IDENTITY-01B (host key pairing)
  are active, independently gated foundations that may overlap remaining Phase
  2 cleanup. They do not make the signed-signaling claim below; integration has
  its own task, tests, independent review, and merge gate.
- Ed25519 host keys minted at `spawnd login`, registered through the
  device-code flow; WebCrypto device keys per browser.
- Successful device login locally retains the approving browser's strict
  device/key/fingerprint tuple in the protected daemon credential record (32
  pins maximum). Status shows device IDs and fingerprints, never browser keys
  or credential secrets.
- Pin trust is asymmetric by design, and this reverses an earlier decision that
  local pins are immutable against the server. Additions still require the
  browser's `SPAWN-HOST-PAIR-APPROVE-V1` proof plus the operator's out-of-band
  fingerprint comparison; the server cannot create trust. Removals are taken
  from the server: registration carries the authoritative live pin set and the
  daemon retains only what is still listed. The earlier rule — that server
  revocation could not silently remove a local pin — meant a revoked browser
  device kept working against the daemon indefinitely, because the daemon
  learned its pins once at pairing and there is no credential-reload endpoint.
  Accepting server-driven removal grants the server no power it lacked, since
  it can already deny service by refusing to relay, and it closes a stale-trust
  hole that had no other mitigation. A server naming an unknown device creates
  no trust for it, and an absent field drops nothing.
- The browser's approval proof is retained in the credential record as evidence
  rather than reduced to a stored verdict, and is re-verified against the host
  key on every load. Verification defeats replay and cross-host, cross-account
  and cross-ceremony reuse. It cannot by itself defeat a hostile server, since
  the transcript commits to the signer's own key and a substituted keypair
  yields a self-consistent proof — which is why `spawnd login` prints the
  browser fingerprint for the operator to compare against the one the `/device`
  page shows. That comparison is the only check a hostile server cannot pass.
- Keyring and fallback copies use a shared whole-record commit identity. Loads
  select one complete `(generation, record ID)` and never combine its token,
  host identity/server metadata, or browser pins with another generation.
  The Unix mode-0600 record is independently complete and is the commit point;
  keyring read/write failure automatically uses that complete file without a
  disable flag. Native platforms keep
  the private seed in the complete keyring record and treat the file as only a
  matching seed-free metadata projection.
- Keyring accounts are scoped to the SHA-256 identity of the canonical config
  directory, so separate `SPAWN_CONFIG_DIR` trees cannot inherit or delete one
  another's host/browser trust. Linux's native backend is kernel keyutils.
  Only the exact default directory may perform a conflict-checked one-time
  migration from the pre-scoping global account.
- Credential mutations use an exclusive cross-process lock and reread both
  durable copies inside it. The pre-ceremony base record must still match
  before either backend is written, so a delayed login cannot regress a newer
  generation or discard another login's immutable browser pin. The lock is
  released before any interactive device approval wait. A nonempty pin set is
  bound to canonical server origin plus Host ID; relogin across either domain
  fails before writing and requires explicit `spawnd logout` or a separate
  `SPAWN_CONFIG_DIR`.
- Signed `rtc.offer`/`rtc.answer` over the canonical SDP, session, agent-or-host
  scope, protocol version, sender role, and intended peer key tuple; TOFU
  pinning; refuse unpinned keys.
- Enforcement is a separate switch from verification, and the claim depends on
  it. The daemon still accepts unsigned offers unless
  `SPAWND_REQUIRE_SIGNED_RTC=1`, so until that is on, the browser-side gate
  protects the operator's browser from being downgraded but does not stop a
  server from omitting the envelope and opening its own unsigned session
  straight to the daemon. Enabling it locks out any origin that is not a secure
  context — plain HTTP by IP has no WebCrypto and can neither hold a pin nor
  sign an offer — so HTTPS everywhere is a prerequisite, not a nicety.
- Fingerprints surfaced in `spawnd status` and the web UI host page.
- Acceptance, using independently trusted/verifiable browser and daemon builds:
  a test-harness server that substitutes an SDP fingerprint or replays a valid
  signature across session, agent, host, scope type, protocol version, role, or
  intended peer makes both endpoints abort loudly for both agent- and
  host-scoped connections. A hostile operator can still replace an unverified
  hosted web client with code that disables verification or exfiltrates content;
  Phase 3 does not claim otherwise.

### Phase 4 — publish

- Open-source checklist above; threat-model doc (this file) finalized;
  reproducible builds wired into CI; spawnd.dev repositioned as the
  hosted convenience instance of an architecture anyone can run.

### Later

- L2 verification UX / key transparency.
- Client-side-encrypted transcript backup (restores offline history
  without restoring server visibility).
- Packaged client builds (risk 1).
- E2E-encrypted WS relay as a last-resort rung for networks where even
  TURN/TCP fails (ciphertext-only through the server, DERP-style) — only
  if real-world failure rates justify it.
