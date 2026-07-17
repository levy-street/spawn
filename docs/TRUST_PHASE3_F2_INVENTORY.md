# Trust Phase 3 F2 — live verified-SDP inventory

This inventory describes the review-pending browser endpoint prerequisite. It
does not claim that F2, the signed-only cutover, or L1 is complete.

## Production browser boundaries

| Boundary | Signed-mode behavior | Remaining dependency |
|---|---|---|
| `web/src/components/terminal/useAgentSocket.ts` | Creates one `SignedRtcLiveSession` for the exact agent/session generation, sends only its opaque `signed_envelope`, requires the existing exact outer binding tuple, and applies the answer through `verifyAndApplyAnswer` | A reviewed trust-scope provider must supply the exact registered browser signing operation and the agent's exact active local Host pin |
| `web/src/lib/hostControl.ts` | Creates one `SignedRtcLiveSession` for the exact Host/session generation, sends only its opaque `signed_envelope`, treats outer Host topology mismatch as fatal, and applies the answer through `verifyAndApplyAnswer` | The reviewed HostControl trust registry must supply the destination's exact active local pin and epoch signer; H1 and H2 must remain distinct |
| `web/src/lib/signed-rtc-live.ts` | Calls `verifyRtcSignalWire`, retains its return value, compares the verified transcript with immutable local session/scope/protocol/version/kind/role state, and gives `setRemoteDescription` only `verified.transcript.sdp` | Daemon offer verification and live answer signing are separate work |

At construction the common adapter reads each capability key and operation
exactly once, synchronously validates/canonicalizes both Ed25519 pins and the
session/route UUIDs, and owns an immutable copy of the exact topology and Host
key bytes. Offer and answer processing never reread mutable capability or route
identity fields. The epoch assertion remains live at every asynchronous
boundary, but a getter, proxy, post-offer H1-to-H2 rotation, or operation swap
cannot change the generation's verifier expectations.

The common adapter deliberately never reads `frame.sdp`. A raw sibling in an
attacker-controlled test cannot become fallback data. A locally signed offer
freezes the generation into signed mode; a stripped, missing, malformed,
unverifiable, wrong-pin, wrong-peer, replayed, topology-mismatched, or second
answer seals that generation and closes the peer. Reconnect creates a new
canonical session and a new one-answer gate.

## Complete `setRemoteDescription` inventory

There are three non-test browser calls:

1. `signed-rtc-live.ts` — trusted signed-mode call, using only
   `verified.transcript.sdp`.
2. `useAgentSocket.ts` — staged legacy call, reachable only when no signed
   session was locally selected.
3. `hostControl.ts` — staged legacy call, reachable only when no signed session
   was locally selected.

The latter two remain only for the coordinated cutover and are why this branch
does not claim unconditional live signing. `scripts/check-signed-rtc-live.sh`
is a small grep-level guard that fixes this inventory, requires both live
consumers to use the common adapter, requires the verifier result to be
retained, and requires the verified SDP literal at the trusted call. It counts
the complete `setRemote`/`RemoteDescription` token family and exact approved
call shapes in all three files rather than allowlisting whole files. Its bounded
self-test injects direct, alias, bind, destructured, bracket, dynamic-name, and
copied raw-SDP calls and requires every one to fail.

## Signed-wire caller inventory

- `verifyRtcSignalWire` has two non-test callers, both in
  `signed-rtc-live.ts`: one self-checks the browser-signed offer before it can
  leave the endpoint and one verifies the daemon-signed answer before SDP use.
- The live consumers receive one bounded `signOffer` operation rather than a
  raw private key or general identity object. Its result is re-verified against
  the exact browser and Host pins and exact local route before transmission.
- `signRtcSignalWire` itself remains the bounded cryptographic implementation.
  The reviewed browser trust-scope integration must bind it to the exact
  WeakMap-backed epoch identity capability when supplying `signOffer`; this
  branch neither loads a raw identity nor duplicates that capability logic.
- The daemon's `run.rs` still rejects `signed_envelope` before RTC admission.
  It does not yet verify the browser offer, feed verified offer SDP into
  negotiation, or sign a live answer.

Tests cover both agent and Host routes, raw-versus-verified fingerprint
substitution, signature/pin/intended-peer/topology/session mutation, stripping,
malformed input, one-answer concurrency, renegotiation, trust invalidation,
post-construction Host/browser key substitution, hostile getters/proxies, and
fresh retry with the newly selected Host key. The interoperability runner
additionally sends a fresh Rust-host-signed answer through the production
WebCrypto live adapter and has Rust verify the reverse WebCrypto-host-signed
answer.
