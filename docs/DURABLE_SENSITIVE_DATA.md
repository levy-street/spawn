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

The endpoint also owns an internal, encrypted **mutation reconciliation
journal**. It is not a fourth user object and has no server representation. It
retains the authenticated request fingerprint, affected object/revision or
tool target reference, effect boundary, and last definitive result for a
mutation whose acknowledgement or external side effect is uncertain. Its
`outcome_unknown` records survive daemon and browser restarts so a disconnect
cannot silently become a duplicate launch, install, import, or protected write.

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

Reconsideration requires a separate reviewed design with independently
provisioned and verifiable browser/device keys; authenticated host identities;
multi-device enrollment, recovery, revocation, and lost-device behavior; an
account root/recovery secret unavailable to the server; anti-rollback version
semantics; a hostile hosted-JavaScript answer; and explicit approval of
identifier, size, version, and access-pattern leakage. Until those prerequisites
are implemented and tested, no server ciphertext schema/API or server-held
decrypt/recovery key is permitted.

### Exact retained server metadata

P2-DATA-02 may retain only the disclosed registry and lifecycle fields needed
to address the endpoint plane:

- account/owner, host, agent, preset, skill, and grant IDs and relationships;
- explicit user labels or neutral names, preset/skill descriptions and kinds,
  lifecycle state, exit code, and coarse lifecycle/activity timestamps already
  allowed by `TRUST.md`;
- the unattended-policy enabled flag plus content-free check/update/result
  codes and coarse timestamps; and
- the monotonic per-account/per-host migration epoch, its CAS-protected state,
  and content-free aggregate migration counts needed to prove cutover.

It may not retain protected values, plaintext digests, exact protected sizes,
local object existence/revisions/key epochs, request fingerprints or IDs,
reconciliation-record presence/detail, detailed tool errors, or a protected
sync queue. An `outcome_unknown` state is learned and resolved through the live
host channel; ordinary server metadata remains whatever lifecycle state was
already disclosed and must not be treated as proof that the protected effect
succeeded or failed.

### Canonical guarded declarations

These rows are parsed by the durable-data guard; prose cannot silently override
them. The guard uses the locked, development-only `markdown-it-py==4.2.0`
CommonMark token tree (with table and strikethrough rules), excludes comment and
code-block tokens, and inventories rendered prose/inline-code/HTML text nodes.
Raw HTML also inventories `alt`, `value`, `title`, `label`, `placeholder`, and
every `aria-*` attribute value; these may expose visual or accessibility prose,
so the guard treats them conservatively even where one browser hides a value.
Every visible sentence in the guarded Markdown corpus must exactly match the
reviewed path, structural location, sentence index, duplicate occurrence,
category, and normalized text in
[`DURABLE_DATA_PROSE_INVENTORY.jsonl`](DURABLE_DATA_PROSE_INVENTORY.jsonl).
New documents, wording, relocation, or duplication fail CI until explicitly
reviewed. Regeneration is an explicit
`scripts/check-durable-data-decision.sh --write-inventory` operation whose prose
diff must be reviewed with the documentation change.

| Declaration | Value |
| --- | --- |
| `data01_runtime` | `design_only_not_implemented` |
| `phase2_completion` | `incomplete` |
| `phase2_canonical_store` | `endpoint_local_per_host` |
| `phase2_opaque_server_blob_fallback` | `forbidden` |
| `p2_host_02_status` | `reviewed_merged_4e7c89b` |
| `acknowledgement_retry_authority` | `forbidden` |
| `rotation_new_epoch_anchor_slots_before_old_key_retirement` | `2` |
| `p2_data_02_required_reviewed_merged_dependencies` | `P2-DATA-01,P2-HOST-02,P2-TERM-01,P2-HOST-03A` |
| `guarded_active_prose_policy` | `exact_visible_sentence_inventory` |
| `guarded_active_prose_inventory` | `path_location_sentence_occurrence_exact` |

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
  bounded idempotency/reconciliation journal enter SQLite/WAL. SQLite never
  receives a decrypted JSON/CBOR field. Envelope rows, immutable revision rows,
  object-head CAS, request result, reconciliation state, and generation/tag are
  committed in one SQLite transaction.
- DATA-02 must use a durability mode whose committed transactions survive the
  supported power-loss model (WAL with full synchronous durability or an
  equivalently tested setting), fsync the containing directory for newly
  created/replaced files, and verify crash recovery after truncating each write
  boundary. Corrupt pages/envelopes are quarantined; recovery never edits the
  only copy in place.
- The mutable anchor holds `store_uuid`, key epoch, latest committed store
  generation, previous-anchor hash, and an HMAC state tag over the canonical
  set of object heads, envelope hashes, tombstones, anti-replay heads, settled
  request results, and unresolved reconciliation heads. Every durable journal
  transition advances the generation. A mutation first commits generation `n`
  and its tag in SQLite, then durably advances the anchor; no external effect or
  later write is accepted until the anchor succeeds. On restart,
  database=anchor is normal; database=anchor+1 is accepted only after its tag
  verifies (crash between the two writes) and the anchor is advanced. Database
  older than the anchor, more than one generation ahead, or tag-mismatched
  fails as `data_rollback`/`data_integrity`. The committed database generation
  itself is the recovery evidence; the design does not assume a separate
  marker can be made durable after an anchor write has failed.
- Serialization is deterministic canonical CBOR. Limits are checked before
  allocation and again after serialization. Temporary plaintext buffers and
  keys are excluded from core dumps/locked where supported and zeroized on
  every success and error path. This is best-effort process-memory hygiene, not
  a claim that a compromised host cannot read its own data.

### Key hierarchy

1. Each host store has a random 256-bit **store master key** and random
   `store_uuid`. The master key is independent of the account password, daemon
   bearer token, WebRTC identity key, server secrets, and other hosts.
2. Each master-key epoch is an immutable credential record. The current epoch
   is selected by the authenticated mutable anchor, but the key bytes and anchor
   are never overwritten as one record. An OS credential facility is usable
   only when DATA-02 proves non-interactive unlock under the actual daemon
   service account after boot, logout, and offline restart. A desktop prompt or
   unavailable login keyring is unsupported. Without such a facility, Spawn
   creates a separate immutable local `0600` master-key file and uses the
   crash-atomic anchor files below. This fallback protects the control-plane
   boundary and supports crypto-erasure; it does not protect a disk image that
   contains both database and key material.
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
   operation. Browsers receive plaintext only inside the authenticated
   browser-to-endpoint DTLS session. Workers receive only the
   launch/materialization values they
   require over the existing private local worker channel.

### Crash-atomic key and anchor storage

The local-file mode stores immutable `master-key.<epoch>` records separately
from two mutable anchor slots, `anchor.a` and `anchor.b`. Each slot contains
magic/version, slot sequence, `store_uuid`, key epoch, database generation,
state tag, previous-valid-slot hash, and both a corruption checksum and
anchor-key HMAC. Initial creation and rotation write a new key epoch through a
same-directory temporary file, check all writes, `fdatasync`, rename, and
directory-fsync it before any anchor may reference that epoch; an epoch record
is never updated in place. To advance, the daemon writes the inactive slot
through a same-directory temporary file, checks every write/close result,
`fdatasync`s the file, atomically renames it over that inactive slot, and fsyncs
the containing directory. Only then may an external effect begin. It never
truncates or edits the last valid slot in place.

Recovery reads both slots without modifying them and validates each slot's
checksum, HMAC, identity, and sequence independently. With two valid slots, the
sequences must be adjacent and the newer predecessor hash must match the older;
equal-sequence disagreement or an invalid link fails closed. With one valid and
one torn/partial slot, the independently authenticated valid slot remains
eligible. The daemon selects the highest valid slot first and only then compares
it with SQLite: its generation must equal the authenticated database generation
or be exactly one behind it. One-behind is the bounded SQLite-commit/anchor-
advance gap and is repaired by writing the other slot before work resumes. An
anchor ahead of SQLite or a gap larger than one fails closed; it may not ignore
a higher valid anchor in favor of a convenient lower slot. Disk-full,
short-write, rename, or directory-fsync failure leaves the former valid slot
authoritative and prevents effect invocation; if SQLite already committed,
recovery uses the one-behind rule.

An OS credential mode must keep immutable key epochs separate and provide the
same two-slot/version/checksum/HMAC semantics using a platform primitive with
documented atomic durable replace and post-restart read guarantees. If the
credential API cannot prove those properties, only the immutable key lives
there and the mutable anchor uses the file slots above. A generic successful
"set secret" return is not assumed power-loss atomic. DATA-02 tests both modes
with injected short writes, disk-full, torn records, rename/fsync failure, and
power loss before and after every SQLite, slot-write, rename, and directory-
fsync boundary. Each recovery must select only the prior or new authenticated
generation and must never invent an unavailable committed state.

The three public object types above and the daemon-internal
`internal_reconciliation` envelope use the same revision-key/envelope rules.
The internal type is not listable through ordinary object APIs and never
appears in server metadata; it is exposed only through the bounded authorized
reconciliation operations.

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
  exact current revision. Exhaustion fails closed. A committed revision is
  immutable; the mutable head only points at a revision or tombstone. Historical
  revisions referenced by a launch manifest, active import/export, or unresolved
  reconciliation entry cannot be garbage-collected. Unreferenced history may be
  removed only by an explicit bounded retention policy that never changes the
  current head or resurrects an ID.
- There is no timestamp ordering and no last-write-wins. A stale write returns
  an E2E `revision_conflict` with the current revision. The browser must fetch,
  compare, and make the user choose which value to keep.
- A request ID is at least 128 random bits. The daemon durably retains a
  bounded mapping from `(authorized account principal, host, operation,
  request_id)` to an authenticated request fingerprint and result. The
  principal is stable across reconnects and is not an ephemeral WebRTC session
  ID. An identical retry returns the original result; reuse with different
  bytes returns `request_id_reused`. This result map is a retry convenience, not
  the replay boundary; durable target generations below remain after a result
  mapping is collected.
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
  a new lineage/revision. All traffic bound to the old lineage is rejected, so
  compacted tombstones cannot be bypassed by replay. Silent rollback is
  forbidden.

The endpoint can detect protocol replay, stale writes, database-only rollback
when its credential anchor survives, and ordinary stale imports. A
whole-machine rollback that restores the database and credential store to one
internally consistent older snapshot cannot be distinguished without an
external monotonic anchor. That limitation is disclosed; Spawn does not claim
rollback detection against an attacker who controls the trusted endpoint and
all of its backups.

### Durable anti-replay heads and admission

Every effect-bearing request carries the current store lineage plus an exact
`expected_effect_generation`. The daemon maintains an authenticated durable
anti-replay head for each bounded effect namespace. Object writes use the
object revision/tombstone as that head. Launches use one head per agent; tool
installs use one per local tool target; agent uploads use one per agent/cwd
capability; and all HOST-02 filesystem mkdir/rename/remove/write and transfer-
destination effects share a monotonic head for the host root capability. The
coarser root head intentionally serializes Spawn filesystem effects so an old
path request cannot become current merely because its short-lived result map
expired.

Admission atomically CASes `expected_effect_generation`, consumes the next
checked 64-bit generation, stores the request fingerprint and predecessor-head
hash, and writes the prepared journal record in the same SQLite transaction.
The new head hash commits `(store_uuid, account, user principal, host, effect
namespace, generation, request_id, request fingerprint, prior head hash,
journal record ID/state)`. It is included in the crash anchor. A replay after
result-map expiry, daemon restart, or same-lineage restore still carries the
old expected generation and fails `stale_effect_generation`; supplying the old
request ID with changed bytes fails `request_id_reused` while its head remains.
An explicit older-backup restore creates a new `store_uuid`, so every old frame
is wrong-lineage rather than fresh authority.

Settled request results are retained for **at least** 24 hours and capped at
4,096. The cap is an admission cap, not an eviction target: when all 4,096
entries are younger than 24 hours, request 4,097 fails `journal_capacity`
before allocating a stream, committing a prepared record, or invoking an
effect. Garbage collection may remove a settled result only after 24 hours and
only after verifying that the durable target head/tombstone/new lineage makes
the original request stale. It never removes anti-replay heads for live effect
namespaces, tombstones, prepared/effect-started/unresolved records, or proof
needed to resolve an effect. Deleting a target retains its head in the
tombstone; root/agent/tool head quotas fail closed before effect rather than
reuse or evict a generation. Exhaustion likewise fails closed.

### Ambiguous-effect reconciliation

Store-only mutations make the encrypted revision, head CAS, request result, and
generation durable in one transaction. A same-ID retry after a lost
acknowledgement therefore returns the recorded result. It never performs the
write twice. SQLite recovery yields either the old head or the atomically
committed head/result. If integrity/anchor checks cannot authenticate either
state, the daemon returns `data_integrity`, blocks the object, and does not
invent an `outcome_unknown` record from untrusted state.

The same endpoint journal must cover all external effects already accepted or
pending in this wave: merged HOST-02 filesystem mkdir, rename, remove, write,
and transfer-destination commit; independently reviewed TERM-01 agent upload
commit merged at `5d99ebb4`; review-pending HOST-03A tool install; and DATA-02
launch/restart. Before any effect it stores an encrypted, versioned record
containing at least:

- store lineage; exact account ID, authorized user/principal ID, host ID,
  protocol/session binding, operation, request/idempotency ID and fingerprint,
  effect namespace, prior and allocated effect generations, and predecessor
  head hash;
- the stable root capability identity and protected canonical target identity,
  including device/inode/generation where the platform supplies them, exact
  relative path components, expected existence/type/content hash or other
  operation-specific precondition, and overwrite/no-clobber policy;
- for agent uploads, the agent ID, backend/worker generation, cwd capability,
  destination identity, stream/temp ID, declared length and digest; for
  cross-host transfer, both source host/root/object identity and digest plus
  the destination precondition;
- for launch/restart, the agent ID, backend generation, expected worker
  generation/state, cwd capability, and exact manifest ID/revision/digest; and
- for tool installation, the preset/tool ID, executable/install target and
  command digest, endpoint policy generation, installed/latest-version
  precondition, and tool/package-manager reconciliation method.

Admission is `prepared`; it consumes the anti-replay generation. The daemon
then durably records and anchors `effect_started` **before** invoking the file,
worker, or package-manager effect. Journal capacity, quota, encryption,
SQLite, anchor, disk-full, or fsync failure at either pre-effect transition
prevents invocation. After invocation, `applied` plus target-specific proof is
persisted if possible. If that post-effect write fails, the already durable
`effect_started` record remains unresolved across restart and continues to lock
that effect namespace; lack of an `applied` record is never interpreted as
rollback.

A later authorized browser, including a different device, enumerates bounded
unresolved records over `spawn.host.ctl`. Reconciliation is conservative and
target-specific:

- mkdir is applied only when the expected directory identity exists and is
  not-applied only when the exact parent/basename precondition is unchanged;
- rename is applied only when the source identity is at the destination and
  absent at the source; it is not-applied only when that identity remains at
  the source and the destination precondition is unchanged;
- remove is applied when the exact target identity is absent and not-applied
  only when that same identity remains; any replacement/conflict stays locked;
- write, transfer, and upload are applied only when destination identity,
  length, and digest match, and not-applied only when the recorded destination
  precondition is unchanged;
- launch/restart is applied only when an endpoint worker identity and generation
  attest the exact manifest digest, and not-applied only when the recorded prior
  worker state is unchanged; and
- install is applied only with a direct executable/version/latest or
  package-manager transaction proof for the intended target. It is not-applied
  only when a tool-specific authoritative check proves the recorded
  precondition and absence of the transaction; version ambiguity stays locked.

Only a conclusive `not_applied` proof permits a new generation and retry.
`applied` stores the proof and permanently consumes the old generation. User
acknowledgement is never retry authority. A user may dismiss an unresolved item
from the default UI, but dismissal preserves its durable record, anti-replay
head, and effect lock and remains visible in an explicit unresolved inventory.
An inconclusive or conflicting check stays `outcome_unknown`; neither browser
nor daemon automatically repeats it.

Browser storage may retain only disclosed IDs and a hint that reconciliation is
needed; it is not authoritative and its loss cannot remove the endpoint lock.
Protected target, command, output, and error detail remain encrypted locally
and E2E. Unresolved records survive daemon restart, native same-host backup, and
same-lineage restore. Cross-host import reports source ambiguities but cannot
dismiss or unlock them; source frames are bound to the source lineage/host/root
and cannot authorize a destination effect. The destination gets new anti-replay
heads under its new lineage, while the source lock persists until conclusively
resolved.

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
| live object heads per store | 10,000 |
| encrypted current/history revision payload | 256 MiB total; referenced revisions are counted and never evicted |
| tombstones per store | 20,000; exceeding the cap blocks new IDs rather than evicting replay protection |
| unresolved reconciliation records | 256; reaching the cap blocks new external-effect mutations, never evicts ambiguity |
| durable external-effect anti-replay heads | 10,000 agent/upload/tool heads plus one filesystem head per registered host root; live/tombstoned heads are never evicted |
| settled idempotency results | 4,096, each retained at least 24 hours; cap+1 fails before effect |
| encrypted database payload | 256 MiB by default, inclusive of envelopes/journals; operator may lower it |
| encrypted export archive | 512 MiB |
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

Automatic garbage collection may remove only expired settled request results
after proving their target anti-replay head remains, and
unreferenced historical object revisions under the documented retention rule.
It may never remove a current head, tombstone, referenced revision, unresolved
reconciliation record, live/tombstoned effect head, or active stream. Admission
reserves all journal/head/disk capacity before allocating a stream or invoking
an effect. Reaching a cap or disk backpressure is an explicit E2E availability
failure before effect, not permission to weaken replay/ambiguity protection.

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
the format/store lineage, object IDs, current and referenced immutable
revisions, tombstones, protected values, all live/tombstoned anti-replay heads,
and same-host unresolved reconciliation records in one authenticated archive
encrypted under a user-supplied recovery passphrase. Settled request-result
history need not be exported because the retained heads make its requests
stale. A same-host/same-lineage restore must restore every head; an archive that
does not is rejected rather than treated as a fresh store.
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
Two devices see the same endpoint heads and unresolved-record inventory; exact
CAS makes at most one racing write succeed. A browser that missed an
acknowledgement must reconcile by request ID/current revision, not infer success
from server lifecycle metadata.

A native host backup containing both the store and local fallback key is
decryptable by whoever can restore that trusted endpoint. A backup containing
only the encrypted database is not recoverable. Copying SQLite and its
credential anchor independently can capture the generation gap and is not a
supported backup: use the passphrase export or a daemon-quiesced, read-back
verified snapshot of the database/WAL, immutable key epochs, and both mutable
anchor slots. Restore validates the complete set before exposing a head.
Restoring an older set requires the explicit new lineage/re-encryption flow
above. Operators must choose a platform backup that can restore the credential
facility consistently or the explicit export and document its retention.

Host re-registration, account ownership change, or token rotation never
silently rebinds a store: the AAD/account/host binding fails closed. A lost host
can be replaced only from a retained export or reconfiguration; server metadata
cannot reconstruct it. Cross-host import creates a new lineage and excludes the
source host's external effects after presenting unresolved records. A user can
dismiss that source warning, but cannot clear the source anti-replay head/effect
lock or authorize retry without conclusive source-side reconciliation.

## Rotation, revocation, deletion, and purge

- Routine master-key rotation is an authenticated resumable state machine; it
  never changes both mutable slots or destroys the old epoch in one step. The
  database first records `(old_epoch, new_epoch, rotation_phase)` while both
  immutable key records remain available. Transition generations carry the
  rotation-state/inventory digest and state HMACs under both old and new anchor
  keys, binding the new immutable key to the still-authoritative old epoch. It
  rewraps every live/historical DEK and every internal reconciliation,
  idempotency, anti-replay, tombstone, and journal envelope/wrapper under the
  new epoch, syncs the database/WAL, then reads back and authenticates the
  complete wrapper inventory. A missing or old-epoch wrapper blocks progress.
- After wrapper verification, rotation commits database generation `n` and
  durably advances the inactive anchor slot under the new epoch. It reads that
  slot back and verifies its checksum/HMAC/state tag. The other slot and old
  key remain untouched, so a torn first new slot is recoverable. Rotation then
  commits a distinct `rotation_anchor_confirmed` generation `n+1`, advances the
  other slot under the new epoch, syncs it, and reads it back. The result must
  be two adjacent, predecessor-linked, independently authenticated new-epoch
  slots. These are two consecutive new-epoch anchor advances, not two copies
  written before one durability barrier.
- During this transition recovery accepts mixed old/new slot epochs only when
  the database transition state validates under both epoch HMACs, names both
  immutable keys, and its inventory digest matches. It selects the highest
  valid slot using the normal generation rules, resumes wrapper/slot
  verification, and never treats a missing/torn new slot as permission to
  delete the old key. Short write, disk-full, crash, rename/fsync failure, or
  failed read-back at every wrapper, database, first-slot,
  confirmation-generation, and second-slot boundary keeps the old key and a
  safe recoverable slot selection.
- The old master-key epoch may be destroyed only after a final database scan
  proves no envelope/journal wrapper names it and **both** A/B slots have been
  synced, read back, and authenticated under the new epoch. Destruction is a
  separate `old_epoch_retire_ready` database/anchor step after the two-slot
  proof; that step is itself synced, read back, and authenticated before key
  deletion is attempted. Until deletion succeeds and read-back confirms the
  old immutable credential is absent, diagnostics say rotation is incomplete;
  they never claim old-epoch retirement.
- If the old master key may be compromised, rewrapping is insufficient because
  retained old ciphertext/wrappers remain decryptable. Every object must be
  decrypted, resealed under fresh DEKs, verified, and old database/WAL/backups
  destroyed or allowed to expire before claiming recovery from compromise.
  The full-reseal path still follows the same two verified new-epoch slot
  advances before retiring the old key.
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

Every transition CASes the exact `(migration_epoch, state)` pair and increments
`migration_epoch`; stale epochs or unexpected source states fail closed. The
state label has one intentional pre-cutover backward edge, but the epoch is
strictly monotonic, so an aborted copier cannot resume against a later attempt.
Only these transitions are permitted:

| From | To | Required condition |
| --- | --- | --- |
| `legacy` | `copying` | freeze legacy protected writes before admitting the bounded migration reader |
| `copying` | `legacy` | abort before endpoint-only ingress is cut; unfreeze only after temporary endpoint copies are invalidated |
| `copying` | `endpoint_verified` | all selected-host receipts and recovery exercises passed; atomically cut legacy ingress/egress |
| `endpoint_verified` | `scrubbed` | protected fields/routes are removed and historical purge has begun |

`legacy` is the old server-readable authority. `copying` freezes protected
writes and allows only the bounded migration reader to consume legacy fields;
normal create/edit/restart/tool/skill operations are disabled, so there is no
dual-read or dual-write. On entry to `endpoint_verified`, all protected
reads/writes switch to the endpoint and the server ingress/egress paths are
disabled before scrubbing starts. `scrubbed` means the fields/routes are gone
and historical purge is in progress/complete. No other edge is valid. After
`endpoint_verified`, failure is repaired only by roll-forward or endpoint
restore.

1. **Inventory without content.** Record row/object counts for
   agent manifests, preset values/tool targets, skill bodies, derived names,
   and detailed tool errors. The migration reader may measure a value only to
   enforce the endpoint limit and returns a content-free oversized count for
   explicit user remediation/export; it does not retain per-object or aggregate
   byte totals. Never truncate values or record plaintext/unkeyed hashes.
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
5. **Cut ingress.** Atomically enter `endpoint_verified`, switch
   create/edit/restart/tool/skill flows to endpoint-only operations, and set a
   schema/config sentinel that makes old binaries fail startup rather than
   serve legacy fields. Stop cwd-derived names and reject all legacy
   frames/routes that could write or return protected values. Restart/drain
   server workers as required by the P2-PURGE-01 runbook.
6. **Scrub, then drop.** In one staged migration, replace protected fields with
   null/empty compatibility values only after endpoint verification; scrub
   conservatively derived agent names and detailed tool errors; then remove the
   columns/routes in a later irreversible schema step. Record only counts.
7. **Purge history.** P2-PURGE-01 removes all recoverable historical copies and
   verifies the oldest remaining backup. Binary/config rollback may not restore
   a plaintext server store.

If any verification fails while `copying`, remain frozen or explicitly return
to `legacy` before the endpoint-only cut. After `endpoint_verified`, failure
remediation is endpoint restore/import or a corrected roll-forward—never server
plaintext restoration. An offline host blocks that host's transition unless
the user explicitly retires it or accepts loss after export; one online host's
success cannot be used as evidence for another host.

## Observability contract

Allowed server logs/metrics: stable operation class, stable content-free result
code, host/agent/preset/skill IDs already disclosed as metadata where needed,
bounded counts, duration, and coarse lifecycle timestamps. Prefer request IDs
hashed with a process-local telemetry key. Do not log protected payload sizes
unless the size class is already explicitly disclosed; this endpoint-local
design does not add server-side object size/version/access metadata. It also
does not add reconciliation request IDs, targets, record counts/presence, or
outcome detail to server logs, metrics, traces, crash reports, or metadata rows.

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
| lost acknowledgement or uncertain external effect | durable endpoint `outcome_unknown`; block retry until target-specific reconciliation conclusively proves `not_applied`; acknowledgement/dismissal never unlocks it |
| settled result map full | fail `journal_capacity` before stream allocation, journal admission, or effect; never evict a younger-than-24h result or required anti-replay head |
| credential anchor advance failure | do not invoke the effect; keep the last valid anchor slot, refuse later work, and repair only by authenticated one-generation recovery |
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
   partial database/journal rollback all fail without changing the current
   object or clearing an unresolved-effect lock. File-fallback and credential
   modes inject short-write, disk-full, torn-slot, rename/fsync failure, and
   power loss before/after every SQLite/anchor transition; recovery selects
   only the old or committed authenticated generation.
5. Two browsers racing writes get exactly one commit and one conflict. Two
   online hosts can copy a preset/skill through the browser; an offline
   destination creates no server-held queue. Cross-account and cross-host
   attempts return no object or existence oracle. A second browser can enumerate
   and reconcile a first browser's endpoint-durable `outcome_unknown` record;
   closing the first tab, dismissing the warning, restarting the daemon, or
   restoring a same-lineage backup cannot unlock an automatic retry. Tests
   cover HOST-02 mkdir/rename/remove/write/transfer, TERM-01 upload, HOST-03A
   install, and DATA-02 launch journals with failure at every pre/post-effect
   persistence boundary and target-specific applied/not-applied/conflict proof.
6. Quota, concurrency, timeout, cancel, disconnect, and oversized declarations
   keep memory/disk within the stated bounds and leave no readable partial
   value. Previous revisions remain usable after aborted replacement. With
   4,096 younger-than-24h settled results, request 4,097 fails before effect;
   after safe mapping expiry, the old request still fails its durable effect
   generation after daemon restart and same-lineage backup/restore. Required
   heads and unresolved records are never reclaimed under quota pressure.
7. Export/import uses a wrong-passphrase failure oracle no richer than
   authentication failure, preserves current/referenced revisions,
   tombstones/conflicts and same-host unresolved reconciliation, and requires
   explicit lineage change before rollback or cross-host rebinding. A
   database-only, key-only, or generation-split native restore fails closed.
8. Routine and compromise rotations inject short-write, disk-full, crash, and
   rename/fsync/read-back failure at every wrapper/database/first-slot/
   confirmation/second-slot boundary. Every interruption retains the old key
   and recovers a safe authenticated slot. The old epoch is not destroyed until
   an inventory proves every envelope/journal wrapper uses the new epoch and
   two consecutive, adjacent A/B slot advances are synced, read back, and
   authenticated under it. Mixed-epoch recovery validates the transition under
   both epoch HMACs. The recorded retire-ready step and deletion read-back must
   succeed before diagnostics report the old immutable key absent. Tests also
   prove the distinction between rewrap and full reseal. Wipe makes the store
   unrecoverable without a retained native backup/export and does not claim an
   offline remote wipe succeeded.
9. Migration transition tests accept only `legacy -> copying`, the pre-cutover
   abort `copying -> legacy`, `copying -> endpoint_verified`, and
   `endpoint_verified -> scrubbed`. Every success increments
   `migration_epoch`; a stale epoch/source-state CAS fails without changing the
   freeze or ingress cut. Counts match, endpoint read-back and daemon
   restart/launch/preset/skill/tool exercises pass, old clients are rejected,
   neutral agent names are used, no state performs dual-read/write, and the
   legacy fields remain empty after an old-binary/config rollback attempt.
10. An inventory guard fails CI if a protected server model/schema/route/frame,
    cwd-derived label, free-form server-visible error, or built-in operational
    preset value is reintroduced after cutover. P2-PURGE-01 separately verifies
    disks, observability, replicas, and the oldest retained backup.

These gates are owned as follows: DATA-02 must produce gates 1–9 plus the CI
inventory fixture before merge; HOST-03B must additionally inject lost
acknowledgement/crash at every installer effect boundary and prove direct
version/latest reconciliation before deleting the legacy tool route; PURGE-01
must independently run gate 10 and verify scrub/purge evidence for every
retained server metadata field and historical medium. Documentation or a green
unit test that never observes the server boundary is not substitute evidence.

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

P2-HOST-02's reviewed host-scoped filesystem boundary is already merged and is
an input to this design. P2-TERM-01 is independently reviewed and merged at
`5d99ebb4`; P2-HOST-03A remains an independently review-pending interactive-
installer candidate. Their browser retry/ambiguity behavior is not evidence
that this ADR's durable reconciliation store exists. DATA-02 and HOST-03B must
integrate the reviewed versions and satisfy the gates below without reviving
the removed server paths.

P2-DATA-02 is schedulable only after P2-DATA-01 and P2-HOST-02 are reviewed and
merged **and** the P2-TERM-01 upload and P2-HOST-03A interactive-tool work have
each passed independent review and merged. TERM-01 satisfies that dependency at
`5d99ebb4`; HOST-03A remains pending. Effect-wrapper evidence must name the
exact reviewed TERM-01/HOST-03A protocol commits and demonstrate their
request/effect boundaries; an unreviewed candidate or documentation-only
DATA-01 commit is not sufficient dependency evidence.

- **P2-DATA-02** implements this store, host-channel operations, endpoint-only
  create/edit/restart flows, durable reconciliation journal, migration, neutral
  naming, and server schema cuts.
- **P2-HOST-03B** may remove legacy interactive/unattended tool routes only
  after endpoint preset/tool values, policy, and external-effect reconciliation
  are durable and tested here.
- **P2-PURGE-01** treats endpoint verification as the prerequisite for deleting
  server plaintext, then proves the old database/log/backup copies are gone.
- **P3-IDENTITY-01** closes malicious signaling substitution for trusted or
  independently verifiable endpoint builds. It is not a reason to put keys on
  the server in the meantime.
