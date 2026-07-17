# Browser device registration transcript v1

This contract proves that an authenticated browser can use the private half of
the public key it asks the server to bind to its account. The signature
algorithm is pure Ed25519 over the exact bytes below, not JSON and not a hash.

## Canonical encoding

The transcript is fixed-width and contains, in order:

| Field | Encoding |
|---|---|
| Domain magic | 25 exact ASCII bytes: `SPAWN-BROWSER-REGISTER-V1` |
| Transcript version | `u8`, exactly `1` |
| Authenticated user ID | 16 UUID bytes in RFC 4122/network order |
| Browser public key | exactly 32 raw Ed25519 public-key bytes |

The user ID comes only from the authenticated server session. The request does
not carry an account ID. Public keys and signatures are canonical unpadded
base64url at the HTTP boundary and are rejected unless their encoded widths are
exactly 43 and 86 characters before decoding. Public keys use the same strict
RFC 8032, canonical, non-small-order acceptance contract as signed signaling
and daemon pairing.

## Replay and trust boundary

This deliberately uses no challenge state and no Redis. A valid proof can be
replayed, but only while authenticated as the same account and only for the
same immutable public key. Registration is idempotent in that case. A key is
globally account-bound and a retained revocation tombstone prevents it from
being moved to another account or silently resurrected.

The proof establishes private-key possession at registration time. It does not
attest the browser, hosted JavaScript, or device, and it is not yet bound into
host pairing or live RTC signaling. The shared vectors in
`browser-device-registration-v1-vectors.json` pin bytes across Python and
TypeScript and cover positive, mutation, and malformed wire cases.
