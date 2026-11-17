# Support log consent v1

This is the daemon-side contract. No server collection endpoint, request sender,
or app signing switch ships with it. Sharing is off until an approved device
produces a valid statement. There is no expiry and no unsigned opt-in.

The Ed25519 signature covers exactly **102 bytes**, without a digest wrapper,
terminator, length prefix or JSON canonicalization:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 28 | ASCII `SPAWN-SUPPORT-LOG-CONSENT-V1` |
| 28 | 1 | Version, `0x01` |
| 29 | 16 | Account UUID, raw network-order bytes |
| 45 | 32 | Signer's Ed25519 public identity |
| 77 | 16 | Signer device UUID, raw network-order bytes |
| 93 | 1 | Enabled, exactly `0x00` or `0x01` |
| 94 | 8 | `issued_at_ms`, unsigned 64-bit big-endian Unix milliseconds |

The JSON envelope has exactly `version:1`, `account_id`, `signer_public_key`,
`signer_device_id`, `enabled` (boolean), `issued_at_ms` (unsigned integer),
`signature`, and optional `carried_endorsements` (default empty). UUIDs must
be canonical lower-case hyphenated strings. Public identities and signatures
use canonical unpadded base64url (32 and 64 decoded bytes respectively).
Envelopes over 64 KiB, unknown fields and noncanonical encodings fail closed
for support only. A present carried set
must be an array, at most 64 entries, using the existing RTC carried-approval
schema and its bounded deserializer. Approvals are not part of the signed
102 bytes: each approval has its own account-bound signature.

`daemon/src/support_consent.rs` encodes and verifies the statement. The account
must be **locally proven by this host's retained device approvals**
(`StoredCreds::proven_account_id`), never the account named by the server.
Without that proof, no statement is stored or honoured and collection refuses
with `not_consented`; status explains that a device approval is needed. This
restriction does not change legacy connection admission. Lock, receipt and
revocation files may still be written; no consent statement or bundle is written
for sharing without proven account authority.

Strict Ed25519 verification proves possession; `run::admitted_device` follows
the unchanged signed-RTC admission rule to prove trust: a direct pin or an unrevoked carried chain
to a pin for that account. `signer_device_id` must match the directly pinned
identity's device ID, or the device ID on the verified final approval reaching
the signer. A mismatched attribution is `signer_untrusted`. Connections retain
their existing direct-pin-before-chain-cap order and refusal diagnostics.

Newest `issued_at_ms` wins. At equal time, off beats on; otherwise the stored
statement stays. An identical statement may clear `server_off` after verification. If the signed
statement and `server_off` would stay the same, persistence is skipped. A signer must use
`max(now, current issued_at_ms + 1)` and must handle overflow as a failure.
Statements more than 86,400,000 ms in the future are refused; there is no expiry.
Removing a signer does not erase the timestamp floor.

The owner-only atomic `support-log-consent.json` contains the statement,
server-off flag and subtract-only revocations. Logout (both variants), reset and
exorcise attempt its removal after the existing credential/runtime operations.
Support failure adds a warning only. Ordinary errors retain master's return,
message and short-circuit behavior, including stopping before later instances. When no
statement exists, cleanup does not create a lock file.

## Delivery, ordering, and restart

- `register` adds `supports_support_log:true` (capability, not availability).
- `registered.support_log_consent` absent keeps local state; `null` disables
  sharing; a statement is verified before persistence.
- `{"type":"host.support_log_consent","consent":…}` carries the same statement
  or null.
- `{"type":"support_log.collect","request_id":"<uuid>","since_seconds":N}`
  requests collection. UUID parsing and signed-integer parsing happen before
  dispatch. N is clamped to 60–259200. Malformed support extensions deny support only; malformed ordinary frames
  retain the ordinary parser result. Registration parses its ordinary fields independently, including for a
  wrong type, unknown consent field or over-cap carried list. The ordinary parse
  runs first, with master's field types and JSON features. Only `registered` and
  `host.support_log_consent` get a second extension parse, into absent/null/valid/
  invalid. Duplicate support fields and frames over 64 KiB are invalid support;
  the ordinary parser keeps its existing WebSocket bound and duplicate semantics.

One optional sequential actor owns sharing across control reconnects. Startup
schedules its preparation without waiting; collection is unavailable until ready.
The existing delivery queue is present immediately, so early trust and withdrawal
cannot be lost during preparation. Preparation is the actor's first awaited job;
failure enters the same terminal denial. Dispatch
clones the parsed support payload, advances one generation with a compare-exchange
loop, clears the request-started bit, tries the bounded queue and notifies the
actor. It does no support filesystem or cryptographic work. Queue operations may
allocate and payload destruction may occur. Actual trust changes, failed or
timed-out credential observations, consent, teardown and shutdown advance the
generation; unchanged observations deliver nothing.

The actor takes one input at a time, in arrival order, and finishes it before
taking another. A combined trust/consent update stays one input. Received trust
and revocations are retained before writes. Collection runs inside that same
loop: admission budget, one preparation job (authorization, durable reservation,
snapshot and compression), one final disk authorization job, atomic start claim,
request selected against generation change, then one final receipt job. During
collection, delivery still advances the generation immediately, while queued
updates wait for collection to finish. Every filesystem job is awaited to
completion or its deadline; healthy work is never abandoned. Lock waits are
bounded at about two seconds. No job queues behind unfinished work. The dedicated
thread is not joined at daemon shutdown.

Any update failure enters terminal `Denied(reason)` for the rest of this process:
storage I/O failure, lock wait expiry, storage job deadline, stopped/panicked
storage worker, the consent write budget, the 256-key support revocation floor,
delivery queue overflow or delivery-gate contention, invalid support update, or
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
in `registered` before collection. A dishonest server can withhold withdrawal or
replay an old valid on after state loss. There is no host acknowledgement that it
applied a turn-off; apps must not claim one. Capability, silence and collection
receipts do not provide that confirmation.

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

The server relays withdrawal and can request a bundle before delivering off.
Dropping a future cannot recall transport buffers or bytes already received.
Cancellation records `cancelled`, which makes no claim that nothing was sent.

## HTTP collection contract

The destination is the configured server base URL plus
`/api/support-log/uploads/{request_id}`. `config::api_url` appends the API path
to the configured path with trailing slashes removed; it preserves origin and
port. Query and fragment are removed. Only HTTPS without URL credentials is
accepted in production (tests permit loopback HTTP). A frame cannot choose a
URL. The request carries **`Authorization: Bearer <daemon token>`**; a server
must authenticate it as the host and bind the request UUID to that host.
Redirects and retries are disabled; the response body is not read.

There is a process-wide admission bucket, one frame per minute with burst three,
retained across reconnects. Excess frames are counted and dropped before file
work: no receipt and no POST. Admitted requests have one 30-second absolute
deadline including queueing and audit; upload work gets 28 seconds, reserving two
for terminal audit. Connect timeout is five seconds, HTTP timeout fifteen.
All collection filesystem work uses the dedicated support worker. Jobs have a
three-second deadline, allowing the two-second lock wait to finish and report its
reason; the final receipt uses the collection's remaining absolute deadline.
No expired job is submitted. One collection runs at a time in this process, and
the cross-process flight lock also covers unfinished snapshots. Durable receipt limits are one collection per five
minutes and twelve per rolling day; refusals are charged and never refund quota.

The body is either `application/gzip` of at most **921600 bytes**, with
`Content-Length`, or a typed `application/json` refusal enum serialized as
`{"declined":"CODE"}`. Refusals contain no additional fields or free text:

| Code | Meaning |
| --- | --- |
| `not_consented` | Unknown locally proven account, absent/invalid/off/server-disabled statement, or stale queued request |
| `signer_untrusted` | Signer/chain revoked or untrusted, or verified device attribution mismatches |
| `rate_limited` | Flight lock busy or durable collection quota exhausted |
| `no_log` | No active writer or no eligible complete records |
| `failed` | Storage, snapshot, compression or preparation failure |

A request dropped before a response attempts a typed local `cancelled` receipt
and sends no new refusal; its body may still be delivered. Terminal denial or a
stale queued generation causes no POST. Destination, audit, deadline or transport
failure may leave no response.
Only **2xx** is success (204 is sufficient); 3xx, 4xx and 5xx are upload failures,
with no following or retry. Servers should use 400 for malformed bodies/headers,
401/403 for authentication/authorization failures, 404/409 for unknown or closed
requests, and 413 for oversized bodies; these statuses are all terminal to the
daemon. A successful status is not proof of server retention.

All gzip headers below are required; JSON refusals omit them:

| Header | Wire type and meaning |
| --- | --- |
| `X-Spawn-Support-Log-Sha256` | 64 lower-case hexadecimal characters: SHA-256 of compressed bytes |
| `X-Spawn-Support-Log-Lines` | Unsigned decimal integer: event lines, excludes header |
| `X-Spawn-Support-Log-Raw-Bytes` | Unsigned decimal integer: complete uncompressed JSONL bytes, at most 1048576 |
| `X-Spawn-Support-Log-From` | Signed decimal Unix milliseconds: first retained event, zero if absent |
| `X-Spawn-Support-Log-To` | Signed decimal Unix milliseconds: last retained event, zero if absent |
| `X-Spawn-Support-Log-Truncated` | Literal `true` or `false`: eligible events omitted by a byte cap |

## Snapshot and bundle

All flush, copy, parse, state projection and gzip work runs on the dedicated
support I/O worker.
The process's writer has 500 ms to flush. A flush failure refuses collection.
The reader takes the cross-process rotation lock without waiting and copies
only `support-v3.jsonl.1` and `support-v3.jsonl`, each at most 4 MiB. It closes
their handles before unlocking and parses the copies afterward. It never lists
a directory. Other writers' completed appends are included; their queued events
cannot be flushed by this process.

Complete valid records in the inclusive requested time window are stably sorted
by timestamp, then physical append order (previous file before current file).
Selection proceeds newest first; a record too large for the remaining cap is
skipped, and smaller older records can still fit. Output is oldest first. The
**1 MiB raw cap includes the header and every newline**; selection conservatively
reserves the maximum header size. Records are copied unchanged. Gzip is checked
after compression; an oversize result drops the oldest half and recompresses,
at most four compression attempts. An empty result is `no_log`; inability to
meet the compressed cap is `failed`.

The first JSON line is a format-3 header. Its build/version/variant describe
the **reader**; every event retains its original writer build. Variant is
`normal` or `diagnostics`. OS/architecture are compiler constants; the instance
tag is eight hex characters. `window_from`/`window_to` are requested Unix
milliseconds. These counts have precise meanings:

- `lines`: retained event records, excluding the header.
- `bytes`: the entire uncompressed bundle, header and newlines included.
- `from`/`to`: earliest/latest retained event timestamps, null for no records.
- `dropped_events`: sum of valid writer drop-marker deltas in the requested
  window, before size selection; not a lifetime total or an estimate of rotated
  away events. Markers omitted by the cap still contribute.
- `invalid_lines`: malformed, oversized, invalid-UTF-8, invalid-timestamp or torn
  lines in the two copied files; a torn final fragment counts once. Their window
  membership may be unknowable. An empty file contributes zero.
- `truncated`: eligible valid records were omitted by either byte cap. Rotation,
  writer drops and invalid lines have their separate semantics above.

The optional typed `state` projection contains only `connected`, `connected_at`,
`sessions`, `worker_mismatch`, numeric `rtc_peers`, `build_counter`, parsed release
identity, and `last_error.kind`/`last_error.at`. Times become Unix seconds; error
kind is a closed enum with `unknown` fallback; malformed release identity or time
is omitted/null. It never copies error detail, server URL, executable path,
host/user name or another general string. The release parser admits only the
numeric version, hexadecimal build identity, fixed dirty/diagnostics suffixes
and eight-hex release digest. Unrecognized release formats become null.

The append-only local receipts are `support/sent.jsonl`, rotated once to
`sent.jsonl.1` at 128 KiB each. Each contains only local time, typed request UUID,
outcome/refusal, compressed bytes, event line count and clamped window seconds.
A durable `started` reservation precedes reading/uploading; `sent` or
`upload_failed` or `cancelled` completes it. Refusals also consume budget. Conservative failure
accounting never refunds an attempted collection. Cancellation is charged even
when it happens before a started reservation (and may conservatively charge
again after one); cancelled frames cannot rotate away the quota floor. The limit is at most one per
five minutes and twelve per rolling 24 hours; clock rollback remains limiting.
A damaged audit fails closed. Rotation retains far more than twelve charged
records even with completion records, so refusal floods cannot erase quota.
`spawnd status` reports sharing, approving device/time, server-off and five recent
receipts. These local records do not promise that a server stored an upload.

## Requirements on the server and the apps

Before the server half or either app ships:

- Durable owner withdrawal is a signed `enabled:false` statement, not null.
  Null is reversible by redelivery of the identical valid enabled statement.
  Distinguish withdrawal requested from confirmation that a host applied it.
- Persist and redeliver the current statement in `registered` before any
  collection, including after restart. Capability is not current availability.
- Attribute the statement to the verified device and use
  `max(now, current issued_at_ms + 1)`. Handle overflow, clock disagreement and
  the host's 24-hour future bound without showing false success. Off wins ties.
  Missing local account proof stays unavailable.
- Authenticate the bearer token as the host, bind the request ID to that host,
  validate gzip/header limits and typed refusals, and treat only 2xx as success.
- Expect no POST for excess/admission-dropped requests, unavailable collectors,
  terminal denial, stale queued requests,
  cancellation, and some destination/audit/deadline/transport failures. Do not
  interpret silence as either success or proof that no bytes arrived.
- Disclose the restart residual: terminal process denial is lost at
  restart. Successful fallback unlink loses the timestamp/revocation floor and
  permits replay of older valid on; failed unlink can leave the original on.
  Honest redelivery does not prove durable withdrawal against an untrusted
  server. A stronger promise needs additional design.

## Golden vectors and regression gates

`support-log-consent-v1-vectors.json` contains synthetic on/off statements,
transcript bytes, digest, signing seed and signature, plus negative direct-pin
and carried-chain device-attribution cases (valid signatures, refused attribution). Regenerate from `daemon/`:

```sh
nice -n 15 cargo run --locked --example generate_support_log_consent_vectors > ../proto/support-log-consent-v1-vectors.json
nice -n 15 cargo test --locked --lib support_consent::
```

Like the existing protocol vectors, Rust unit tests consume the checked-in
corpus. They verify each signature and refuse a mutation at every transcript
byte. The collection tests use only local listeners. Snapshot ordering, torn
lines, bounded selection, rotation/concurrent reading and typed state tests are
not Unix-gated and run in the existing full native Windows CI test job. The
terminal canary remains Unix-only and now inspects the real compressed bundle
builder, after decompression, in plain, hex, base64 and decimal-byte forms.

The source guard pins the typed refusal enum, the two body call sites, reader
construction and reviewed upload source markers. Its mutations cover
extra `.json`/`.body` sources, body shadowing and a helper returning other bytes.
It is a source-marker regression check, not a proof of data provenance. Review
of the surrounding code and decompressed-bundle canaries remain necessary.
