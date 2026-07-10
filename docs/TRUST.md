# spawn — trust architecture

This document defines spawn's trust model and the migration from a
server-centric data plane to an **operator model**: the control plane
negotiates identity, authorization, and connections, but is structurally
unable to read the content that flows between a user and their machines.

It is the governing document for the data-plane redesign. Where DESIGN.md
and this document disagree, this document describes the target and
DESIGN.md describes the mechanics.

## The principle

> The only parties that handle terminal data are the host daemon, the
> user's browser(s), and — when NAT requires it — a TURN relay that
> carries ciphertext it cannot decrypt. The server introduces the
> parties; it never sees the conversation.

"Terminal data" means: PTY input/output, scrollback/history, file
uploads, snapshots, directory listings, agent environment variables,
skill contents, and MCP credentials. Everything on that list either
already has an end-to-end path today or gets one in a migration phase
below.

The claim we are building toward is **"the server cannot see your
data"** (cryptographic), not merely **"the server does not look"**
(policy). Each phase below states which of the two it delivers.

## Roles

| Party | Holds | Sees |
|-------|-------|------|
| **Host daemon** (`spawnd`) | tmux sessions, PTY, transcripts, host identity key | everything on its own host (it is the user's machine) |
| **Browser client(s)** | rendered terminal, device identity key | everything for agents it attaches to |
| **TURN relay** | nothing durable | ciphertext, peer IPs, traffic volume/timing |
| **Control plane** (`spawn-server`) | accounts, host/agent registry, public keys, signaling | metadata only (see "What the server still sees") |

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
2. **The last-resort relay.** Today, when WebRTC fails, terminal data
   falls back to plaintext binary frames on `/ws/browser` ↔
   `/ws/daemon`, and the server persists them as transcripts. That path
   is the single biggest violation of the principle and is removed in
   Phase 1–2.
3. **Client code delivery.** See "Residual risks" — end-to-end
   encryption where one endpoint is JavaScript served by the operator is
   only as trustworthy as the code delivery.

## Threat model

Adversaries and what they get, once the migration is complete:

| Adversary | Can | Cannot |
|-----------|-----|--------|
| **Curious/compelled control-plane operator** | see account + host/agent metadata, presence, connection timing; refuse service; delete accounts | read PTY data, transcripts, uploads, env vars, skill bodies, MCP credentials |
| **Malicious control-plane operator** (or compromised server) | everything above; attempt key-substitution MITM at pairing or signaling time | silently MITM sessions between endpoints that verify identity keys (Phase 3+); recover data from past sessions (no stored ciphertext, DTLS is ephemeral per session) |
| **Network attacker (on-path)** | observe/black-hole encrypted flows, learn peer IPs | read or modify session content (DTLS), impersonate either peer |
| **TURN operator** | observe ciphertext volume/timing and peer IPs | decrypt anything |
| **Malicious co-tenant** | attack the API surface | reach another user's daemons or agents (all REST + WS paths filter by `owner_user_id`; daemon tokens are host-scoped) |
| **Attacker with the user's browser device** | full access as that user | — out of scope; this is device security |
| **Compromised host daemon** | everything on that host | other hosts' sessions (per-host tokens and keys) |

Explicitly **in scope**: protecting user content from spawn's own
infrastructure and anyone who compromises or compels it.

Explicitly **out of scope**: a compromised endpoint (browser device or
host), traffic analysis (the control plane and TURN necessarily learn
who talked to which host and when), and availability (the operator can
always refuse service).

## What the server still sees (and must stop seeing)

Honest inventory, from the current wire protocol:

**Metadata the server keeps seeing by design** — accounts and password
hashes, host names/OS/arch/version/last-seen, agent names and lifecycle
status, exit codes, presence, connection and signaling timing, IP
addresses. Self-hosting is the answer for users for whom this metadata
is itself sensitive.

**Content the server sees today and must stop seeing:**

| Today | Where it leaks | Target |
|-------|----------------|--------|
| PTY bytes (fallback relay) | binary frames on `/ws/browser`, `/ws/daemon` | DataChannel only; relay path deleted |
| Transcripts (~64 MB/agent on server disk) | `transcript.py`, Redis ring buffer | daemon-owned; fetched over DataChannel |
| History replay | `{"type":"history"}` on `/ws/browser` | DataChannel history stream |
| File uploads | `upload` frames, `bytes_b64` through both WS legs | DataChannel file stream |
| Terminal snapshots / card previews | `agent.snapshot` frames | rendered from DataChannel output |
| Agent `env` (may contain real secrets) | `agent.create`, persisted in `agents.env` | sent E2E at spawn time; never stored server-side |
| Skill bodies | `agent.create`, `skills` table | client-encrypted at rest, decrypted only by daemon |
| ~~MCP server registry (headers incl. bearer tokens), `/mcp` endpoint~~ | — | **removed entirely, 2026-07-09** — see below |
| Directory listings | `host.fs.list_result` | DataChannel control stream |
| Tool install output | `host.tools.install_result` | DataChannel or accepted as low-sensitivity (decide in Phase 2) |

`cwd`/`argv` sit in between: they are content-adjacent metadata the
server currently needs to orchestrate `agent.create`. They move E2E when
agent creation itself moves onto the host control channel (Phase 2+);
until then the docs must not claim otherwise.

## Identity and pairing

The device-code flow is already a pairing ceremony; it just doesn't
exchange keys yet. Target design:

- **Host identity**: `spawnd login` generates an Ed25519 keypair, stored
  beside the daemon token in the OS keyring. The public key is submitted
  with `device/start` and shown (as a short fingerprint) on the
  `/device` approval page, binding it to the user at approval time.
- **Browser device identity**: on first login, the browser generates a
  non-extractable WebCrypto keypair (IndexedDB). The public key is
  registered with the account.
- **Signed signaling**: `rtc.offer` / `rtc.answer` carry a signature by
  the sender's identity key over (SDP ‖ session_id ‖ agent_id ‖ peer
  public key). Each side verifies against keys pinned at pairing, so the
  DTLS fingerprints inside the SDP inherit endpoint identity. The server
  still forwards signaling but can no longer forge it.
- **Assurance levels** (mirror how Tailscale layers tailnet lock):
  - **L0 (today)** — trust the server for introductions. No content
    visibility once Phases 1–2 land, but a malicious server could MITM
    at session setup.
  - **L1 (Phase 3)** — signed signaling + TOFU pinning. Server key
    substitution is detectable except at first contact.
  - **L2 (later)** — out-of-band verification UX (compare fingerprint
    shown by `spawnd status` with the web UI) and/or a key-transparency
    log, closing the first-contact gap.

Key rotation and revocation ride the existing host revocation path
(`DELETE /api/hosts/{id}`): revoking a host drops its token *and* its
pinned key; browsers refuse sessions with unpinned keys at L1+.

## Feature relocation map

What moves where, and the regressions we accept:

- **Scrollback/replay** → daemon-owned. tmux + the daemon-side
  scrollback cache are already the source of truth; the browser fetches
  history over the DataChannel at attach. Server `transcript.py` and the
  Redis ring buffer are deleted.
- **Offline history** → **accepted regression.** Today the server can
  replay a transcript while the host is asleep; in the operator model,
  daemon offline = history unavailable. Mitigation later: optional
  client-side-encrypted transcript backup (browser holds keys, server
  stores ciphertext blobs it cannot read).
- **Live card previews** → rendered client-side from per-host
  DataChannel output. Offline hosts show status metadata only.
- **Multi-viewer / multi-device** → daemon fans out to N browser peers
  directly. Cost: upstream bandwidth from residential hosts; realistic N
  is small.
- **File upload** → DataChannel file stream (also removes today's
  base64-over-JSON overhead and server memory spike).
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
   exfiltrating JS. Mitigations, in increasing strength: open source +
   self-hosting (threat collapses to "trust your own machines"),
   reproducible web builds + signed releases, subresource integrity, and
   eventually a packaged client (PWA store build / Tauri) whose update
   channel is independently signed.
2. **First-contact key substitution** until L2 verification lands.
3. **Metadata.** The control plane necessarily learns who owns which
   hosts and when they talk. TURN learns IP pairs and volumes. We do not
   claim metadata privacy; self-host if that matters.
4. **Endpoint compromise** is out of scope and undiminished: an agent
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

*Delivers: "server does not relay PTY data" (policy claim; transcripts
still server-side).*

*Status 2026-07-10: shipped for spawn.v2 clients.* coturn (already on the
prod box) now runs `use-auth-secret`; the server mints ephemeral HMAC
credentials per session (`turn.py`) instead of shipping a static TURN
password to every browser. The browser WS negotiates `spawn.v2`: the
server never sends binary PTY frames to v2 browsers (no pubsub pump) and
closes with code 4002 if one arrives; the web client is DataChannel-only
for live PTY, queueing input until the channel opens. `spawn.v1` (and the
daemon-bound `0x02` input path only it uses) remains for rollout compat —
retiring it, plus the daemon→server `0x01` output leg that still feeds
server-side transcripts, is Phase 2 work.

- Stand up coturn; control plane mints ephemeral HMAC TURN credentials
  per session (time-limited, per RFC 5766 REST-API convention) and
  delivers them in the existing `rtc.config` / `rtc.offer.ice_servers`
  fields.
- Treat DataChannel failure as a reconnect-and-retry, not a downgrade:
  remove browser-bound binary PTY frames from `/ws/browser` and
  daemon-bound `0x02` input frames from `/ws/daemon`.
- Keep `/ws/*` as control + signaling only. Bump subprotocol to
  `spawn.v2`; support v1 during rollout per proto/README versioning.
- Acceptance: PTY bytes never traverse the server in either direction
  (assert in the broker: any binary frame on v2 is a protocol error);
  sessions survive on TURN-only networks (test with UDP blocked).

### Phase 2 — daemon-owned data, server data stores deleted

*Delivers: "server cannot see terminal content" for all rungs except
signaling MITM.*

- Add multiplexed DataChannel streams beside `spawn.pty`: history
  fetch (replaces the `history` frame), file upload (replaces `upload`
  frames), snapshot, directory listing.
- Daemon persists transcripts locally (rotate like today's server
  files); browser requests tail-on-attach exactly like the current
  `max_bytes` read.
- Delete `server/spawn_server/transcript.py`, the Redis PTY ring
  buffer, and `agent.snapshot`/`upload`/`fs.list` content forwarding.
- Move `env` and skill bodies out of server persistence: sent over the
  host control DataChannel at spawn time. Agent creation becomes: REST
  creates the agent *row* (id, name, host, status); content-bearing
  spawn parameters travel E2E. (The `/mcp` question is already
  resolved: the whole MCP surface was cut on 2026-07-09.)
- Acceptance: `grep` the server for any code path that touches PTY
  bytes, upload bytes, env values, or skill bodies — none exist; a
  compromised server's disk + Redis + memory contain no session content.

### Phase 3 — endpoint identity and signed signaling (L1)

- Ed25519 host keys minted at `spawnd login`, registered through the
  device-code flow; WebCrypto device keys per browser.
- Signed `rtc.offer`/`rtc.answer`; TOFU pinning; refuse unpinned keys.
- Fingerprints surfaced in `spawnd status` and the web UI host page.
- Acceptance: a test-harness server that swaps SDP fingerprints causes
  both endpoints to abort the session loudly.

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
