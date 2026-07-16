# ADR P2-DATA-01 — durable protected data lives on each host endpoint

Status: **proposed for independent review; runtime not implemented**. This ADR
becomes the accepted P2-DATA-01 decision only when this commit passes review and
is merged. It does not approve the P2-DATA-02 migration, remove a server column,
or make a Phase 2 claim. Runtime work still needs its own implementation,
independent review, cutover, and purge evidence.

## Decision

Spawn will use an **endpoint-local canonical store per host** for durable
protected operational data in Phase 2. `spawnd` owns the store and serves it
only over the authenticated, host-scoped `spawn.host.ctl` DataChannel. The
browser may copy values between two online hosts, but the control plane is not a
storage or synchronization participant.

The following values are local to the host that uses them:

| Object | Durable protected value | Server-visible metadata that may remain |
| --- | --- | --- |
| `agent_manifest` | resolved `cwd`, `argv`, `env`, install command, create-cwd policy, and exact skill IDs/revisions needed to launch/restart an agent; retained for an exited/archived agent while it remains restartable | agent ID, host ID, preset ID, explicit or neutral name, lifecycle fields, grant IDs |
| `preset_values` | default argv, environment template, install command, executable/tool target, and endpoint execution policy | preset ID, name, description/agent kind; the unattended enabled flag and content-free timestamps/status allowed by `TRUST.md` |
| `skill_body` | body and body format/version | skill ID, name, description, enabled-by-default flag |

There is no Phase 2 durable PTY transcript or terminal-history object. The
worker's bounded encrypted replay remains a separate live-worker artifact with
an ephemeral key. A later optional transcript backup, if built, requires a new
decision and client-held keys; it must not be smuggled into this store.
Exited/archived launch manifests are the only planned past-session protected
blob and remain solely to preserve explicit restart until their agent is
deleted.

Opaque client-encrypted server blobs are **not selected** for Phase 2. They may
be reconsidered as an optional synchronization/backup layer after endpoint
identity, recovery, and independently trusted client delivery exist. Such a
layer cannot silently replace the endpoint-local canonical copy.

### Consequences we accept

- Protected values cannot be viewed, edited, launched, or restarted through
  Spawn while their host is offline. The server UI may still show disclosed
  metadata and an honest "host unavailable" state; it must not show a cached
  protected value.
- Presets and skills are per-host operational copies. A browser synchronizes a
  selected item only while both source and destination hosts are online, over
  two `spawn.host.ctl` sessions. There is no server queue containing the value.
- Losing a host and all user-created exports loses that host's protected data.
  Account/password recovery does not recover it.
- Different hosts can legitimately have different protected revisions behind
  the same disclosed preset or skill ID. The UI must show endpoint availability
  and conflicts from endpoint responses, not invent last-write-wins behavior.

These regressions are preferable to deploying an unreviewed account-wide key
distribution and recovery system merely to preserve today's centralized
convenience.

## Trust boundaries and authorization

The host operating-system account, `spawnd`, its worker processes, and an
authorized browser are trusted with plaintext. The control plane and TURN
relay are not. The daemon binds every operation to the exact authenticated host
session, account/owner scope, host ID, protocol version, request ID, and object
type/ID. Cross-account, cross-host, cross-session, and wrong-version requests
fail closed.

Phase 2 still trusts server-mediated signaling for the introduction. A malicious
control plane can actively substitute peers until P3-IDENTITY-01 signed
signaling is deployed, and operator-hosted JavaScript remains a trusted content
endpoint unless independently verified. Endpoint-local storage removes server
keys and passive server-readable persistence; it does not overstate those two
known limits.

The server never receives a store root key, object data key, recovery
passphrase, decrypted value, plaintext digest, or detailed store error. It must
not provide a key escrow, password-derived wrapping service, KMS decrypt call,
or plaintext compatibility proxy.

## Store and cryptographic envelope

P2-DATA-02 must implement this logical format. Exact library choices may change
only through a superseding ADR with equivalent tests.

### Files and transactions

- The store lives below the platform state directory, for example
  `$XDG_STATE_HOME/spawn/private/v1/store.sqlite3`, in an ownership-checked
  `0700` directory with `0600` database, WAL, key-file, temporary, and export
  files. Symlinks and wrong-owner paths are rejected.
- SQLite provides atomic compare-and-swap writes. Only already-encrypted
  envelopes, authenticated non-secret metadata, revisions, tombstones, and a
  bounded idempotency journal enter SQLite/WAL. SQLite never receives a
  decrypted JSON/CBOR field.
- The credential record also holds `store_uuid`, the latest committed store
  generation, and an HMAC state tag over the canonical set of object heads,
  envelope hashes, and tombstones. A mutation first commits generation `n` and
  its tag in SQLite, then advances the credential anchor; no later write is
  accepted until the anchor succeeds. On restart, database=anchor is normal;
  database=anchor+1 is accepted only after its tag verifies (crash between the
  two writes) and advances the anchor; database older than the anchor, more
  than one generation ahead, or tag-mismatched fails as `data_rollback`/
  `data_integrity`. This detects a database-only rollback when the credential
  anchor survives without pretending the two stores are transactional.
- Serialization is deterministic canonical CBOR. Limits are checked before
  allocation and again after serialization. Temporary plaintext buffers and
  keys are excluded from core dumps/locked where supported and zeroized on
  every success and error path. This is best-effort process-memory hygiene, not
  a claim that a compromised host cannot read its own data.

### Key hierarchy

1. Each host store has a random 256-bit **store master key** and random
   `store_uuid`. The master key is independent of the account password, daemon
   bearer token, WebRTC identity key, server secrets, and other hosts.
2. The master key is stored in the OS credential store when available. For an
   unattended/headless installation without one, Spawn may use a separately
   created local `0600` key file in the private state directory, but must label
   that protection mode in local diagnostics. This fallback protects the
   control-plane boundary and supports crypto-erasure; it does not protect a
   disk image that contains both the database and key file.
3. Every object revision gets a fresh random 256-bit data-encryption key (DEK)
   and nonce. The canonical plaintext is sealed with XChaCha20-Poly1305. The
   DEK is separately wrapped by the current master-key epoch with
   XChaCha20-Poly1305 and a distinct nonce. Nonces are generated randomly and
   never reused with a key.
4. Independent anchor and idempotency authentication keys are derived from the
   master key with HKDF contexts `spawn/private-store/anchor/v1` and
   `spawn/private-store/idempotency/v1`. They authenticate the store state and
   bounded local retry journal; neither is used as an encryption key.
5. Keys and decrypted objects exist only in daemon memory for the minimum
   operation. Browsers receive plaintext only inside the endpoint-to-endpoint
   DTLS session. Workers receive only the launch/materialization values they
   require over the existing private local worker channel.

The AEAD additional authenticated data is the canonical tuple:

```text
("spawn.private.v1", store_uuid, owner_account_id, host_id,
 object_type, object_id, object_revision, schema_version,
 master_key_epoch, plaintext_length)
```

Changing any binding, revision, schema, or declared length causes decryption to
fail. The outer envelope has an explicit magic, envelope version, algorithm
IDs, key epoch, nonces, ciphertext length, and wrapped-DEK length. Unknown
versions/algorithms are rejected; there is no guess-and-decrypt fallback.

Local at-rest encryption is defense in depth for accidental copies and enables
key destruction. It does not change the declared trust in the user's host.

## Object, conflict, and replay semantics

- IDs are stable UUIDs already disclosed as metadata. IDs are never plaintext
  hashes or deterministic ciphertexts of protected values.
- Each object starts at revision 1 and increments a checked unsigned 64-bit
  revision. Create requires `expected_revision=0`; update/delete requires the
  exact current revision. Exhaustion fails closed.
- There is no timestamp ordering and no last-write-wins. A stale write returns
  an E2E `revision_conflict` with the current revision. The browser must fetch,
  compare, and make the user choose which value to keep.
- A request ID is at least 128 random bits. The daemon durably retains a
  bounded mapping from `(session owner, operation, request_id)` to an
  authenticated request fingerprint and result. An identical retry returns the
  original result; reuse with different bytes returns `request_id_reused`.
  The journal is capped at 4,096 entries and 24 hours, with active launch/write
  requests protected from eviction.
- Delete writes a revisioned tombstone before deleting the wrapped DEK and
  ciphertext. An ID cannot be recreated. Tombstones contain no protected value
  and remain for the life of that store lineage, preventing stale retry/copy
  traffic from resurrecting deleted content. Hitting the tombstone quota blocks
  new IDs until an explicit, user-confirmed lineage compaction; it never evicts
  a tombstone silently.
- A normal import never overwrites a newer revision or crosses a different
  `store_uuid`. Restoring an older whole-store backup is an explicit recovery
  action: the daemon is stopped, the user confirms the rollback, a new
  `store_uuid` and master-key epoch are created, and every imported object gets
  a new lineage/revision. Silent rollback is forbidden.

The endpoint can detect protocol replay, stale writes, database-only rollback
when its credential anchor survives, and ordinary stale imports. A
whole-machine rollback that restores the database and credential store to one
internally consistent older snapshot cannot be distinguished without an
external monotonic anchor. That limitation is disclosed; Spawn does not claim
rollback detection against an attacker who controls the trusted endpoint and
all of its backups.

### Launch resolution

An `agent_manifest` is the exact resolved launch input, not a pointer that asks
the server to resolve protected values later. The endpoint combines the
selected local preset revision with user overrides, stores the resulting
manifest, and launches only after the write commits. Restart uses that stored
manifest. Changing a preset does not silently mutate an existing agent;
"apply preset changes" creates a new manifest revision explicitly.

Skill grants remain disclosed ID relationships. The manifest records the
selected skill IDs and local body revisions. Referenced skill revisions are
immutable and remain encrypted until no manifest references them. Deleting a
referenced skill must either update/delete those manifests first or explicitly
invalidate them and delete every body revision; a later restart then fails
closed. Launch/restart never asks the server for a missing body, substitutes an
empty body, or silently launches a different revision.

Built-in preset operational values ship as a versioned daemon-local catalog.
The control plane can retain their stable IDs/names/kinds but is not their
operational source. A catalog mismatch is reported E2E and requires an endpoint
upgrade or explicit local override.

## Limits, availability, and denial of service

P2-DATA-02 may lower these limits but must not raise them without review:

| Resource | Hard ceiling |
| --- | --- |
| canonical agent/restart manifest | 512 KiB |
| canonical preset/tool value | 128 KiB |
| one canonical skill body | 256 KiB, preserving the current 65,535-character API ceiling at worst-case UTF-8 width |
| live objects per store | 10,000 |
| tombstones per store | 20,000; exceeding the cap blocks new IDs rather than evicting replay protection |
| encrypted database payload | 256 MiB by default; operator may lower it |
| concurrent protected write/import streams | 4 |
| buffered plaintext across all streams | 1 MiB |
| one list page | 256 object heads with a daemon-authenticated cursor; no eager full inventory |
| one operation without progress | 30 seconds |

Length is declared before streaming; chunks, aggregate bytes, and final
SHA-256 are verified inside the E2E channel before encryption/commit. A quota,
timeout, disconnect, cancellation, hash mismatch, or AEAD failure leaves no
partially visible object. Temporary files are bounded, `0600`, and atomically
renamed only after verification. Backpressure pauses reads instead of growing
queues. Repeated quota failures expose only a stable content-free code to the
server and bounded local/E2E detail.

The authenticated user can still exhaust their own host quota or delete their
own data; availability against a malicious authorized endpoint is out of scope.
Cross-account and unauthenticated traffic must consume only small fixed
pre-authentication bounds.

## Recovery, multi-device, backup, and import

There is no account-password or server-mediated key recovery. A password reset
that preserves the account ID does not rotate or recover a host store. Deleting
an account/host registration does not magically erase or unlock the local
store.

The supported recovery artifact is an explicit streamed export created on the
host and delivered to the requesting browser over `spawn.host.ctl`. It contains
the store/object versions, IDs, revisions, tombstones, and protected values in
one authenticated archive encrypted under a user-supplied recovery passphrase.
Version 1 uses Argon2id with a random salt (64 MiB, 3 iterations, parallelism
1) to derive an archive key, then XChaCha20-Poly1305 with a random nonce. An
import rejects different/out-of-range KDF parameters before allocating. The
passphrase and archive key never reach the server and are not retained after
export/import. The clear header contains only magic, format/KDF parameters,
salt, nonce, and ciphertext length. Export/import is size-bounded and streamed;
partial files are deleted. The archive is subject to offline passphrase
guessing, so the UI must offer a generated high-entropy recovery phrase and
warn before accepting a weak user choice; server invisibility is not a claim
that a weak passphrase resists guessing.

Import defaults to preview plus conflict reporting. It never silently merges,
lowers a revision, changes account/host ownership, or resurrects tombstones.
Cross-host or changed-account import may intentionally rebind objects to the
destination under a new lineage and fresh DEKs, but only after explicit user
confirmation. The source archive remains encrypted; deleting it is the user's
responsibility.

Any browser device can operate the store while it has an authorized live host
session; browsers do not need a shared durable data key. A new device therefore
does not require key fan-out, but it gains no offline copy. Browser IndexedDB,
service-worker caches, analytics, and error reports must not persist protected
values. Browser memory is cleared on disconnect/logout on a best-effort basis.

A native host backup containing both the store and local fallback key is
decryptable by whoever can restore that trusted endpoint. A backup containing
only the encrypted database is not recoverable. Operators must choose either a
platform backup that includes credential-store recovery or the explicit
passphrase export and document its retention.

## Rotation, revocation, deletion, and purge

- Routine master-key rotation creates a new epoch and rewraps every live DEK in
  one resumable transaction sequence. The old master key is destroyed only
  after every wrapper has been read back and successfully authenticated under
  the new epoch.
- If the old master key may be compromised, rewrapping is insufficient because
  retained old ciphertext/wrappers remain decryptable. Every object must be
  decrypted, resealed under fresh DEKs, verified, and old database/WAL/backups
  destroyed or allowed to expire before claiming recovery from compromise.
- Revoking the daemon token/host at the server stops future authorized
  connections but cannot prove erasure of an offline endpoint. `spawnd logout`
  preserves the local store by default. An explicit local `--wipe-private-data`
  operation removes the database/WAL/temp files and destroys all master-key
  epochs; remote wipe is best-effort and is never reported complete without an
  endpoint receipt.
- Object deletion commits its tombstone and removes its live wrapped DEK and
  ciphertext. SQLite secure-delete/checkpoint/vacuum are defense in depth, not
  proof against SSD remapping, snapshots, or backups. Cryptographic/physical
  deletion is complete only when every copy containing a usable wrapper and
  master key is destroyed or its documented retention expires.
- P2-PURGE-01 still inventories and destroys the historical server database,
  WAL, logs, observability, Redis, transcripts, snapshots, and backups. The new
  endpoint copy is the intended surviving canonical data, not evidence that an
  old server copy is safe to retain.

## Migration and cutover contract for P2-DATA-02

Migration is per account and host, and has four fail-closed states recorded as
disclosed metadata: `legacy`, `copying`, `endpoint_verified`, `scrubbed`.

1. **Inventory without content.** Record row/object counts and byte totals for
   agent manifests, preset values/tool targets, skill bodies, derived names,
   and detailed tool errors. Flag values above the new per-object limits for
   explicit user remediation/export; never truncate them. Do not record values
   or unkeyed plaintext hashes.
2. **Upgrade and freeze.** Require a P2-DATA-capable daemon/browser. Freeze
   legacy protected-value edits for the account. Old clients receive a stable
   `upgrade_required`; no dual-write or plaintext fallback is allowed.
3. **Copy through a trusted endpoint.** During the bounded migration window,
   the authenticated browser reads the already-server-visible legacy value and
   sends it directly to each selected online host over `spawn.host.ctl`. The
   endpoint validates/canonicalizes, commits it, reads it back, and returns an
   E2E receipt. Verification happens in the browser/endpoint; the server stores
   only counts and state transitions, never a plaintext digest.
4. **Exercise recovery.** Restart `spawnd`, reattach/adopt workers, launch and
   restart representative manifests, edit/use presets, materialize skills, and
   run tool-target checks from the endpoint copy. Missing/offline hosts block
   purge unless the user explicitly retires them or exports/reimports their
   data.
5. **Cut ingress.** Switch create/edit/restart/tool/skill flows to endpoint-only
   operations. Stop cwd-derived names and reject all legacy frames/routes that
   could write or return protected values. Restart/drain server workers as
   required by the P2-PURGE-01 runbook.
6. **Scrub, then drop.** In one staged migration, replace protected fields with
   null/empty compatibility values only after endpoint verification; scrub
   conservatively derived agent names and detailed tool errors; then remove the
   columns/routes in a later irreversible schema step. Record only counts.
7. **Purge history.** P2-PURGE-01 removes all recoverable historical copies and
   verifies the oldest remaining backup. Binary/config rollback may not restore
   a plaintext server store.

If any verification fails, remain frozen or return to `legacy` before scrub.
After `scrubbed`, failure remediation is endpoint restore/import or a corrected
roll-forward—never server plaintext restoration.

## Observability contract

Allowed server logs/metrics: stable operation class, stable content-free result
code, host/agent/preset/skill IDs already disclosed as metadata where needed,
bounded counts, duration, and coarse lifecycle timestamps. Prefer request IDs
hashed with a process-local telemetry key. Do not log protected payload sizes
unless the size class is already explicitly disclosed; this endpoint-local
design does not add server-side object size/version/access metadata.

Daemon logs/metrics must not include plaintext, plaintext digests, ciphertext,
keys, nonces, wrapped keys, passphrases, paths, argv/env, commands, skill text,
or detailed errors. Human-readable detail is bounded and returned E2E. Crash
reporting, tracing spans, panic formatting, core dumps, temporary files, and
allocator reuse are in the P2-ERROR-01/P2-PURGE-01 inspection scope.

The control plane still observes metadata API calls, host signaling, presence,
agent lifecycle, and network traffic timing/volume; a control-plane-operated
TURN relay can infer DataChannel transfer sizes approximately. Endpoint-local
storage avoids the additional durable ciphertext identifier, exact ciphertext
size, key/envelope version, revision count, and create/read/update/delete access
pattern that an opaque server store would have introduced. The server already
knows the stable agent/preset/skill IDs listed as disclosed metadata, but it does
not learn whether a corresponding local envelope exists or its local revision,
length, key epoch, or read log. It does not claim traffic-analysis resistance.

## Compatibility failure behavior

| Failure | Required behavior |
| --- | --- |
| host offline | show metadata-only unavailable state; never return cached protected values |
| old browser/daemon | stable `upgrade_required`; no server plaintext fallback |
| missing root key with an existing store | fail closed with `data_key_unavailable`; never generate a replacement key over existing ciphertext |
| corrupt/tag-invalid object | quarantine ciphertext, return E2E `data_integrity`, do not launch or substitute defaults |
| newer schema/algorithm | refuse writes and request an upgrade; never guess |
| stale revision/replayed request | conflict or idempotent original result as specified above |
| missing preset/skill revision | E2E error and no launch/tool execution |
| quota/timeout/cancel/disconnect | abort atomically, erase temporary plaintext, preserve previous revision |
| endpoint copy unavailable after server scrub | recovery import or explicit reconfiguration; never restore the server field |

Only stable lifecycle/result codes may cross a server-visible path. Paths,
values, conflict detail, and integrity diagnostics stay on the host channel.

## Falsifiable acceptance gates

P2-DATA-02 is not accepted until automated/adversarial tests demonstrate all
of the following. P2-HOST-03B and P2-PURGE-01 then consume the evidence instead
of assuming it.

1. A canary in each of `cwd`, `argv`, `env`, install/default command, tool
   target, and skill body is absent from server HTTP/WS frames, process logs,
   telemetry, database/WAL, Redis, and server crash dumps during create, edit,
   launch, restart, tool, export, import, conflict, and failure flows.
2. With the server and TURN packet capture available to the tester, protected
   values appear only inside endpoint plaintext and DTLS ciphertext. No store
   key/recovery passphrase appears in any server request or response.
3. The daemon restarts offline, opens the same store, adopts live workers, and
   can later restart an agent from the exact committed manifest without a
   protected server read. Removing the key makes the operation fail closed.
4. AEAD mutation, wrong object/host/account binding, truncated stream, unknown
   version, stale expected revision, request replay with changed bytes, and
   partial database rollback all fail without changing the current object.
5. Two browsers racing writes get exactly one commit and one conflict. Two
   online hosts can copy a preset/skill through the browser; an offline
   destination creates no server-held queue. Cross-account and cross-host
   attempts return no object or existence oracle.
6. Quota, concurrency, timeout, cancel, disconnect, and oversized declarations
   keep memory/disk within the stated bounds and leave no readable partial
   value. Previous revisions remain usable after aborted replacement.
7. Export/import uses a wrong-passphrase failure oracle no richer than
   authentication failure, preserves tombstones/conflicts, and requires
   explicit lineage change before rollback or cross-host rebinding.
8. Routine and compromise rotations survive interruption and prove the stated
   distinction between rewrap and full reseal. Wipe makes the store
   unrecoverable without a retained native backup/export and does not claim an
   offline remote wipe succeeded.
9. Migration counts match, endpoint read-back and daemon restart/launch/preset/
   skill/tool exercises pass, old clients are rejected, neutral agent names are
   used, and the legacy fields remain empty after a binary rollback attempt.
10. An inventory guard fails CI if a protected server model/schema/route/frame,
    cwd-derived label, free-form server-visible error, or built-in operational
    preset value is reintroduced after cutover. P2-PURGE-01 separately verifies
    disks, observability, replicas, and the oldest retained backup.

## Rejected alternatives

| Alternative | Why it is rejected |
| --- | --- |
| opaque client-encrypted server store as the Phase 2 canonical store | Requires account-wide device keys, recovery, revocation, rollback and hostile hosted-client answers that do not exist yet; adds durable identifier/size/version/access leakage and server availability dependency |
| browser IndexedDB as canonical storage | Breaks unattended tool policy, daemon restart, non-browser operation, and recovery when that browser is absent; operator-hosted JS is also a known trust endpoint |
| server KMS/envelope encryption or a server-held recovery key | The server can decrypt and therefore the design falsifies the governing claim |
| keys derived from account password, daemon bearer token, host identity key, or object ID | Couples unrelated rotation/compromise domains; the server knows/verifies some inputs; low-entropy passwords enable guessing; deterministic derivation impairs per-object crypto-erasure |
| plaintext server fallback, dual-write, or "temporary" compatibility cache | Creates a continuing ingestion path and makes purge/rollback unverifiable |
| plaintext endpoint SQLite because the host is trusted | Meets only the narrow server boundary but needlessly exposes backups/WAL and provides no authenticated rollback/corruption detection or crypto-erasure primitive |
| one shared key across hosts or browser devices | One compromise exposes every host and makes independent revocation/rotation impossible |
| unauthenticated encryption, deterministic ciphertext, content-derived IDs, or server-visible plaintext hashes | Permits tampering/equality tests and can expose low-entropy commands, paths, or environment values through dictionary attacks |
| last-write-wins by timestamp | Clocks and server ordering are not a trustworthy conflict authority and can silently discard a protected revision |
| automatic default/empty-value substitution on failure | Can launch the wrong command, omit security-relevant environment/skills, or run an unintended tool; compatibility must fail closed |

## Dependency hand-off

- **P2-DATA-02** implements this store, host-channel operations, endpoint-only
  create/edit/restart flows, migration, neutral naming, and server schema cuts.
- **P2-HOST-03B** may remove legacy interactive/unattended tool routes only
  after endpoint preset/tool values and policy are durable and tested here.
- **P2-PURGE-01** treats endpoint verification as the prerequisite for deleting
  server plaintext, then proves the old database/log/backup copies are gone.
- **P3-IDENTITY-01** closes malicious signaling substitution for trusted or
  independently verifiable endpoint builds. It is not a reason to put keys on
  the server in the meantime.
