# Browser device registration transcript v2

This contract proves that an authenticated browser can use the private half of
the public key it asks the server to bind to its account — and, since v2, what
ROLE it claims for that key. The signature algorithm is pure Ed25519 over the
exact bytes below, not JSON and not a hash.

## Canonical encoding

The transcript is fixed-width and contains, in order:

| Field | Encoding |
|---|---|
| Domain magic | 25 exact ASCII bytes: `SPAWN-BROWSER-REGISTER-V2` |
| Transcript version | `u8`, exactly `2` |
| Authenticated user ID | 16 UUID bytes in RFC 4122/network order |
| Flags | `u8`; bit 0 = account-root claim (`is_root`), all other bits `0` |
| Browser public key | exactly 32 raw Ed25519 public-key bytes |

The user ID comes only from the authenticated server session. Before encoding,
both runtimes require its exact canonical lowercase, hyphenated UUID text;
alternate spellings are rejected. The request does not carry an account ID.
Public keys and signatures are canonical unpadded
base64url at the HTTP boundary and are rejected unless their encoded widths are
exactly 43 and 86 characters before decoding. Public keys use the same strict
RFC 8032, canonical, non-small-order acceptance contract as signed signaling
and daemon pairing.

## The root flag (v2 change)

`is_root` marks the account root `pk_R` of the device mesh
(docs/TRUST_DEVICE_MESH.md §4.1). The stored flag carries real server-side
authority — it is the sole exemption from the mesh-R9 per-host endorsement
retirement, and it feeds the root pin-liveness ratchet — so v1's unsigned
request field was an unsigned, server-mutable input to a trust decision
(security review finding B1). In v2 the claim is inside the signed transcript:
the server verifies the proof against the request's `is_root` value, so a
root registration with an unflagged proof (or an ordinary registration with a
root-flagged proof) fails verification and is refused, and the `is_root`
column is attested by the key holder at insert time. There is no v1
acceptance window: v2 replaced v1 outright (green-field cutover).

## Replay and trust boundary

This deliberately uses no challenge state and no Redis. A valid proof can be
replayed, but only while authenticated as the same account, only for the
same immutable public key, and only under the same root/device role.
Registration is idempotent in that case. A key is
globally account-bound and a retained revocation tombstone prevents it from
being moved to another account or silently resurrected.

The proof establishes private-key possession at registration time. It does not
attest the browser, hosted JavaScript, or device, and it is not yet bound into
host pairing or live RTC signaling. The shared vectors in
`browser-device-registration-v2-vectors.json` pin bytes across Python and
TypeScript and cover positive (both flag values), mutation (including a
flipped root flag), and malformed wire cases.
