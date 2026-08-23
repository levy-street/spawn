# P1-06 — Device identity, crypto and trust

**Phase 1, parallel with eight other agents.** You own the phone's cryptographic identity. Every
live terminal depends on you: a signed-signal transcript that is one byte wrong means no session
ever connects, and no amount of UI work will reveal why.

**Read first:** `00-OVERVIEW.md` (§5, §7.7, §8), then `research/05-trust-and-crypto.md` **in full**
— it maps every primitive to an Expo-Go-compatible equivalent and specifies the polyfill bootstrap
precisely. Then `research/04-terminal-transport.md §3` for the signed-signal transcript layout,
including the **revision-2 trap** described below.

---

## 1. Objective

Ship the device Ed25519 identity, secure storage, the canonical transcript codecs, host pinning,
and a vector-verified test suite proving the implementation matches the daemon and the web client
byte for byte.

## 2. Files you own

```
src/lib/secure-storage.ts             # SecureStore wrapper (other agents import this)
src/lib/crypto/bootstrap.ts           # CSPRNG + hash wiring, imported once at app start
src/lib/crypto/bytes.ts               # base64/base64url/hex/utf8 helpers
src/lib/crypto/ed25519.ts             # sign/verify with strict key validation
src/lib/crypto/identity.ts            # deviceIdentity (see §7.7)
src/lib/crypto/signed-signal.ts       # revision-2 transcript encode/decode + sign
src/lib/crypto/transcripts.ts         # registration, endorsement, pair-approval, possession
src/data/trust/host-pins.ts           # pin store + mismatch semantics
src/data/trust/registration.ts        # device registration flow (network calls via P1-05)
src/data/trust/endorsement.ts         # endorsement/introduction flow
src/lib/crypto/__tests__/**
src/data/trust/__tests__/**
```

You do not own UI. `P2-02` builds the pairing ceremony screens, `P2-08` builds the device/trust
settings panels; both call your functions.

## 3. Specifications

### 3.1 Crypto bootstrap — order matters

`research/05 §7-8` is explicit and contradicts the usual React Native advice. Follow it:

- Use `expo-crypto` for the CSPRNG by bridging `globalThis.crypto.getRandomValues` to it in
  `bootstrap.ts`.
- **Do not install `react-native-get-random-values`, `text-encoding`, or a `Buffer` polyfill.**
  They are not needed and you may not add dependencies anyway.
- Use `@noble/ed25519` and `@noble/hashes` as installed. `@noble/ed25519` v3 needs a SHA-512
  binding wired at bootstrap — wire it from `@noble/hashes` and verify it is set before any sign
  or verify call. A missing binding fails at runtime, not compile time, so add a guard that throws
  a clear error rather than an inscrutable one.
- UTF-8 encoding/decoding via strict local helpers in `bytes.ts`. Handle base64 as bytes, never
  via string round-trips through `atob`/`btoa`.

`bootstrap.ts` must be import-order-safe and idempotent. Export `ensureCryptoReady()` and call it
defensively from every entry point of your own modules rather than relying on someone else
importing it first.

### 3.2 Ed25519 with strict validation

`research/05 §TL;DR 3`: verification must reject non-canonical encodings, off-curve points and
small-order keys, and must use **ZIP-215-disabled** (strict) verification. Configure `@noble/ed25519`
accordingly and test against `proto/ed25519-public-key-negative-vectors.json` (copied to
`mobile/tests/fixtures/` by `P0-01`) — every negative vector must be rejected.

### 3.3 Device identity

Implements `00-OVERVIEW.md §7.7`.

- Generate a 32-byte Ed25519 seed with the CSPRNG on first use.
- **Store the seed only in `expo-secure-store`.** Unlike the web's non-extractable IndexedDB
  `CryptoKey`, the seed must briefly enter JS memory to sign; therefore expose **bounded signing
  operations only** — `signSignalTranscript`, `signApproval`, and the specific transcript signers
  you implement. **Never export a generic `sign(bytes)` or any `exportSeed()`.** That constraint is
  the whole point; do not relax it for convenience.
- Load the seed, sign, and drop the reference. Do not cache the seed in a module variable.
- `reset()` wipes the key and every dependent pin/registration record.

### 3.4 Signed-signal transcript — revision 2, not 1

**The checked-in spec prose is stale and will mislead you.** `research/04 §Scope` documents this
precisely:

- `proto/SIGNED_SIGNAL_V1.md` and `proto/SIGNED_SIGNAL_WIRE_V1.md` still print transcript version
  `1` and name scope code 1 `agent`.
- The current browser and daemon code both encode transcript **revision 2**, with scope code 1
  named **`session`**.
- `proto/README.md` says revision 2 and rejects revision 1.
- The golden fixture begins `...5631 02...` after the ASCII magic and uses `"scope_type":"session"`.

Implement **revision 2 / `session`**. Name the module and its types accordingly. Signatures are
pure Ed25519 over the exact canonical transcript bytes — **never over the diagnostic SHA-256 that
appears in the vectors files** (`research/05 §TL;DR 3`). That diagnostic hash is a debugging aid
and signing it produces a signature the daemon rejects.

The transcript has **no timestamp**; replay is fenced by the signed RTC UUID, a 128-bit outer
nonce, the daemon ownership generation, broker lifetime and retired-binding tombstones
(`research/04 §TL;DR 6`). Do not invent a timestamp field.

### 3.5 Other transcripts

Implement encode + sign for browser-device registration, endorsement/introduction, host pair
approval and host pair possession, per `research/05 §3` and the corresponding `proto/*.md`
contracts. Each gets vector tests (§5).

### 3.6 Host pins

`research/05 §4`: trust is keyed by **(account id, exact server origin, host public key)**. Host
ids are routing aliases and fingerprints are for display only.

- Store pins in secure/durable storage keyed exactly that way.
- Mismatch, missing identity, revoked pin, or unreadable pin storage must **fail closed** — return
  an explicit error state, never "assume fine". Export a discriminated result type so the UI can
  render the right message rather than a generic failure.
- Expose fingerprint formatting for display, matching the web app's format.

### 3.7 Secure storage wrapper

`src/lib/secure-storage.ts` is imported by other agents. Keep it minimal:

```ts
export const secureStorage: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};
```

Note the SecureStore **value size limit** (`research/08 §9`) — it is small. Guard `set()` with a
size check that throws a clear error rather than failing opaquely, and document the limit. Nothing
large or non-secret belongs here; `research/05 §9` is emphatic that plaintext durable-sensitive
data must never land in AsyncStorage/SQLite/SecureStore.

### 3.8 Passkey PRF — the unavailable path

`research/05 §5-6`: WebAuthn PRF encrypts the portable trust bundle and **cannot work in Expo Go**.
Export a capability probe returning `false` with a reason so `P2-08` can render an explicit
"not available on this device" state. Do not stub a fake implementation, and do not attempt
`expo-local-authentication` as a substitute — it is only a biometric prompt and proves nothing
cryptographically.

## 4. Rules specific to you

- No UI, no navigation, no React.
- Network calls go through `P1-05`'s endpoint functions. Code against
  `00-OVERVIEW.md §7.3` and `P1-05`'s plan; if a function does not exist yet, that is expected.
- Never log key material, seeds, signatures or full tokens. Fingerprints and lengths only.
- Fail closed everywhere. A trust module that guesses is worse than one that errors.

## 5. Tests — your most important deliverable

The fixtures in `mobile/tests/fixtures/` are golden. Verify against them:

- **`signed-signal-v1-vectors.json`**: encode the transcript from the fixture inputs and assert the
  bytes match exactly; sign with the fixture key and assert the signature matches; verify the
  fixture signature. Assert revision 2 and `scope_type: "session"` explicitly.
- **`signed-signal-wire-v1-vectors.json`**: wire framing round-trip.
- **`browser-device-registration-v1-vectors.json`**, **`host-pair-approval-v1-vectors.json`**,
  **`host-pair-possession-v1-vectors.json`**: transcript bytes and signatures.
- **`ed25519-public-key-negative-vectors.json`**: every vector must be **rejected**. A test suite
  that passes because verification accepts everything is worse than no suite — assert rejection
  explicitly, one case per vector.
- `bytes.ts`: base64/base64url/hex/utf8 round-trips including non-ASCII and padding edge cases.
- Identity: generate → sign → verify; `reset()` clears; no exported path returns the seed (assert
  the module's exports, so a future refactor that adds one fails this test).
- Host pins: match, mismatch, missing, revoked, unreadable-storage — each produces the correct
  discriminated result.
- SecureStore size guard throws for oversized values.

If a vector test fails and you cannot reconcile it, **do not weaken the test to pass**. Report it
as a blocker with the expected and actual bytes. A green suite over a wrong implementation is the
worst outcome available to you.

## 6. Deliverables checklist

- [ ] Crypto bootstrap per `research/05 §7-8`, no forbidden polyfills
- [ ] Strict Ed25519 with negative vectors rejected
- [ ] `deviceIdentity` matching §7.7, seed never exportable
- [ ] Revision-2 `session` signed-signal codec, signing canonical bytes not the diagnostic hash
- [ ] Registration, endorsement, approval, possession transcripts
- [ ] Host pins keyed by (account, origin, host key), failing closed
- [ ] `secure-storage.ts` with size guard
- [ ] Passkey capability probe returning an explicit unavailable reason
- [ ] All vector suites green, with rejections asserted
- [ ] `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-06.md`. Final report: `docs/native/reports/P1-06.md` with the
public API of every module, the exact transcript layouts you implemented, **the vector-test
results one line per fixture**, any discrepancy between the research and the fixtures,
`## Requests for other agents`, `## Known gaps`.
