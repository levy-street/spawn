# Host-pair browser approval transcript v1

This contract proves that the exact active browser device displayed during a
daemon approval can use its registered private key. The signature is pure
Ed25519 over the fixed-width bytes below, not JSON and not a hash.

## Canonical encoding

| Field | Encoding |
|---|---|
| Domain magic | 26 exact ASCII bytes: `SPAWN-HOST-PAIR-APPROVE-V1` |
| Transcript version | `u8`, exactly `1` |
| Authenticated user ID | 16 UUID bytes in RFC 4122/network order |
| Approval nonce | exactly 32 server-generated random bytes |
| Host public key | exactly 32 raw Ed25519 public-key bytes |
| Browser public key | exactly 32 raw Ed25519 public-key bytes |

The authenticated user ID must be exact canonical lowercase, hyphenated UUID
text before encoding. Nonces, keys, and signatures use canonical unpadded
base64url at the HTTP boundary with exact encoded widths of 43, 43, and 86
characters. Both keys use the shared strict Ed25519 acceptance contract.

The nonce is created with the device code, expires with it, and is consumed by
one successful approval. It is not Redis state. The server accepts a proof only
for the current pending nonce and immutable host tuple, and only from the exact
active browser-device row owned by the authenticated account.

## Bounded trust claim

Successful approval and poll create an immutable server-side host/browser pin
and return the exact browser tuple to the daemon. Daemon-side validation and
local persistence belong to the separate 02E consumer; this contract does not
claim them. This is a first-contact record, not live signed signaling or TOFU
enforcement. Later server revocation can prevent an unconsumed approval from
issuing a daemon token, but cannot erase any daemon-local pin already persisted
by a daemon that may be offline.

Shared Python/TypeScript vectors are in
`host-pair-approval-v1-vectors.json`.
