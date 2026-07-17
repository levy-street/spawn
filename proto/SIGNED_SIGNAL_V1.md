# Signed RTC signaling transcript v1

This document defines the bytes signed for Phase 3 `rtc.offer` and
`rtc.answer` identity binding. It defines a cryptographic foundation only. Key
persistence, key discovery/continuity, user trust decisions, and live WebSocket
integration are separate tasks.

The signature algorithm is pure Ed25519. The signed message is the complete
binary transcript below, not JSON and not its SHA-256 hash. The hashes in the
golden-vector file are diagnostics that make cross-runtime byte mismatches easy
to identify.

## Canonical encoding

Integers are unsigned, big-endian, and encoded at their stated width. Text is
UTF-8 without normalization or terminators. Variable-width fields are preceded
by the stated byte length. Fields occur exactly once in this fixed order:

| Order | Field | Encoding and validation |
|---:|---|---|
| 1 | Domain magic | 23 exact ASCII bytes: `SPAWN-RTC-SIGNAL-SIG-V1` |
| 2 | Transcript version | `u8`; exactly `1` |
| 3 | Signal kind | `u8`; offer `1`, answer `2` |
| 4 | Protocol version | `u32`; `1..=2^32-1` |
| 5 | Session ID | `u16` byte length, then `1..=256` bytes of strict UTF-8 |
| 6 | Scope type | `u8`; agent `1`, host `2` |
| 7 | Scope ID | `u16` byte length, then `1..=256` bytes of strict UTF-8 |
| 8 | Sender role | `u8`; browser `1`, daemon `2` |
| 9 | Intended peer public key | exactly 32 raw Ed25519 public-key bytes |
| 10 | SDP | `u32` byte length, then `1..=1,048,576` bytes of strict UTF-8 |

Decoders reject an incorrect domain or version, unknown enum values, zero
protocol versions, empty/oversized fields, truncated fields, malformed UTF-8,
and any trailing byte. JavaScript encoders also reject lone UTF-16 surrogates
instead of allowing `TextEncoder` to replace them. No implementation may infer
defaults, normalize Unicode or line endings, ignore trailing data, or substitute
a canonical-JSON representation.

Public keys and signatures use canonical unpadded base64url on a JSON/wire
boundary. A public key decodes to exactly 32 bytes and a signature to exactly
64 bytes, so their encoded widths are exactly 43 and 86 characters. Decoders
reject any other encoded width before scanning, transforming, or decoding the
input. Padded, non-URL-alphabet, non-canonical, or wrong-length strings are
invalid. Private key bytes have no signaling wire representation.

Before import and again before verification, a public key must pass strict RFC
8032 compressed-point decoding and must not be any of the eight points in the
Ed25519 small-order subgroup. This check is required even when the platform
WebCrypto implementation accepts the raw key. Matching dalek `is_weak` does
not mean requiring the whole point to be torsion-free; canonical mixed-torsion
points with a non-small-order component remain accepted. The shared corpus in
`ed25519-public-key-negative-vectors.json` covers the complete subgroup,
all 40 noncanonical encodings, an off-curve encoding, seven accepted
mixed-torsion controls, and the identity-key universal forgery (`R` is the
identity and `S` is zero).

## Security properties and limits

Binding the kind distinguishes an offer from an answer. Binding the protocol
version, session, scope type and ID prevents a valid signature from being
replayed into a different version, RTC session, or agent/host scope. Binding
the sender role prevents reflection across the browser and daemon roles.
Binding the intended peer key prevents redirecting a signed message to another
known identity. Binding the SDP prevents signaling modification.

### Protocol-identifier replay audit

The endpoint wire adapter audits the current signaling identifiers before
accepting this transcript. Agent signaling has one RTC envelope,
`scope_type:"agent"`, `protocol:"spawn.pty"`, version 2; that PeerConnection
requires both the `spawn.pty` and `spawn.ctl` DataChannels. `spawn.ctl` version
1 is not a separately signaled offer/answer protocol, and current server and
endpoint parsers reject it in the signaling `protocol` field. Host signaling is
`scope_type:"host"`, `protocol:"spawn.host.ctl"`, version 1. It is already
separated from agent signaling by the signed scope type.

There is therefore no pair of accepted current protocol identifiers with the
same signed scope type and protocol version. V1 does not add a protocol-name
field merely for a hypothetical future collision. The wire adapter instead
enforces the exact one-to-one mappings agent to `spawn.pty` and host to
`spawn.host.ctl`; it never treats `spawn.ctl` as a signaling protocol. A future
change that accepts two protocol identifiers in one signed scope/version must
define a new transcript version that binds a bounded protocol identifier. It
must not widen the V1 adapter.

Verification proves only that the holder of the corresponding private key
signed these exact bytes. It does **not** establish that the client, device,
browser origin, JavaScript bundle, or key is trusted. A later protocol must
authenticate key ownership/continuity through an explicit trust model and show
users what is actually verified. In particular, server delivery of browser
code is not independent client attestation, and these signatures do not encrypt
SDP from the relaying server.

Generated browser private keys are non-extractable by default, but this task
does not persist them. Rust secret-key objects and temporary random seeds are
zeroized; APIs and errors do not format or log secret material.

## Golden vectors

`signed-signal-v1-vectors.json` is consumed directly by both Rust daemon tests
and TypeScript/Bun WebCrypto tests. Its only fixed secret material is the seed
from RFC 8032 section 7.1 test vector 1; the intended peer public key comes from
test vector 2. It contains one agent offer and one host answer, their exact
transcript bytes, SHA-256 diagnostic hashes, and deterministic Ed25519
signatures.

Both runtimes verify the positive vectors, reject the other vector's signature
as a cross-transcript replay, and retain the original signature while changing
exactly one of every bound field: signal kind, protocol version, session ID,
scope type, scope ID, sender role, intended peer public key, and SDP. Every such
mutation must fail verification.
