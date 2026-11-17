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
Unknown fields and noncanonical encodings fail closed. A present carried set
must be an array, at most 64 entries, using the existing RTC carried-approval
schema and its bounded deserializer. Approvals are not part of the signed
102 bytes: each approval has its own account-bound signature.

`daemon/src/support_consent.rs` encodes and verifies the statement. The account
must match this host's account, resolved by the same local-proof-first rule as
RTC admission. A statement more than 86,400,000 ms ahead of the host's clock is
rejected. Old statements do not expire. Strict Ed25519 verification proves
possession; `run::admitted_device`, shared with signed RTC offers, proves
trust: a direct pin or an unrevoked carried chain to a pin for that account.
As in RTC admission, device UUIDs are signed attribution; admission follows
public identities. Signer and signature are checked on application, on load,
and for every collection, with another check after snapshot work.

The host retains the greatest accepted `issued_at_ms`. Older statements and
conflicting statements at an equal timestamp cannot replace it. An identical
signed statement may carry a refreshed approval path; it clears `server_off`
after verification. Removing a signer does not erase the timestamp floor.
Received revocations are also retained locally for this feature, so a restart
cannot restore support sharing to a signer already known to be removed.

The atomic owner-only `support-log-consent.json` stores the statement, approvals,
server-off flag and subtract-only revocations. It is deleted on logout (including
logout that keeps the host identity), reset and exorcise. Loss of this state
also loses its timestamp/revocation floor: the server could replay the last
valid on statement, subject to the host's remaining device trust.

## Delivery and collection

- `register` adds `supports_support_log:true`.
- `registered.support_log_consent` absent means keep local state; JSON `null`
  sets `server_off`; a statement is verified before persistence.
- `{"type":"host.support_log_consent","consent":…}` applies the same statement
  or null. A pending update immediately blocks new uploads until applied.
- `{"type":"support_log.collect","request_id":"<uuid>","since_seconds":N}`
  requests collection. The UUID is parsed before dispatch; invalid IDs and
  non-integer windows are rejected as malformed frames. Signed integer `N`
  is clamped to 60–259200 seconds.

Dispatch only enqueues into a 32-command queue or publishes immutable trust
snapshots. A full queue ends that control connection, with sharing fenced off
for its pending work. Four bounded response tasks can run; only one may hold
the cross-process collection lock. Each request has a 30-second deadline from
arrival, including queue time. Blocking work owns the collection lock until it
actually finishes, even when an async deadline expires. Filesystem stalls can
outlive a deadline, but cannot resume an upload after it.

The sole POST destination is the daemon's configured HTTPS origin plus
`/api/support-log/uploads/{request_id}`. It uses the existing daemon token and
reqwest/rustls stack, disables redirects, has a five-second connect timeout
and fifteen-second HTTP timeout, and has no application retry loop. Tests alone
permit plain HTTP on loopback. The response body is never consumed.

The body is either `application/gzip`, at most **921600 bytes**, or
`application/json` containing `{"declined":"CODE"}`. Codes:

| Code | Reason |
| --- | --- |
| `not_consented` | Missing, invalid, off or server-disabled statement; pending consent update; consent changed during preparation |
| `signer_untrusted` | Unknown account or signer no longer passes device admission, including removed anchors/intermediates |
| `rate_limited` | Collection lock busy or local rate budget exhausted |
| `no_log` | No active support writer or no eligible complete records |
| `failed` | Storage, snapshot, compression or other preparation failure |

An invalid destination, failed local audit write, exhausted deadline or failed
transport cannot guarantee delivery of a refusal. No such failure sends log
bytes or starts a retry. Local receipts are attempted for failures too.

Headers on a gzip POST are `X-Spawn-Support-Log-Sha256` (lower-case hex SHA-256
of the **compressed body**), `-Lines`, `-Raw-Bytes` (whole uncompressed JSONL),
`-From`, `-To` (retained event Unix milliseconds), and `-Truncated` (`true` or
`false`). The six suffixes share the `X-Spawn-Support-Log-` prefix.

## Snapshot and bundle

All flush, copy, parse, state projection and gzip work runs on `spawn_blocking`.
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
`upload_failed` completes it. Refusals also consume budget. Conservative failure
accounting never refunds an attempted collection. The limit is at most one per
five minutes and twelve per rolling 24 hours; clock rollback remains limiting.
A damaged audit fails closed. Rotation retains far more than twelve charged
records even with completion records, so refusal floods cannot erase quota.
`spawnd status` reports sharing, approving device/time, server-off and five recent
receipts. These local records do not promise that a server stored an upload.

## Golden vectors and regression gates

`support-log-consent-v1-vectors.json` contains synthetic on/off statements,
transcript bytes, digest, signing seed and signature. Regenerate from `daemon/`:

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
