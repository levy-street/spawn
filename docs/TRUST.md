# spawn — trust architecture

This document defines spawn's trust model and the migration from a
server-centric data plane to an **operator model**: the control plane
negotiates identity, authorization, and connections, but is structurally
unable to read the content that flows between a user and their machines.

It is the governing document for the data-plane redesign. UI rules live in
`DESIGN.md`; current product and protocol mechanics live in `README.md`,
`INTERFACE_MATRIX.md`, `SESSIOND.md`, and `proto/README.md`.

## The principle

> The only parties that handle protected content are the host daemon, the
> user's browser(s), and — when NAT requires it — a TURN relay that
> carries ciphertext it cannot decrypt. The server introduces the
> parties; it never sees the conversation.

"Protected content" in this document means: PTY input/output,
scrollback/history, terminal snapshots and viewport controls; session and host
file names and contents; directory paths, entry sizes/mtimes, and operation
errors; uploads, downloads, and cross-host transfers; tool check/install
commands, executable paths, installed/latest versions, stdout/stderr, and
detailed errors; agent-definition command/environment/install values; session
working directories; skill bodies; MCP credentials; and any label or error
string derived from those values. Everything on that list either already has an
end-to-end path today or gets one in a migration phase below.

The current guarantee is narrower than the target: PTY content, replay,
viewport actions, session uploads, and host-file operations have direct
browser↔endpoint paths. Session working directories, agent definitions, skill
bodies, agent availability/install results, and some detailed errors remain
server-readable. Phase 2 is therefore not complete.

The precise claim we are building toward is **"the server cannot see your
protected content"** (cryptographic), not merely **"the server does not look"**
(policy). We do not use the unqualified phrase "cannot see your data," because
the control plane deliberately retains the metadata disclosed below. Each phase
states which guarantee it delivers.

## Roles

| Party | Holds | Sees |
|-------|-------|------|
| **Host endpoint** (`spawnd` + workers) | session workers, PTYs, encrypted bounded replay state, host identity key | everything on its own host (it is the user's machine) |
| **Browser client(s)** | rendered terminal, device identity key | protected content for hosts and sessions it connects to |
| **TURN relay** | nothing durable | ciphertext, peer IPs, traffic volume/timing |
| **Control plane** (`spawn-server`) | accounts; host, session, workspace, agent-definition and skill records; public keys; signaling | the disclosed metadata and remaining server-readable values inventoried below; it also observes endpoint connection and traffic timing |

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

1. **Signaling integrity.** DTLS authenticates the peers against certificate
   fingerprints exchanged in the SDP. Current signed RTC envelopes bind that
   SDP to endpoint identity keys and the exact session/host scope; `spawnd`
   refuses unsigned offers by default. This is meaningful only when endpoint
   code and its expected peer pins are trusted. First contact and a hostile
   operator-supplied web client remain explicit limits.
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

Adversaries and what they get today (the endpoint-local store remains a future
design, not part of these guarantees):

| Adversary | Can | Cannot |
|-----------|-----|--------|
| **Curious/compelled control-plane operator** | see account, host, session, workspace, agent-definition and skill records; presence; foreground executable basenames; connection/signaling timing and volume; activity times; and host-agent check/install data; refuse service; delete accounts | read PTY bytes, worker replay, direct session-upload bytes, or host-file channel contents |
| **Malicious control-plane operator** (or compromised server) | everything above; record DTLS/TURN traffic; alter signaling or operator-hosted client code; attempt key-substitution MITM at pairing or signaling time | passively decrypt recorded DTLS traffic when the negotiated suite provides forward secrecy and endpoint/session keys remain uncompromised. Signed signaling makes substitution detectable only to trusted/verifiable endpoint code; it does not constrain hostile hosted JavaScript |
| **Network attacker (on-path)** | observe/black-hole encrypted flows, learn peer IPs | read or modify session content (DTLS), impersonate either peer |
| **TURN operator** | observe ciphertext volume/timing and peer IPs | decrypt anything |
| **Malicious co-tenant** | attack the API surface | reach another user's daemons or sessions (all REST + WS paths filter by `owner_user_id`; daemon tokens are host-scoped) |
| **Attacker with the user's browser device** | full access as that user | — out of scope; this is device security |
| **Compromised host daemon** | everything on that host | other hosts' sessions (per-host tokens and keys) |

Past-session confidentiality is not based on ciphertext being absent. A control
plane, TURN operator, or network observer can record ephemeral-session DTLS
ciphertext. Its resistance to later decryption depends on the negotiated cipher
suite's forward-secrecy properties and on endpoint/session key material not
being compromised. There is no durable server-side transcript archive; live
worker replay is bounded and ephemeral-keyed. The endpoint-local store in
`docs/DURABLE_SENSITIVE_DATA.md` is a review-pending, unimplemented proposal
whose object model predates the workspace/session overhaul. A later optional
opaque backup would need its own reviewed key/recovery threat model.

Explicitly **in scope**: protecting user content from spawn's own
infrastructure and anyone who compromises or compels it.

Explicitly **out of scope**: a compromised endpoint (browser device or
host), traffic analysis (the control plane and TURN necessarily learn
who talked to which host and when), and availability (the operator can
always refuse service).

## What the server keeps or historically held

Honest inventory, from the current wire protocol:

**Metadata and values the server currently keeps seeing** — accounts and
password hashes; host names/OS/arch/version/last-seen; workspace names,
positions, and layouts; session names, host relationships, working directories,
lifecycle state, exit codes, foreground executable basenames, activity
timestamps, the agent definition a window was opened as, and an opaque
conversation id for that agent (`agent_session_id`, what a restart resumes,
never read by the server). It starts as the id the client handed the agent at
launch. A device types it only when it is a canonical UUID, so a server that
rewrites it cannot make a restart type a flag (`claude --resume
--dangerously-skip-permissions`); a record that is anything else is replaced
by a fresh id the device chose. On a restart a device may replace it with the Claude Code id the
window's host named when asked which conversation the window is actually in
(`conv.inspect`, over the device's host channel): an id the agent chose
itself after `/clear`, `/branch` or `/resume`, or a background job's. Only
that id is written back, with `PATCH /api/sessions/{id}`; the rest of the
answer, and the process tree and live-session registry the host reads for
it, never reach the server, and neither do the agent's own transcript files
the id names, which are located and read only over the device's host channel
(`agent.transcripts` then `fs.read`). Also kept: agent-definition names,
kinds, commands, environment prefixes, and install commands; skill names, descriptions, bodies, defaults, and session
grants; public trust material; connection/signaling timing; and IP addresses.
Host-agent availability flows expose the definition target, installed
path/version data, and errors. Historical install output/errors, policy, and
update timestamps can remain stored. Server-driven installation and agent
auto-update are now disabled; version checks still execute server-selected
binaries. See `DAEMON_COMMAND_AUTHORITY.md` for the remaining command authority.
Since 2026-08-21 the server additionally holds a host's static
hardware spec, a five-level CPU/memory reading refreshed per heartbeat, and a
per-owner daily activity rollup — see "Host capacity" below for why those are
bucketed and coarse rather than exact, and for the switch that turns them off. Activity frames contain no terminal bytes and are throttled, but
their timing is behavioral metadata. Self-host when any of this metadata or
remaining server-readable configuration is itself sensitive.

**Foreground process basename (deliberate content-free exception).** With
shell-first sessions the daemon reports, per session, the basename of the
executable whose process group owns the PTY foreground (`session.foreground`,
stored as `sessions.foreground_command`). This is a knowing, documented
exception to the content-free activity design, scoped as narrowly as it can
be: a bare executable basename, truncated to 64 characters — never arguments,
paths, environment, window titles, or output — emitted only when the value
changes, at most once per second. Its sole purpose is UI labeling: pane
headers and sidebar icons show what is running, and the agent shortcut bar
appears only while the shell itself is in the foreground. The server thereby
learns *which program* is running in a session (e.g. `claude`, `vim`,
`sleep`) and when that changes; users for whom even program names are
sensitive should self-host, exactly as with the activity-timing metadata
above.

The same basename is the only session-derived string on the owner alert
stream (`/ws/alerts`). Detecting "an agent finished" means comparing the
previous foreground basename against the new one at the moment the server
writes it, so the alert reuses a fact the server already holds and already
returns from `GET /api/sessions` rather than disclosing a new one. Alert
payloads carry a session id, an event class, the basename, and an exit
code or signal — never terminal text, and never anything the pane header was
not already showing. Alerts are published on an owner-scoped channel
(`spawn:user:{user_id}:alerts`) under the same host-owner fencing as every
other publish from `/ws/daemon`, so a superseded daemon cannot raise alerts
on a host it no longer owns.

**Protected-content migration inventory:**

| Content class | Current or historical path | Migration state |
|---------------|----------------------------|-----------------|
| PTY bytes (retired live relay) | former binary frames on `/ws/browser`, `/ws/daemon` | removed in P2-AGENT-02/P2-TERM-02, reviewed and merged at `5722288`; deployment/purge pending |
| Transcripts (~64 MB/process historically on server disk) | retired `transcript.py`; historical files/Redis/backups may remain | code path deleted; bounded endpoint replay; historical copies still require P2-PURGE-01 |
| History replay | former `{"type":"history"}` on `/ws/browser` | removed from server; `spawn.ctl` endpoint stream |
| Session file uploads | retired process-upload frames and REST `bytes_b64`; historical logs/backups may remain | bounded, hash-checked per-session `spawn.ctl` file stream; the locked v1 wire retains its historical generation field name |
| Terminal snapshots / card previews | retired process-snapshot frames | removed from server; rendered from endpoint replay/output |
| REST terminal input and snapshots | retired `/api/agents/{id}/input`, `/snapshot` | removed; browser uses `spawn.pty` / `spawn.ctl` directly |
| Terminal geometry and viewport actions | retired REST/WS resize/scroll/redraw/display-control paths | removed from server; per-session `spawn.ctl` only |
| Agent-definition command/env/install/yolo | current: persisted in `agents`; read through `/api/agents`; shortcut command constructed in the browser | endpoint-local replacement is not implemented |
| Which agents an account runs without permission prompts | current: one boolean per (owner, agent) in `agent_preferences`, written through `PATCH /api/agents/{id}/preferences` | the flag is applied browser-side when the command is typed; the server learns the preference but never the launch |
| Session working directory | current: persisted in `sessions.cwd`; carried by `session.create` / `session.restart` | endpoint-local replacement is not implemented |
| Default session names derived from `cwd` | current: `_default_session_name` includes the directory basename | neutral-name/scrub proposal is not implemented |
| Skill bodies | current: persisted in `skills`; carried in `session.create` / `session.restart` | endpoint-local replacement is not implemented |
| ~~MCP server registry (headers incl. bearer tokens), `/mcp` endpoint~~ | — | **removed entirely, 2026-07-09** — see below |
| Host paths, directory entry names/sizes/mtimes, reads, writes, and detailed operation errors | former REST host-file routes plus `host.fs.*` frames | removed in reviewed/merged P2-HOST-02 at `4e7c89b`; current source uses `spawn.host.ctl` only |
| Host file previews (rendered thumbnails, decoded head slices) | current: `spawn.host.ctl` `fs.preview` / `fs.read.range` only | never server-visible; held in memory for the session, never written to disk, never logged |
| Host desktop launches (`desktop.reveal`, `desktop.open`) | current: `spawn.host.ctl` only; the daemon records the operation name locally in `activity.rs` and never the path | never server-visible |
| Cross-host file transfer | former server source-read/forward path | removed in reviewed/merged P2-HOST-02 at `4e7c89b`; current source is browser-mediated across two host channels |
| Agent commands, paths, installed/latest versions, output, and detailed errors | current checks: REST plus `host.agents.check`; install definitions and historical policy/errors remain stored | installation is refused and automation disabled; checks remain server-readable and execute server-selected binaries; endpoint-only replacement is not implemented |
| Free-form daemon errors | current master: `Outbound::Error.message` and other detailed status strings are forwarded and logged by `ws/daemon.py` | P2-ERROR-01 target: stable content-free server code plus E2E detail; not implemented |

### Optional support log sharing

**Only the operator on the server can request a diagnostic log. Sharing starts
off.** The local command records a reason and an operator label. The host
decides whether it can send a bundle. Storage requires a usable private
directory outside the checkout, configured with `SPAWN_SUPPORT_LOG_DIR`.

On a ready server, an owner's app can read the stored choice, the signing
device and time, and each host's last declared capability and last seen time.
The server reports when sharing is off because the signer was removed.
Collection history shows up to 100 requests from the past 365 days, newest
first. Each entry gives the request ID, host, reason, state, any decline
code, size and request, completion, expiry and deletion times. The server
keeps the operator label in its own record. It stores a statement signed by
a current device on that account and relays the choice to capable hosts.
A successful save reports what the server stored.

The server's background pump alone sends statements and collection requests.
Registration sends the ordinary trust data. The pump then sends the current
signed statement or null in a separate `host.support_log_consent` frame before
any collect. A host can skip intermediate choices. About ten seconds is the
idle delay between passes. A pass over many hosts with stalled sockets takes
longer, and shutdown waits for the send or database operation in progress.
The daemon accepts this separate frame. The wire document describes delivery
inside `registered` and should be aligned when the daemon next changes. There
is no receipt confirming that the host applied the change.

If ordinary registration exceeds 65,536 UTF-8 bytes, the released daemon
denies sharing until its process restarts and tries once to erase its saved
statement. The server keeps all trust data and allows a 1,024-byte margin.
Above 64,512 bytes it logs once and sends neither a statement nor a collect for
that connection. Lifting the daemon limit requires a daemon change. The
operator command cannot see that connection's size, so a request can wait and
expire. An oversized statement also waits until the current one fits.

A host can have one open request, with at least five
minutes between dispatches. An account has a limit of ten requests in any 24
hours, and at most ten can be dispatched in that period. Across the server at
most two collections occupy dispatch slots. An upload body still being read
occupies its slot even after its request closes. A request
is sent at most once, even if the connection breaks during that send.

When collection is later enabled, the server stores the **plain log bundle,
not encrypted at rest**, on its disk outside database backups. Only the
operator with access to that server can read the
whole bundle as the machine reported it. The server checks its form and
cannot guarantee what the events contain. Before display, the command
verifies its size, SHA-256 and JSON object framing. Default `show` prints one
object per line with terminal controls escaped. `show --raw` writes the stored
bytes unchanged and refuses a terminal. Metadata commands omit tokens, keys and
signatures. An account-scoped lookup exposes no other account's data.
Bundles expire after seven days and a bounded sweep runs at startup and every
15 minutes, so deletion can follow the expiry time. A signed withdrawal cancels open requests and marks the existing collected
bundles for deletion in the same commit. The orphan sweep removes their files
once the files are more than ten minutes old.
After the account is deleted and the response is sent, a background task tries
to remove its bundles.
A busy or unusable store leaves files for the orphan sweep.
The database retains the current signed statement and collection metadata
(reason, requester, host snapshot, outcome, times, sizes and digest). Collection
records are swept after 365 days; statements have no expiry. A missing file is
reported as missing, never presented as an empty log.
The stored time range and line count are what the machine reported, checked
only for form and framing, not verified against event contents. Each server
process permits one upload per record and four body reads at once; excess
requests receive 409 or 503 before reading, leaving the record untouched.
Each body has a total receive deadline of 60 seconds; expiry returns 408 and
marks the record failed.

The server cannot turn sharing on. It checks statements to keep malformed data
out of storage, but the daemon independently decides whether the owner's
statement and signer are valid. Removing the signing device makes server-side
sharing checks false immediately, without erasing or rewriting the signed row.
The server process is the only writer of sharing statements. The app route
runs in that process. While a statement commit is in progress, an unsent claim
returns to requested for a later pass. If the pump sees a completed statement
change between claim and handoff, it cancels the request. The operator can
request again under the usual pacing limits.
A collect already handed to the socket cannot be recalled.
A collect already claimed can still be sent just after a device removal commits.
The daemon learns of the removal through its ordinary trust update. At the
start of a request it checks its own stored on statement and that it still
admits the signer. One bundle of up to 900 KiB can already be in flight when
sharing is turned off. The upload route refuses it if sharing is off at arrival
and checks sharing again before retaining it.
Durable withdrawal remains a signed off statement, not a missing row or null.

If the trust change reaches the released daemon before a statement signed by
the removed device, it refuses that statement and stops sharing. Turning
sharing on again takes effect only after SPAWN D restarts on that machine.
This can also happen on a fresh connection if the stored turn-off was signed
by a device that has since been removed.

The support log is a separate, bounded local record. It holds event times,
producer builds, levels, source locations, reviewed counters/identifiers/fixed
choices and a small reviewed set of local paths and classified filesystem
errors. Paths can reveal information about the machine's folders. There is no collection path for terminal input/output, terminal history, file
excerpts, command arguments, environment values, credential fields, arbitrary
event messages or third-party message/field content. Construction enforces this: unknown fields are withheld
before formatting; allowed scalar/identity/choice fields have typed rules; path
origins and error callsites are inventoried in a checked-in policy. Sanitizing
is a second, heuristic defense and cannot reliably remove short secrets from an
admitted path. The source guard and canaries cover these boundaries. The
collection reader opens exactly the two versioned support files, never lists a
folder, and never reads ordinary daemon output or terminal storage. A typed
header adds only the documented state counters, classified error kind/time and
parsed build identity; it never adds general state-file text.

Through the support log route, the machine sends either a refusal code that
the server records or a support log bundle that the server checks for size,
digest and line framing and stores as a file without interpreting its events.
`scripts/check-no-server-agent-upload.sh` names it as the single exception to
the rule that keeps agent upload routes off the server.

The owner decides through a statement signed by an approved device. Each host
requires an account proven by its own retained device approvals; a server-named
account never enables support sharing. Unknown account disables sharing until
a device approval establishes it. The same direct-pin/carried-chain admission
rule is used for connections, with an additional attribution check: the signed
device ID must match the pin or verified final approval. Legacy connection
admission and its direct-pin-before-chain-cap order are preserved. Newest time
wins, off wins a tie, and signers use `max(now, current + 1)` within the 24-hour
future bound. Consent has no expiry. Null disables; an identical current valid
statement can clear server-off.

One optional sequential actor owns sharing across control reconnects. Its queue
exists immediately; startup opens no support storage. Dispatch for trust/consent
clones the parsed support payload, advances one generation with a compare-exchange
loop, clears the request-started bit, tries the bounded queue and notifies the
actor. It does no support filesystem or cryptographic work. Queue operations may
allocate and payload destruction may occur. Actual trust changes, failed or
timed-out credential observations, consent, teardown and shutdown advance the
generation; unchanged observations deliver nothing.

The actor takes one input at a time, in arrival order, and finishes it before
taking another. A combined trust/consent update stays one input. Received trust
and revocations are retained before writes. Collection runs inside that same
loop: one preparation job (statement existence, authorization, durable reservation,
snapshot and encoding), one final disk authorization job, atomic start claim,
request selected against generation change, then one final receipt job. During
collection, delivery still advances the generation immediately, while queued
updates wait for collection to finish. Every filesystem job is awaited to
completion or its deadline; healthy work is never abandoned. Lock waits are
bounded at about two seconds. No job queues behind unfinished work. The dedicated
thread is not joined at daemon shutdown. The collector's custom HTTP resolver
runs OS lookup as one job on that same thread, under the collection deadline;
no lookup uses Tokio's blocking pool. An unfinished lookup prevents any later
job, enters terminal denial, and cannot hold runtime shutdown. This client
ignores environment proxies; ordinary daemon HTTP clients are unchanged.

Collection admission is charged at delivery, before enqueueing (one per minute,
burst three). A busy gate or full queue drops/counts a collection and never
triggers overflow denial. At dequeue, an expired usable deadline or stale
generation is dropped/counts without a storage job or POST. Before any other
collection work, absence of the instance's consent file drops/counts the frame:
no write, receipt, DNS lookup, connection or POST. Counts stay in memory for the
current UTC day; a running daemon exposes them through its normal heartbeat and
`spawnd status`. A stopped daemon shows no count.

Any update failure enters terminal `Denied(reason)` for the rest of this process:
storage I/O failure, lock wait expiry, storage job deadline, stopped/panicked
storage worker, the consent write budget, the 256-key support revocation floor,
consent/trust delivery queue overflow or gate contention, invalid support update, or
generation exhaustion (a terminal atomic word prevents any start claim). Collection storage-job deadlines, worker death and receipt
write failures also deny. Later inputs are drained and ignored, and stored consent
is removed once, best-effort; a dead or unfinished worker can prevent that removal.
No collection is admitted in `Denied`. Status gives the reason in plain words and
says restarting SPAWN D on that machine clears the process denial. The normal
heartbeat can be up to 30 seconds old, and storage failure can prevent reporting.

An account whose server delivers more than 256 removed devices cannot share from
that host. Restart does not cure it while that history is redelivered. Connection
revocations remain uncapped, as on master. More than 30 sharing changes in ten
minutes pauses sharing on that host until restart; ordinary toggles across devices
can reach this budget. Unchanged effective state skips writes, including a
comparison of the carried approvals: a refreshed approval path is persisted.

Successful persistence survives restart; terminal process denial and the admission
bucket do not. Removing the statement also removes its timestamp/revocation floor;
failed removal can leave an old on. An honest server must redeliver current consent
after registration and before collection. A dishonest server can withhold withdrawal or
replay an old valid on after state loss. There is no host acknowledgement that it
applied a turn-off; apps must not claim one. Capability, silence and collection
receipts do not provide that confirmation.

A process-wide admission budget allows one request per minute, burst three,
across reconnects. Excess requests are counted and dropped without file work,
receipts or POSTs. Admitted collection has one 30-second deadline including
audit (two seconds reserved for final audit), a five-second connect and
15-second HTTP timeout. One flight, durable limits of one bundle per five
minutes/twelve per day (refusals count), a 60-second to 72-hour window and a 900 KiB NDJSON
body cap (header included) bound disclosure. All support filesystem/encoding work
runs serially on one bounded, dedicated thread. Every job is awaited to completion or its three-second deadline (final audit
uses the remaining collection deadline); nothing queues behind unfinished work. A stalled thread cannot hold daemon shutdown. HTTPS uses the configured origin and path prefix, the daemon token,
no redirects/retries, and only 2xx succeeds. Body provenance is guarded by typed
construction, source markers and canaries; the guard is not a proof.

Request start means the single atomic compare-exchange from
`(collection generation, not started)` to `(collection generation, started)`,
after the final disk authorization job returns and immediately before `send()`
is created and polled. Generation and started bit occupy one atomic word.
Delivery before this transition makes the claim fail: no request is created,
and the receipt is `cancelled`. Delivery after it abandons the request best-effort.

A collection may begin sending only if, immediately before the request is
started, the statement stored on this host is valid, enabled, not switched off,
and its signer is still admitted, as read from disk by this process. A change
this process receives before the request has been started prevents it. Once the
request has been started it is abandoned on a best-effort basis when a later
change arrives, but its body (one bundle, at most 900 KiB) may still be delivered,
and it ends within the 15-second request timeout in any case. A change written
by another process of the same instance is seen at the next authorisation read.
Cancellation attempts a typed `cancelled` receipt and never promises that no
bytes were sent. The server can ask before relaying off; transport buffering
cannot strengthen that ordering guarantee.

Collector construction starts no storage job; inputs are processed lazily as
they arrive. Logout (both variants), reset and exorcise retain master's
ordinary error behavior and cleanup order; support failure adds a warning only.
Without a proven account no consent statement is stored or honoured; lock,
receipt and revocation files may still exist. Status explains unavailable account
proof, terminal denial reasons and admission drops using the normal heartbeat
(up to 30 seconds old; storage failure may prevent reporting), alongside bounded
local receipts. No receipt proves server retention. A dishonest server can
collect within the limits while sharing is on, withhold removals/withdrawal, or
omit a request from its future history. A maliciously delivered app or web client
could sign without the person's action; trusted client delivery remains required.

### Host capacity (2026-08-21)

Showing a fleet means showing how hard each machine is working, and utilization
is a far more sensitive signal than it first looks. A per-second CPU/memory
trace of somebody's machines is a behavioural fingerprint: when they work, when
they sleep, when a build runs, when the GPU rig is training, when they went on
holiday. Putting that on the control plane would be a real regression against
the principle this document opens with, and it would be one bought for a
progress bar.

So capacity is split by resolution, and the split is enforced by which
transport carries it.

**The server is given a bucket.** `host.heartbeat` may carry `cpu_bucket` and
`mem_bucket`: a meter segment count in `0..=5`, once every thirty seconds. That
is enough to draw the sidebar's capacity meter and to sort a fleet by which
machine is pinned, and it is close to useless as a trace — five levels at
2 samples/minute cannot distinguish a compile from a video call. `register`
additionally carries a static spec (cores, memory, CPU model, GPU name), which
is inert: it describes hardware, it does not change while the daemon runs, and
it is the figure the product actually wants to show off.

**The browser is given the truth.** Exact CPU percentage, memory bytes, load
average and uptime are served by `host.metrics` on the `spawn.host.ctl`
DataChannel — browser to daemon, at whatever rate the browser is drawing at,
with no server code path in between. This is the same posture as `fs.read`:
precision lives on the connection the control plane cannot read.

**And a host can decline both.** `SPAWND_NO_TELEMETRY=1` stops the daemon
reporting capacity anywhere: no spec on `register`, no buckets on the
heartbeat, and `host.metrics` never advertised in the channel's `hello`. That
last part matters — an opted-out host is indistinguishable from a daemon too
old to have the operation, so opting out is not itself a signal. It follows the
shape of the existing `SPAWND_NO_CPU_SCOPES` switch: one variable, checked
once, no partial modes.

Two consequences worth stating plainly rather than leaving to be found. The
buckets are *new metadata the server did not previously hold* — small, coarse,
and rate-limited, but new, and the inventory above is updated accordingly. And
the daily activity rollup (`legion_days`) that backs the profile is likewise
new server-side retention: per-owner, per-UTC-day counters — sessions started,
seconds run, peak concurrent sessions and online hosts, and a bounded tally of
the already-disclosed `session.foreground` basenames. It holds no per-session
rows, nothing that outlives its day bucket in identifiable form, and no paths,
arguments, or terminal bytes. It exists because sessions are hard-deleted with
their workspace, so anything computed from the `sessions` table would show a
person's history shrinking as they tidy up.

### Host previews and desktop launches

The preview and desktop operations added alongside the file viewer do not
change what the control plane can see: rendered pixels and file slices travel
the same encrypted DataChannel that already carried `fs.read`, and signaling
stays signaling. Three things about the *host's* exposure do change, and are
recorded here rather than left to be discovered.

**The daemon now spawns GUI-session processes on behalf of a remote request.**
This is not a new privilege for an authenticated browser — it can already open a
PTY session and type `open ~/anything`, and the daemon already spawns login
shells and install commands. But it is a new *surface*, in three ways. It is
reachable without creating a session, so it leaves no `sessions` row and no
visible pane; the daemon therefore records each launch locally by operation name
only, never by path. It shortens the exploit chain from "drive an interactive
shell" to "send one frame", which matters because the same channel offers
`fs.write.begin`: write-then-open would be a code-execution primitive if the
gates on `desktop.open` (regular files only, magic-sniffed allowlist, no execute
bit, no executable magic, explicit refusal of URL-indirection types, and a rate
limit) were ever relaxed. And it runs third-party native code — QuickLook
generators are arbitrary binaries parsing untrusted documents — which is why
they are executed out of process via `qlmanage` rather than in-process through
the framework, so a crash costs one failed preview rather than the daemon that
holds the host's identity key. `scripts/check-host-desktop-launch.sh` pins these
properties in the source.

**Ambient authority is now consumed at exactly two roots, not one.** The
previous invariant — consumed once, for the home directory — is restated rather
than quietly broken: it is consumed at startup for the user's home directory
(client-reachable and client-named) and for a daemon-private preview staging
directory (never client-reachable, never client-named, and never containing a
client-supplied path component). Request-time operations continue to resolve
only through held handles. A renderer needs a real path, and the only safe way
to give it one is to hard-link the already-validated inode under a name the
daemon chose and then verify the link points at that same inode; reconstructing
a path from components would hand another process a string the kernel never
resolved through our handles.

Workspace, session, agent-definition, and skill names remain server-visible;
users must not place secrets in labels. A default session name includes the
working-directory basename, and `sessions.cwd` is server-readable today. The
endpoint-local proposal must be redesigned for shell sessions before either
can move out of the control plane.

## Identity and pairing

The device-code flow binds the host and approving browser keys described below.
Live session- and host-scoped signaling supports signed envelopes, and the
daemon refuses unsigned offers by default. The guarantee still depends on a
trusted/verifiable endpoint build and locally established expected-peer pins:

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
  Host/browser pins while retaining the original account's key claim. Private
  key material never enters a request, log, or status/API response.
- **Browser device identity**: on first login, the browser generates a
  non-extractable WebCrypto keypair (IndexedDB). The public key is
  registered with the account.
- **Signed signaling**: a signed `rtc.offer` / `rtc.answer` carries a signature
  by the sender's identity key over an unambiguous,
  versioned canonical transcript: `(protocol_version, session_id, scope_type,
  scope_id, sender_role, peer_identity_public_key, SDP)`. `scope_type` is
  `session` or `host`, and `scope_id` is the corresponding session or host UUID; the
  role will distinguish browser from daemon. Binding all of these fields is
  intended to prevent a valid offer or answer from being replayed across
  RTC generations, sessions, hosts, protocol versions, roles, or intended peers. Each
  ingress must verify through the live adapter against an independently pinned
  expected peer key before L1 can be claimed. Only then do the DTLS
  fingerprints inside the signed SDP inherit endpoint identity and server
  transcript changes be detectable, **provided the endpoint verifier and its
  delivered build are themselves trusted/verifiable**.
- **Assurance levels** (mirror how Tailscale layers tailnet lock):
  - **L0 (explicit compatibility opt-out)** — unsigned signaling is possible
    only when daemon enforcement is explicitly disabled; it trusts the server
    for introductions.
  - **L1 (current signed mode)** — signed signaling + pinning. For a trusted or
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

> **Update 2026-08-20:** the device trust mesh
> ([TRUST_DEVICE_MESH.md](./TRUST_DEVICE_MESH.md)) supersedes the mechanics
> below in part. "Both required" no longer means two user actions: a passkey
> unlock now *produces* the endorsement automatically (the account root
> endorses the device during the heal), so unlocking the bundle is sufficient
> on its own — the failure mode this ADR observed (a bundle-holding device the
> daemon rejects) can no longer occur on chain-capable hosts. The two-direction
> analysis and the reasons TOFU/enforcement are gated remain correct.

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

**Passkey PRF and endorsement, both required. TOFU as the default underneath.**

Corrected 2026-07-20 after testing on real devices. This ADR originally called
endorsement a *fallback* for platforms lacking PRF. That was wrong, and the
error was structural rather than a detail: trust runs in two directions and only
one of them is a passkey problem.

- **Browser learns the host's key.** The sealed bundle carries it. Passkeys
  solve this, and a second device inherits it with no terminal ceremony.
- **Daemon learns the browser's key.** Nothing in the passkey path carries it,
  and the daemon refuses pin additions on the server's say-so, so the only
  authority it accepts is a signature from a browser key it already pins.

A device that unlocks the bundle but is not endorsed is *worse off than before*:
it now holds a host pin, so it signs its offers, and the daemon rejects every
one. That was observed on a phone — importing the bundle broke a device that had
been working on the unpinned path. Both halves are needed on every platform,
whatever its PRF support.

The WebAuthn `prf` extension derives a stable symmetric secret from a passkey,
which unlocks the trust bundle of option 3. Passkeys already sync across an
operator's devices, so this yields "sign in on a new phone and it just works"
without the server ever being able to forge a host key. It trusts the platform
passkey sync provider, but explicitly *not* the spawn server, which is the
threat this document exists to address.

Endorsement additionally covers devices where PRF is unavailable and the
loss-of-passkey recovery path. The bundle path writes the origin-scoped pin
store the signed-RTC gate already reads, so the gate itself does not change.

Endorsed pins must also be recorded server-side. The daemon's pin set can never
exceed what the server lists, because reconciliation prunes anything absent from
it -- so a pin admitted by endorsement alone is erased on the next connect. The
server row is the mirror; the endorsement signature is the authority. Discovered
by hand-placing a pin and watching reconciliation delete it.

TOFU remains the behaviour for an unpinned host, because refusing every
un-bootstrapped device would make the product unusable long before the above
exists.

### Consequence for enforcement

**RESOLVED (2026-08-06): enforcement is now the default.** Device bootstrapping
shipped — endorsement admits a device without a shell on the host, and
bidirectional approval additionally delivers the host's true key to the new
device, so "cryptographically protected" and "able to connect" no longer
conflict. `SPAWND_REQUIRE_SIGNED_RTC=0` is the explicit opt-out for recovery
scenarios. The original reasoning is kept below for context.

Historically, `SPAWND_REQUIRE_SIGNED_RTC` had to stay **off** until this ADR was
implemented.
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

Status. `generateBuildId` is now pinned, which took the served surface from 28
nondeterministic files to zero **on one machine**, measured across nine builds.
`scripts/verify-served-client.sh` rebuilds and compares that surface.

Cross-machine reproducibility is not yet achieved, and that is the case the
verifier actually needs — a third party rebuilding on their own hardware.
Measured against dev, 25 of 44 served assets matched byte-for-byte; the other 19
differed only in webpack module *order* inside the chunk (same modules, same
byte length, different emission sequence), which changes the content hash and
therefore the filename. The build machines differed in bun (1.3.13 vs 1.3.14),
node (v20.20.2 vs v22.19.0) and CPU count (16 vs 12); any of those can reorder
emission. The toolchain is now declared in `web/package.json`, but declaring is
not enforcing: closing this needs a pinned build environment, i.e. a container,
which is the next step rather than a script change.

Note also that same-machine testing cannot detect this class of problem, and
that the manifest key-order race is flaky — one A/B build pair showed a single
difference where later pairs showed seventeen. Any future claim of
reproducibility needs several builds, on more than one machine, before it means
anything.

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
- **Resize, scroll, redraw, and display ownership** → per-session `spawn.ctl`.
  The daemon arbitrates multi-viewer display state; the REST and browser/server
  control-plane paths are removed so dimensions, scroll deltas, and viewport
  event timing do not become operator metadata.
- **Multi-viewer / multi-device** → one authenticated peer per device and
  daemon, with separate terminal/control attachments for each view. Same-origin
  browser tabs share their device's peer. Different devices retain separate
  connections and take another device's terminal control only by an
  explicit take — sent when a person opens the session, or chooses
  **Take control** — never on reconnect. Cost: upstream output fanout; realistic N is small.
- **File upload** → a bounded/chunked/cancellable `spawn.ctl` stream, bound to
  a fresh channel capability and exact session-worker generation. Stable upload
  UUIDs make bounded retries resumable/idempotent; exact length and SHA-256 are
  checked before an atomic no-clobber commit beneath the worker-retained cwd.
  Paths and detailed results remain endpoint-to-browser only. This also removes
  base64-over-JSON overhead and the server memory spike.
- **Host filesystem operations** → consumer channels on the shared signed
  host-v2 device connection (`spawn.host.ctl/<consumer UUID>`). The connection
  exists independently of any session, so files work with no terminal open.
  Legacy clients can still use the host-v1 connection. The server authorizes the browser for the host and relays only
  signaling/ICE; paths, entry names/sizes/mtimes, file bytes, and operation
  errors stay on the DataChannel. Cross-host transfer is browser-mediated
  between two such channels, so the control plane never buffers the file.
- **Agent-definition checks** → use REST plus `host.agents.check`; targets,
  versions, and detailed errors can reach the control plane. **Installation**
  is refused by the daemon, and server-driven agent auto-update is disabled.
  Moving checks, installation, and durable policy targets to endpoint authority
  remains Phase 2 work; see `DAEMON_COMMAND_AUTHORITY.md`.
- **Detailed operational errors** → upload and filesystem detail stays on
  `spawn.ctl` / `spawn.host.ctl`, but free-form daemon errors and host-agent
  check/install results still have server-readable paths. P2-ERROR-01 and the
  host-agent cut remain incomplete.
- **REST terminal surfaces** → removed once direct replacements ship. Terminal
  input uses `spawn.pty`; history/snapshot uses per-session `spawn.ctl`. The
  server cannot implement a content-returning compatibility REST proxy without
  violating the model.
- **Session launch configuration, agent-definition values, and skill bodies**
  → still use server-readable database/API/control-frame paths. The proposed
  endpoint-local store in `docs/DURABLE_SENSITIVE_DATA.md` was not implemented
  and predates shell-first sessions; it requires a new mapping before runtime
  work. No endpoint-store guarantee is claimed here.
- **The spawn MCP surface** — *resolved: cut entirely (2026-07-09).* The
  `/mcp` endpoint sent terminal input and captured snapshots *through
  the server* by design, the managed MCP-server registry stored bearer
  tokens in server Postgres, and the OAuth 2.1 authorization server
  existed only to authenticate remote MCP clients. All three were
  removed (endpoint, registry + grants + their tables, OAuth AS +
  well-known metadata) rather than kept as an exception that falsifies
  the headline claim. Skills remain: their bodies are carried in
  `session.create` / `session.restart`, tracked in the table
  above. If spawn-as-MCP-tool ever returns, it must terminate E2E on
  the daemon/client side.
- **Notifications** (future) → opaque "activity on session X" signals or
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
3. **Metadata and remaining server-readable configuration.** The control plane
   learns the inventory above, including session directories, agent-definition
   values, skill bodies, foreground basenames, and host-agent results. TURN
   learns IP pairs and volumes. We do not claim metadata privacy or Phase 2
   completion; self-host if that matters.
4. **Proposed endpoint durable-store keys.** If the unimplemented
   `DURABLE_SENSITIVE_DATA.md` design is revived, its key loss, recovery,
   rotation, full-disk compromise, and old-ciphertext destruction risks still
   need implementation evidence after the object model is redesigned.
5. **Endpoint compromise** is out of scope and undiminished: a CLI agent
   with your credentials running inside a session shell is exactly as dangerous
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

> **Historical plan:** this section records the staged trust work in its
> original vocabulary. Its v2 subprotocol names and old process/definition
> terms describe completed checkpoints, not the current interface. The live
> browser and daemon control subprotocols are `spawn.v3` and
> `spawn.control.v3`; current lifecycle frames are `session.*`. See
> `INTERFACE_MATRIX.md` and `proto/README.md`.

Each phase was designed to ship independently while the product kept working.

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
  it. The daemon refuses unsigned offers by default since 2026-08-06; with the
  explicit opt-out `SPAWND_REQUIRE_SIGNED_RTC=0` the browser-side gate
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

## Bidirectional device approval (2026-08-06)

> **Update 2026-08-20:** superseded for chain-capable hosts by the device
> trust mesh ([TRUST_DEVICE_MESH.md](./TRUST_DEVICE_MESH.md)): device
> admission is account-scoped (one SAS ceremony, every host) and the per-host
> endorsement below is refused by such hosts (mesh R9), surviving only as the
> root anchor-upgrade statement and for legacy hosts. The introduction
> mechanism below remains the no-passkey path for host-key delivery on legacy
> fleets (mesh R7 covers its future).

Endorsement admits a new browser to a host: a trusted browser signs a
transcript covering (account, host key, endorser key, endorsed key, endorsed
device id), and the daemon verifies that signature against browser keys it
already pins. That direction was always sound, but it was one-directional —
the *daemon* learned to trust the new device, while the new device still had
to take the host's key from the server on first contact (signed TOFU).

The fix needed no new cryptography, only delivery: **the endorsement
transcript already covers the host public key**, so a device holding a
verified endorsement holds a host-key introduction signed by a device the
operator trusts.

- `GET /api/trust/endorsements?endorsed_device_id=…` returns the endorsements
  naming a device, with the host key, the endorser key, and the signature.
  Every field is server-claimed and untrusted as served.
- The endorsed browser re-encodes the transcript from those claims plus its
  **own** key and device id, and verifies the signature locally
  (`web/src/lib/endorsement-introduction.ts`). Substituting the host key, the
  endorser key, the account, or the endorsed device changes the transcript,
  and the server cannot re-sign it — it holds no endorser private key.
- The operator then confirms the **endorser's** fingerprint on the new
  device's screen — the same comparison the endorsing browser made in the
  other direction, which is what makes the ceremony bidirectional. This closes
  the residual gap where a hostile server offers an endorsement from a key the
  operator never approved.
- Accepted introductions become ordinary local host pins, so the connection is
  `verified` rather than `first contact`, and later key substitution is
  refused exactly as for a hand-paired host.

The connection chip now distinguishes the three states — verified (pin
matched), first contact (signed TOFU), unverified (raw) — so this difference
is visible rather than implied.
