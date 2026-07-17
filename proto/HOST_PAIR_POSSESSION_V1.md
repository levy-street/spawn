# Host-pair possession transcript v1

`SPAWN-HOST-PAIR-POSSESSION-V1` proves that the daemon starting one device-code
ceremony controls the private Ed25519 key corresponding to the exact host key
shown to the browser. It is a pre-approval gate, not a login token or a signed
signaling message.

## Fixed-width transcript

The signed byte string is exactly 126 bytes:

| Offset | Size | Value |
|--------|------|-------|
| 0 | 29 | ASCII `SPAWN-HOST-PAIR-POSSESSION-V1` |
| 29 | 1 | version byte `0x01` |
| 30 | 32 | raw device-code bytes |
| 62 | 32 | raw server approval-nonce bytes |
| 94 | 32 | raw Ed25519 host public key |

`device_code`, `approval_nonce`, `host_public_key`, and the 64-byte Ed25519
signature use canonical unpadded base64url on JSON boundaries. Both challenges
decode to exactly 32 bytes. The public key uses the shared strict canonical,
on-curve, non-weak Ed25519 acceptance contract. Verification rejects malformed
encodings, invalid `R`, non-canonical/high `S`, and any signature mismatch.

The shared Rust-produced golden vector is
[`host-pair-possession-v1-vectors.json`](host-pair-possession-v1-vectors.json).
Rust recreates it with `cargo run --locked --example
generate_host_pair_possession_vector`; Python verifies that exact signature.

## Ceremony state and ordering

1. `device/start` creates an unproved row and returns the exact device code,
   user code, and approval nonce to `spawnd`.
2. `spawnd` signs immediately with its persisted host private key and submits
   `/api/auth/device/possession` before printing the user code.
3. The server verifies the proof and conditionally records possession version
   1 plus its verification timestamp on that exact unexpired pending row.
4. `pending`, `approve`, and successful `poll` fail closed unless that one-way
   verified state is present. They cannot create a Host, ownership claim,
   browser pin, or token from an unproved ceremony.

An exact unexpired retry is idempotent. Changing the code, nonce, or key changes
the transcript; replay across ceremonies therefore fails signature
verification. Expired or deleted rows cannot be activated. Proof, expiry,
polling, and Host deletion retain the common HostKeyClaim-first write ordering
for existing host keys, so deletion either fences the code first or removes the
authority produced by the earlier transaction.

Migration 0021 leaves every pre-upgrade ceremony explicitly unproved. A
downgrade/re-upgrade also resets surviving proof fields to null, so no proof is
invented by schema migration.
