# Signed RTC JSON wire envelope v1

This adapter carries the accepted signed-signal transcript on an endpoint
boundary. It is not installed on a live WebSocket route yet and does not
establish key trust, pin distribution, TOFU, or L1.

An envelope is one JSON object containing exactly these fields:

| Field | Value |
|---|---|
| `type` | `rtc.offer` or `rtc.answer` |
| `signature_algorithm` | exact `ed25519` |
| `sender_identity_public_key` | canonical 43-character Ed25519 public-key wire value |
| `intended_peer_identity_public_key` | canonical 43-character Ed25519 public-key wire value |
| `protocol` | `spawn.pty` for an agent scope or `spawn.host.ctl` for a host scope |
| `protocol_version` | exact `2` for `spawn.pty`; exact `1` for `spawn.host.ctl` |
| `session_id` | exact transcript text |
| `scope_type` | `agent` or `host` |
| `scope_id` | exact transcript text |
| `sender_role` | `browser` or `daemon` |
| `sdp` | exact transcript text |
| `signature` | canonical 86-character Ed25519 signature wire value |

An offer is browser-signed and an answer is daemon-signed. Protocol, scope, and
protocol version must follow the exact current mapping above. A correctly
signed agent version 1 or host version 2 envelope is still invalid. Unknown,
missing, duplicate, or additional fields; non-integral or out-of-range
versions; mismatched kind/role or protocol/scope/version tuples; malformed
keys/signatures; and over-bound input are rejected. Parsers cap the complete
JSON input before JSON parsing and reject wrong fixed-width key/signature
strings before base64 decoding.

Protocol versions use JSON value semantics consistently across runtimes. After
the runtime JSON number conversion, the value must be finite, exactly integral,
and in `1..=2^32-1`, then must equal the current protocol's exact version.
Equivalent source spellings such as `2`, `2.0`, `2e0`, and `2E+0` therefore
converge to the same value. This lexical tolerance is intentional: a browser
caller may already hold the parsed value. Canonical encoders always emit a bare
integer token. Fractional, non-finite, zero, negative, and out-of-range values
fail closed.

Verification receives independently obtained expected sender and intended-peer
key pins. It strictly validates both envelope keys and both expected pins,
compares each corresponding key, reconstructs the binary transcript, and
verifies the signature before returning a trusted signal value. The JSON bytes
and property order are not signed; the reconstructed binary transcript is.

Rust signing derives the sender public key from its `SigningKey`. Browser
signing consumes the persisted identity's public-only opaque handle containing
`publicKeyWire` and `sign(transcript)`. It verifies the returned signature
against that public key before emitting the envelope, so combining a signing
closure with another identity's public value fails closed. Neither signing API
accepts a sender field or exposes private key bytes.

[`signed-signal-wire-v1-vectors.json`](signed-signal-wire-v1-vectors.json) is
consumed by Rust and TypeScript. It covers the agent-offer and host-answer
forms, every envelope field mutation, equivalent JSON number spellings, and
correctly signed wrong-topology versions. The exact binary transcript remains
defined by
[`SIGNED_SIGNAL_V1.md`](SIGNED_SIGNAL_V1.md), including the current
protocol-identifier replay audit.
