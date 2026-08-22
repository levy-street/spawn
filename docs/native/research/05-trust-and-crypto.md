# R05 — Trust, device identity, crypto, and secure storage

## TL;DR

1. A phone is a first-class browser-device peer: it owns a per-account Ed25519 identity, registers proof of possession, pins host Ed25519 keys, signs WebRTC signaling, and is trusted by each daemon through direct pairing or an already-trusted device's endorsement.
2. Store the 32-byte Ed25519 seed only in `expo-secure-store`; unlike the web's non-extractable IndexedDB `CryptoKey`, it must briefly enter Hermes memory, so expose bounded signing operations and never an export or generic-sign API.
3. All spawn signatures are pure Ed25519 over exact canonical transcript bytes—never over the diagnostic SHA-256 printed in vectors—and verification must reject non-canonical, off-curve, and small-order keys and use ZIP-215-disabled verification.
4. Host trust is keyed by `(account ID, exact server origin, host public key)`; host IDs are routing aliases, fingerprints are UI, and mismatches, missing identity, revoked pins, or unreadable pin storage must fail closed.
5. Passkey PRF encrypts the portable trust bundle but cannot introduce the phone's new public key to a daemon; bidirectional endorsement remains necessary, and direct host pairing is the recovery/bootstrap path.
6. Passkey PRF is not available in Expo Go: `expo-local-authentication` is only a biometric prompt, while native passkey packages require a custom/EAS build; Expo Go must explicitly offer endorsement and manual host pairing instead.
7. Use `expo-crypto@57.0.1` for CSPRNG, `@noble/ed25519@3.1.0`, `@noble/hashes@2.3.0`, `@noble/ciphers@2.3.0`, `@stablelib/utf8@2.1.0`, and `base64-js@1.5.1`; all are Expo-Go-compatible with the documented bootstrap.
8. Do not install `react-native-get-random-values`, `text-encoding`, or a `Buffer` polyfill: bridge `globalThis.crypto.getRandomValues` to Expo Crypto first, use strict local UTF-8 helpers, and handle base64 as bytes.
9. Protected terminal/file/tool/agent/preset/skill data is memory-only on the phone; plain AsyncStorage/MMKV/SQLite/SecureStore must never become a cache of plaintext durable-sensitive data.
10. The phone can pair a host today: the daemon starts a 30-minute device-code ceremony, the user enters the eight-character code, compares fingerprints, and the phone pins then signs approval; there is no QR protocol in the current implementation.

## Scope, authority, and terminology

This report describes the live protocol, not merely the intended design. The trust documents are useful architectural authority, while the current TypeScript, Python, Rust, and JSON fixtures decide byte compatibility. In particular, `TRUST_PHASE3_AUDIT.md` calls itself a pre-implementation audit; its “missing” findings are historical, and the current source now wires those flows (`docs/TRUST_PHASE3_AUDIT.md:1-9`). Likewise, `DURABLE_SENSITIVE_DATA.md` is a proposed host-side design rather than a shipped storage subsystem (`docs/DURABLE_SENSITIVE_DATA.md:1-18`).

“Browser device” is the protocol/model name for every end-user client identity. The native phone should continue using that server object and wire vocabulary; inventing `mobile_device` would split the trust graph. “Host” is the long-running daemon identity. “Worker” is the PTY-owning subprocess behind the daemon and has no independently pinned durable key. “Agent” is a stored command/workspace shortcut, not a cryptographic actor (`server/spawn_server/models.py:361-386`; `web/src/lib/agent-identity.ts:1-57`).

`web/src/lib/hostIdentity.ts` was named in the research brief but does not exist in this checkout. The historical audit also recorded that no such implementation existed at audit time (`docs/TRUST_PHASE3_AUDIT.md:182-188`). Current host identity checking lives in `signed-signal.ts`, `signed-rtc-trust.ts`, `browser-host-pins.ts`, server host claims, and daemon credentials.

**UNKNOWN:** Whether an older branch contained `hostIdentity.ts`. Nothing in the current build imports it. Resolve only by asking the product owner for an archived revision; it is not needed to implement the current wire format.

## 1. Trust model overview

### Entities and durable authority

| Entity | Durable trust material | What it signs / verifies | Authority and lifecycle |
|---|---|---|---|
| Account | No account-wide signing root. The server record owns login/account state. | Nothing cryptographic itself. | Namespace for device keys, hosts, bundles, pins, and endorsements (`server/spawn_server/models.py:36-63`). |
| Browser device / phone | One Ed25519 private key and 32-byte public key per account; server stores device ID, label, public key, timestamps, and `revoked_at`. | Signs registration, host-pair approval, browser endorsement, and browser-side WebRTC offers/answers. Verifies host signed signaling and other-device endorsements. | A globally unique public key belongs to one account; revocation is intended to be permanent (`server/spawn_server/models.py:65-100`). |
| Host / daemon | One Ed25519 seed/public key in daemon credentials, plus trusted browser public keys and endorsement proofs. Server stores the host's current key/status and key claim. | Signs host-pair possession and daemon-side WebRTC signaling. Verifies browser pairing approval, signaling, and endorsements. | Key claims make a host key account-owned; daemon credentials are local authority (`server/spawn_server/models.py:203-323`; `daemon/src/creds.rs:37-115`). |
| Worker | No separate persistent identity. It is launched/controlled by an authenticated daemon. | No trust transcript. WebRTC peer identity is the host daemon key. | Owns a PTY/session process; the host control plane gates access (`daemon/src/sessions.rs:1-52`). |
| Agent | No key. It is a user-defined launch shortcut containing command/workspace information. | Nothing. | Stored server-side as product configuration; do not confuse it with an executing peer (`server/spawn_server/models.py:361-386`). |
| Trust bundle | Opaque encrypted server blob; passkey credential IDs and monotonic server revision are visible. | AES-GCM/HKDF protects the portable set of host pins. | Server is storage/CAS, not decryption authority (`server/spawn_server/models.py:145-200`; `server/spawn_server/routes/trust_bundle.py:1-107`). |
| TURN relay | Temporary relay credentials, no spawn content key. | Relays WebRTC DTLS packets. | Sees transport metadata and ciphertext, not terminal plaintext (`docs/TRUST.md:41-69`). |

The account is deliberately not a universal root of trust. Authentication lets a client ask the control plane for introductions, but it does not make an arbitrary newly logged-in key trusted by hosts. Each device proves possession to register; each host learns a device through direct pairing or through an endorsement signed by a device it already trusts. Each device learns a host by an explicit pin ceremony, a verified endorsement, or a PRF-unsealed bundle followed by daemon introduction. Browser-to-daemon terminal and control bytes ride authenticated WebRTC DTLS DataChannels and do not traverse the application server (`docs/TRUST.md:12-69`).

The adversary model includes a malicious/compromised control plane, hostile network, and TURN operator. They can see metadata/timing, suppress or reorder introductions, replace signaling, serve denial of service, and—on web—serve hostile JavaScript; they must not be able to silently substitute the peer key or read a correctly established DTLS channel. Endpoint compromise, traffic analysis, availability, and a user approving the wrong fingerprint are outside the cryptographic promise (`docs/TRUST.md:83-114`, `docs/TRUST.md:432-439`). A signed native binary reduces the hosted-JavaScript problem for the phone, although its build/update supply chain remains trusted. The server still sees residual account/host/session metadata enumerated by the trust design (`docs/TRUST.md:116-185`).

The `GUARD_POLICY.md` source guardrails are regression tripwires, not cryptographic proof: literal source patterns can be bypassed and must be backed by protocol tests and runtime validation (`docs/GUARD_POLICY.md:1-31`). The native test suite therefore needs positive shared vectors, negative key corpora, and state-machine tests—not string guards alone.

### What signs what

```text
phone key ──signs──> browser registration transcript ──verified by server
phone key ──signs──> host-pair approval transcript ───verified by server + daemon
host key  ──signs──> host-pair possession transcript ─verified by server
trusted device key ─signs──> browser endorsement ─────verified by server + daemon + phone
phone key ──signs──> RTC signaling transcript ───────verified by host before remote SDP
host key  ──signs──> RTC signaling transcript ───────verified by phone before remote SDP
passkey PRF output ─HKDF/AES-GCM──> portable host-pin trust bundle (not device identity)
```

The host and browser signed-signal flows are intentionally bidirectional (`docs/TRUST.md:795-828`). DTLS authenticates the connection to the key material in the exchanged SDP; the application signature authenticates that SDP to an already trusted spawn Ed25519 identity. Never call `setRemoteDescription` with unverified SDP (`docs/TRUST_PHASE3_AUDIT.md:194-203`).

## 2. Device identity lifecycle

### Web implementation: generation and storage

The browser uses WebCrypto Ed25519 and asks for a non-extractable signing key and extractable verification key:

```ts
const keyPair = await subtle.generateKey(
  { name: "Ed25519" },
  false,
  ["sign", "verify"],
);
```

The complete helper then exports only the public key, validates it, and stores the private `CryptoKey` handle (`web/src/lib/signed-signal.ts:332-345`; `web/src/lib/browser-device-identity.ts:234-287`). The identity database constants and record shape are:

```ts
const DATABASE_NAME = "spawn-browser-device-identity";
const OBJECT_STORE_NAME = "device-identities";
const DATABASE_VERSION = 1;
const MAX_IDENTITY_RECORDS = 32;

type StoredBrowserDeviceIdentity = {
  accountId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyWire: string;
};
```

Those values are stored by structured clone in IndexedDB, not localStorage, and the private key cannot be exported as raw/PKCS8/JWK (`web/src/lib/browser-device-identity.ts:17-42`). On load, the code re-exports the public key, compares it to `publicKeyWire`, signs a self-test, and verifies the result before returning the identity (`web/src/lib/browser-device-identity.ts:303-343`). Its public object exposes only bounded methods for registration, host approval, endorsement, and RTC signaling; it never exposes the private key or a generic `sign(bytes)` method (`web/src/lib/browser-device-identity.ts:384-503`).

Concurrent browser tabs use a candidate-write/re-read/single-winner scheme. If another tab wins, the losing candidate is discarded; the caller gets the durable winner (`web/src/lib/browser-device-identity.ts:505-532`). Deletion is compare-and-delete against the expected public key, which prevents stale UI from deleting a replacement identity (`web/src/lib/browser-device-identity.ts:534-615`).

The local cleanup/revocation marker is deliberately non-secret localStorage metadata:

```ts
const revokedKey = `spawn.browser-device.revocation.v1.${userId}`;
type RevokedBrowserDeviceMarker = {
  publicKey: string;
  status: "cleanup_pending" | "revoked";
};
// Stored wire text is `${status}:${publicKey}`, not JSON.
```

(`web/src/lib/browser-device-registration.ts:14-50`). Registration derives the server label from the browser/platform, signs the canonical transcript, posts it, and revalidates the exact returned public key (`web/src/lib/browser-device-registration.ts:98-162`). The recognition-only label is never a trust value: the browser returns a maximum-64-character string such as `Safari on iPhone`, `Chrome on Mac`, or null, while fingerprints remain the comparison value (`web/src/lib/browser-device-registration.ts:98-138`). The native default should be a similarly bounded recognition label such as `spawn on iPhone`, editable in settings; it must never enter a transcript or pin lookup.

### Rotation, revocation, logout, and export

There is no identity export/import feature and no transparent rotation. Normal reloads and logout keep the local identity so a later login preserves daemon trust. Rotation is an explicit destructive ceremony:

1. Revoke the server device first.
2. Immediately make local signing unavailable.
3. Write the local revoked marker.
4. Compare-and-delete the IndexedDB identity.
5. Require an explicit “start fresh” action before generating another key.

The settings flow follows that ordering (`web/src/components/settings/DevicesPanel.tsx:82-115`). “Start fresh” is separate and explicit (`web/src/components/settings/DevicesPanel.tsx:130-153`). The UI exposes fingerprint/current-device/revoke state and explains that clearing local history does not undo a permanent server revocation (`web/src/components/settings/DevicesPanel.tsx:315-369`, `web/src/components/settings/DevicesPanel.tsx:500-529`).

**UNKNOWN / SERVER CONFLICT:** The protocol says revoked public keys retain a tombstone and cannot re-register (`proto/BROWSER_DEVICE_REGISTRATION_V1.md:27-33`), and the UI calls revocation permanent. Registration rejects a still-present revoked row (`server/spawn_server/routes/browser_devices.py:35-102`), but `POST /api/browser-devices/prune` hard-deletes revoked rows (`server/spawn_server/routes/browser_devices.py:124-145`). No separate browser-key claim/tombstone was found. After pruning, the same held private key appears able to register again. Resolve with an adversarial server test and likely a durable key-claim/tombstone before relying on permanence. The phone must still refuse silent local reuse after revocation; it cannot repair the server gap.

### Exact iOS / Expo Go design

**RECOMMEND:** Store one versioned seed record per account in `expo-secure-store@57.0.1`, under the iOS Keychain's this-device-only class, and reproduce the web helper's bounded capabilities around it.

Use this record, well below SecureStore's historical ~2 KB value limit:

```ts
type StoredNativeDeviceIdentityV1 = {
  version: 1;
  accountId: string;       // canonical lowercase UUID
  secretKey: string;       // exactly 32 bytes, canonical unpadded base64url
  publicKey: string;       // exactly 32 bytes, canonical unpadded base64url
};

const itemKey = `spawn.identity.ed25519.v1.${accountId}`;
const options: SecureStore.SecureStoreOptions = {
  keychainService: "spawn.trust.identity.v1",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};
```

`expo-secure-store@57.0.1` is included in Expo Go. Its documentation warns about large values and says `requireAuthentication` cannot use Face ID in Expo Go; iOS Keychain data can survive uninstall/reinstall. `WHEN_UNLOCKED_THIS_DEVICE_ONLY` prevents migration to another device ([Expo SecureStore documentation](https://docs.expo.dev/versions/latest/sdk/securestore/)). Therefore:

- Generate exactly 32 random seed bytes with `expo-crypto.getRandomValues`, never `Math.random` and never the development-fallback synchronous `getRandomBytes` path.
- Derive the public key with noble Ed25519; save both only so corruption can be detected, not as independent authority.
- On every load: strict-parse JSON; require exact keys/version/account; canonical-decode both values; derive public key from seed; constant-time compare; strict-validate public point; sign and verify a fixed self-test; reject and quarantine logically on any failure.
- Serialize `loadOrCreate` with an in-process mutex. SecureStore has no compare-and-swap: read, generate, write, read again, and accept only the reread record. One React Native process avoids browser multi-tab races, but tests must cover two concurrent callers.
- Load the seed only for a bounded operation, then overwrite all owned `Uint8Array`s with zero. JS engines may retain copies, so this is best effort rather than non-extractability.
- Never expose the seed, a generic signer, export, import, or backup API. Device trust is not part of the passkey trust bundle.
- Keep the SecureStore record across ordinary logout, but clear in-memory closures and API tokens. Delete it only after self-revocation/account deletion or an explicit confirmed fresh-start ceremony.
- Because iOS Keychain may survive reinstall, an apparent first launch must load and validate the old record, not silently create a second identity. Settings must offer “revoke this device” and “start fresh”.

This is an unavoidable security delta from web WebCrypto: the seed is extractable into the JS runtime while signing. No Expo-Go-compatible API offers a non-extractable Ed25519 Keychain/Secure Enclave handle with the required raw Ed25519 public key and signature wire format. The encapsulation boundary, Keychain at-rest protection, narrow operations, redaction, and prompt zeroization are the correct managed-Expo fallback.

Do not set `requireAuthentication: true` for the identity. It would make background/reconnection signing prompt-dependent, invalidate values when biometric enrollment changes, and Face ID is not supported by Expo Go. `expo-local-authentication` may optionally lock the UI, but it is not key protection or trust proof.

## 3. Canonical registration, pairing, endorsement, and signaling transcripts

### Shared encoding rules

Every transcript below is a byte concatenation, not JSON, CBOR, protobuf, ABI packing, or a hash-to-sign construction. Integers are unsigned big-endian. UUIDs are canonical lowercase text at the API boundary and become their 16 RFC 4122 network-order bytes in binary transcripts. Public keys are raw 32-byte compressed Ed25519 encodings. Signatures are raw 64-byte pure Ed25519 signatures. Wire keys use canonical unpadded base64url: 43 characters for 32 bytes and 86 for 64 bytes.

The vector `transcript_sha256_*` values are diagnostics. Sign the literal transcript bytes. Do not sign their SHA-256 digest.

### 3.1 Browser-device registration v1

The authoritative layout is 74 bytes (`proto/BROWSER_DEVICE_REGISTRATION_V1.md:1-38`):

```text
offset  size  value
0       25    ASCII "SPAWN-BROWSER-REGISTER-V1"
25      1     version = 0x01
26      16    account UUID bytes
42      32    browser public key bytes
```

The browser encoder expresses the same order:

```ts
return concatBytes(
  new TextEncoder().encode("SPAWN-BROWSER-REGISTER-V1"),
  Uint8Array.of(1),
  uuidToBytes(accountId),
  decodePublicKey(publicKeyWire),
);
```

(`web/src/lib/browser-device-registration-transcript.ts:9-53`). Verification reconstructs that transcript, imports the claimed public key, and verifies the signature (`web/src/lib/browser-device-registration-transcript.ts:62-80`). There is no server challenge; replay is idempotent only for the same account/key, and account binding comes from authenticated request context.

Worked shared vector (`proto/browser-device-registration-v1-vectors.json:1-36`):

```json
{
  "user_id": "00000000-0000-4000-8000-000000000001",
  "public_key": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  "transcript_hex": "535041574e2d42524f575345522d52454749535445522d56310100000000000040008000000000000001d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "transcript_sha256": "f098d90322cea5e8fd61b061f8f3c4358afda2f0b20a9117f643aa8327a80dce",
  "signature": "LxBc6xLla_I36Xy8Uvd3VwbbywP_QnH0pIlONVYrUUkpWoIeHrpbqdSjJyaqKWmbo27xTmX7hXuggrM5Iw5DAA"
}
```

Offline verification procedure:

1. Decode the 43-character key and assert 32 bytes.
2. Decode the UUID to 16 bytes.
3. Concatenate the magic, `01`, UUID, and key; assert 74 bytes and exact `transcript_hex`.
4. SHA-256 only for diagnostics; assert the printed hash.
5. Decode the signature to 64 bytes and verify pure Ed25519 over the 74-byte transcript with ZIP-215 disabled.
6. Flip the version/account/key/signature independently and require failure.

To reproduce rather than only verify the signature, use the RFC 8032 seed `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60` carried by the possession fixture; it derives this same `11qY...URo` public key (`proto/host-pair-possession-v1-vectors.json:1-14`).

### 3.2 Host-pair approval v1

The browser/phone approves a daemon's pending possession claim with a 139-byte transcript (`proto/HOST_PAIR_APPROVAL_V1.md:1-38`):

```text
offset  size  value
0       26    ASCII "SPAWN-HOST-PAIR-APPROVE-V1"
26      1     version = 0x01
27      16    account UUID bytes
43      32    approval nonce
75      32    host public key
107     32    approving browser public key
```

The corresponding implementation concatenates those fields in that order (`web/src/lib/host-pair-approval-transcript.ts:9-53`) and verifies the reconstructed bytes (`web/src/lib/host-pair-approval-transcript.ts:62-83`). The approval nonce is supplied by the pending server ceremony and must be decoded as exactly 32 bytes.

Fixture excerpt (`proto/host-pair-approval-v1-vectors.json:1-24`):

```json
{
  "user_id": "00000000-0000-4000-8000-000000000001",
  "approval_nonce": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "host_public_key": "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
  "browser_public_key": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  "transcript_hex": "535041574e2d484f53542d504149522d415050524f56452d56310100000000000040008000000000000001000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660cd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "transcript_sha256": "23cb16873252dbdacdfef29b09ad347150580a765c890276f7749d9917ac5b77",
  "signature": "V4DhwT6vJKp1t-f9PGgiJXEjEZbJ1_cUUMqGDtZj3U9tfgeQIbVjugCPeF3aCRHr-EscxYQb8-PUmJggOgucAA"
}
```

The fixture's `transcript_hex` is the byte-for-byte primary oracle; tests must assert it before checking the diagnostic hash and signature.

### 3.3 Host-pair possession v1

The daemon proves it has the private key for the host key shown to the user. Its transcript is 126 bytes (`proto/HOST_PAIR_POSSESSION_V1.md:1-50`):

```text
offset  size  value
0       29    ASCII "SPAWN-HOST-PAIR-POSSESSION-V1"
29      1     version = 0x01
30      32    device-code bytes
62      32    approval nonce
94      32    host public key
```

The phone does not sign this transcript. It consumes only a server-verified pending ceremony, while the server and daemon must agree on it. The native fixture suite should still encode and verify it so a future local QR/offline ceremony cannot drift.

The vector uses the RFC 8032 Ed25519 seed `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`, public key `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`, device-code bytes `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`, approval nonce `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8`, diagnostic SHA-256 `3fa5e6b2b2efea9f9c7b82df72aecf0cdff068dca1b8ce4a5eb3b95352fe2f93`, and signature `4Rpu9zkZeKI8F4WLDURpgSjsfktWicSUJEOJb7V837oP9fyyyYRwZMRLxjNG9mADRdf72S-AebxWwrdv1e-ZAQ` (`proto/host-pair-possession-v1-vectors.json:1-14`).

### 3.4 Browser endorsement v1

A currently trusted browser device signs an introduction of a new browser device to one particular host. The 153-byte transcript is:

```text
offset  size  value
0       24    ASCII "SPAWN-BROWSER-ENDORSE-V1"
24      1     version = 0x01
25      16    account UUID bytes
41      32    host public key
73      32    endorser browser public key
105     32    endorsed/new browser public key
137     16    endorsed server device UUID bytes
```

This is the literal order in the web encoder (`web/src/lib/browser-endorsement-transcript.ts:21-69`) and the server equivalent (`server/spawn_server/browser_endorsement.py:20-93`). The daemon reconstructs the same transcript, requires the endorser already be trusted for the host, rejects self-endorsement, and verifies strict Ed25519 (`daemon/src/browser_endorsement.rs:28-133`).

The only current deterministic example is a TypeScript test rather than a shared `proto/*-vectors.json` file:

```text
account:   9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f
device:    11111111-2222-4333-8444-555555555555
host key:  Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo
endorser:  C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0
endorsed:  kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo
SHA-256:   zWI0kvAu5asJ4YKWiXSmlbSZM2u8_z7DOiVQ6vE220Y
```

(`web/src/lib/browser-endorsement-transcript.test.ts:8-33`).

**UNKNOWN:** There is no shared endorsement signature/seed fixture in `proto/`. The native suite can assert this transcript/hash example immediately, but the orchestrator should schedule a separately reviewed cross-runtime JSON fixture before treating signing interop as locked.

### 3.5 Signed signaling: filename “v1”, live transcript revision 2

Do not infer the live revision from filenames. The magic remains `SPAWN-RTC-SIGNAL-SIG-V1`, but the current transcript byte at offset 23 is revision `2` and the semantic identity field is a session ID (`web/src/lib/signed-signal.ts:6-30`).

```text
field                                      encoding
magic                                      23 ASCII bytes
transcript revision                        u8 = 2
kind                                       u8: offer=1, answer=2
protocol version                           u32 big-endian
session ID text length + text              u16 + canonical UTF-8 UUID (36 bytes)
scope type                                 u8: session=1, host=2
scope ID text length + text                 u16 + canonical UTF-8 UUID (36 bytes)
sender role                                u8: browser=1, daemon=2
intended peer Ed25519 public key            32 raw bytes
SDP byte length + SDP                       u32 + strict UTF-8, max 1 MiB
```

The encoder and limits are in `web/src/lib/signed-signal.ts:152-210`; canonical UUID/strict UTF-8 checks are in `web/src/lib/signed-signal.ts:89-118`. Current wire JSON has exactly these fields:

```ts
type SignedSignalEnvelope = {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: "ed25519";
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: "spawn.pty" | "spawn.host.ctl";
  protocol_version: number;
  session_id: string;
  scope_type: "session" | "host";
  scope_id: string;
  sender_role: "browser" | "daemon";
  sdp: string;
  signature: string;
};
```

Topology is fixed: `spawn.pty` version 2 uses session scope; `spawn.host.ctl` version 1 uses host scope. The native verifier must reject unknown/additional fields if the schema parser is exact, wrong role/kind/protocol/scope tuples, wrong intended peer, wrong session/host UUID, non-canonical base64url, oversized/invalid UTF-8 SDP, and invalid signature before passing SDP to WebRTC. `proto/signed-signal-v1-vectors.json` contains current transcript hex/hash/signatures, and `proto/signed-signal-wire-v1-vectors.json` contains full wire JSON plus wrong-topology negatives.

Fingerprint display is not a trust key: it is `SHA-256(publicKeyBytes)`, truncated to the first 12 bytes, base64url-encoded, and prefixed `SHA256:` (`web/src/lib/signed-signal.ts:439-449`). Always compare and persist the full 32-byte key.

## 4. Strict Ed25519 verification and negative corpus

Web key import first decodes exactly 32 bytes, constructs a noble point, and rejects `isSmallOrder()` (`web/src/lib/signed-signal.ts:136-150`). Native verification must additionally set noble's RFC 8032 behavior explicitly:

```ts
const point = ed.Point.fromBytes(publicKeyBytes, false);
if (point.isSmallOrder()) throw new Error("small-order Ed25519 key");
return ed.verify(signature, message, publicKeyBytes, { zip215: false });
```

`@noble/ed25519` defaults to ZIP-215-compatible verification, which is not the protocol policy. Its official documentation exposes `{ zip215: false }` for RFC 8032 behavior ([noble-ed25519 documentation](https://github.com/paulmillr/noble-ed25519)). Do not use platform “Ed25519 verify” as a black box unless its point/canonicality behavior is characterized against the shared negative suite.

`proto/ed25519-public-key-negative-vectors.json:1-103` is mandatory, not optional fuzz data. It contains:

- eight weak/small-order encodings that must be rejected;
- forty non-canonical encodings that must be rejected;
- an off-curve encoding that must be rejected;
- seven accepted mixed-torsion controls that must remain accepted by point validation;
- a universal-forgery case that must not verify.

Rejecting all cofactored/mixed-torsion points would be stricter than the existing runtimes and would create interoperability drift. Match the fixture categories exactly.

## 5. Host pinning

### What is pinned

A pin is the host's complete Ed25519 public key, scoped to account and exact control-plane origin. Host IDs are aliases attached after verified API/daemon binding; they are not identity. The derived fingerprint is presentation only.

The web IndexedDB is `spawn-browser-host-pins`, object store `host-pins`, version 1. It caps records at 256 including tombstones, host IDs per pin at 8, and origin length at 512 (`web/src/lib/browser-host-pins.ts:4-24`). The durable record contains account ID, origin, full public key, derived fingerprint, bounded host-ID list, created/approved/revoked times, and active/revoked state.

Origin parsing permits only exact HTTP(S) origins and rejects credentials, query, fragment, and path scope (`web/src/lib/browser-host-pins.ts:122-173`). Every load revalidates canonical account/origin/key/fingerprint/timestamps/state rather than trusting IndexedDB (`web/src/lib/browser-host-pins.ts:331-453`).

Approval is an explicit ceremony. The web persists the key before making the server approval call, and only an exact explicit approval can reactivate the exact revoked key (`web/src/lib/browser-host-pins.ts:631-692`). Resolution returns only an active exact key and rejects conflicting host aliases, missing records, and revoked records (`web/src/lib/browser-host-pins.ts:694-745`). Revocation writes a local tombstone before asking the server to delete/revoke (`web/src/lib/browser-host-pins.ts:747-799`).

### Native store

**RECOMMEND:** Use `expo-sqlite@57.0.1` for non-secret, integrity-critical pins and tombstones. It is included in Expo Go and persists across launches ([Expo SQLite documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/)). Validate every row and fail closed on any open/schema/read/validation error.

```sql
CREATE TABLE host_pins (
  account_id TEXT NOT NULL,
  server_origin TEXT NOT NULL,
  host_public_key TEXT NOT NULL,
  host_fingerprint TEXT NOT NULL,
  host_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  created_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  record_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, server_origin, host_public_key)
);
```

Enforce the same 256-record/8-host-ID/512-origin bounds in application transactions. Never silently evict tombstones. Treat malformed JSON, duplicate/noncanonical IDs, wrong recomputed fingerprint, impossible timestamps, unknown state, or schema mismatch as `PinStoreUnavailable`, not “no pin”. SQLite is appropriate because pins are public cryptographic material; SQLCipher is unavailable in Expo Go and unnecessary here. Do not use MMKV: it is a custom native C++ module, is not available in Expo Go, and its convenience would not justify a second state store.

### Mismatch and UX

The RTC trust gate has distinct fail-closed outcomes for absent identity, unavailable local pin store, withheld daemon key, revoked pin, and substituted/mismatched key (`web/src/lib/signed-rtc-trust.ts:17-62`, `web/src/lib/signed-rtc-trust.ts:86-149`). An unpinned but cryptographically signed connection may be classified as signed TOFU with `hostVerified: false`; it does not silently create a durable pin (`web/src/lib/signed-rtc-trust.ts:152-231`).

Surface the same actionable meanings as the desktop trust UI (`web/src/components/terminal/ConnectionChip.tsx:25-60`; `web/src/components/terminal/ConnectingOverlay.tsx:40-71`):

- **Different host key:** “Connection blocked: this host presented a different identity key. Reverify the fingerprint and explicitly reapprove.” Never offer a one-tap implicit replace.
- **Revoked pin:** “This host identity was revoked on this device. Reapprove only after checking the host fingerprint.”
- **Host key withheld:** “The server did not provide a host identity. Connection blocked.”
- **Phone identity missing/revoked:** direct the user to device trust setup or explicit fresh start.
- **Pin store unreadable/corrupt:** “Trust storage is unavailable. Connection blocked.” Do not degrade to TOFU.
- **First use:** show full short fingerprints for host and phone, explain where the matching host fingerprint is printed, require a deliberate approval, then save before connecting.

The native terminal overlay must not begin WebRTC while a trust sheet is behind it. Pairing/mismatch/revocation is a blocking native overlay with swipe-to-dismiss meaning “cancel connection,” never “continue insecurely.”

## 6. Passkey PRF, trust bundle, and the Expo Go boundary

### What the PRF protects

The passkey PRF is an optional portability mechanism for host trust, not an account signing key and not a browser-device private-key backup. Credential IDs are stored server-side and are treated as public metadata whose alteration can cause denial of service but not reveal the bundle (`web/src/lib/passkey-prf.ts:1-18`).

The fixed WebAuthn PRF input is:

```ts
const TRUST_BUNDLE_PRF_SALT_LABEL = "SPAWN-TRUST-BUNDLE-PRF-V1";
const prfSalt = SHA256(UTF8(TRUST_BUNDLE_PRF_SALT_LABEL));
```

(`web/src/lib/passkey-prf.ts:21-24`, `web/src/lib/passkey-prf.ts:99-115`). Credential creation requests a discoverable/resident credential, `userVerification: "required"`, ES256 or RS256, and the PRF extension (`web/src/lib/passkey-prf.ts:141-205`). Unlock evaluates that same PRF input and rejects a missing/wrong-sized result (`web/src/lib/passkey-prf.ts:208-269`).

The plaintext trust bundle contains only bounded host trust:

```ts
type TrustBundleV1 = {
  version: 1;
  accountId: string;
  revision: number;
  hosts: Array<{
    hostIdentityPublicKey: string;
    hostFingerprint: string;
    hostIds: string[];
  }>;
};
```

It has at most 256 hosts and is canonicalized/sorted before encryption (`web/src/lib/trust-bundle.ts:19-72`, `web/src/lib/trust-bundle.ts:192-252`). Browser identities and host-pin tombstones are not included.

The original single-secret format derives a 32-byte AES key using HKDF-SHA-256 with account-bound salt and info `SPAWN-TRUST-BUNDLE-KEY-V1`, then stores `12-byte IV || AES-GCM ciphertext || 16-byte tag` (`web/src/lib/trust-bundle.ts:145-179`, `web/src/lib/trust-bundle.ts:255-341`). The current envelope format is version 2:

1. Generate a random 32-byte data key.
2. AES-256-GCM encrypt the canonical bundle with a new random 12-byte IV and bundle AAD.
3. For each passkey credential, use its PRF output with HKDF-SHA-256 info `SPAWN-TRUST-BUNDLE-WRAP-V1` to derive a wrapping key.
4. AES-256-GCM wrap the data key with its own random 12-byte IV and credential/account-bound AAD.
5. Store up to 32 canonical wraps plus the sealed payload in canonical JSON, then base64url it.

The constants/AAD and bounds are in `web/src/lib/trust-envelope.ts:32-61` and `web/src/lib/trust-envelope.ts:81-118`; the exact AES serialization/parser is at `web/src/lib/trust-envelope.ts:127-299`. Enrolling or revoking a passkey rotates the data key and raises the revision (`web/src/lib/trust-envelope.ts:310-393`).

Carry the domain separation literally:

```text
legacy HKDF salt = UTF8(canonical account UUID)
legacy HKDF info = UTF8("SPAWN-TRUST-BUNDLE-KEY-V1")
legacy bundle AAD = UTF8("SPAWN-TRUST-BUNDLE-AAD-V1") || u8(1) || UTF8(account UUID)

v2 wrapping HKDF salt = UTF8(canonical account UUID)
v2 wrapping HKDF info = UTF8("SPAWN-TRUST-BUNDLE-WRAP-V1")
v2 bundle AAD = UTF8("SPAWN-TRUST-ENVELOPE-BUNDLE-V1")
                || u8(2) || 0x00 || UTF8(account UUID)
v2 wrap AAD   = UTF8("SPAWN-TRUST-ENVELOPE-WRAP-V1")
                || u8(2) || 0x00 || UTF8(account UUID)
                || 0x00 || UTF8(credential ID)
```

The NUL separators are explicitly load-bearing in the implementation (`web/src/lib/trust-envelope.ts:81-90`). Do not replace them with length prefixes or JSON. The locally generated WebAuthn challenge is a fresh random 32-byte value and is not server-verified; it must not be reused if passkeys later become an authentication factor (`web/src/lib/passkey-prf.ts:99-115`).

The web keeps a per-account monotonic revision floor in IndexedDB `spawn-trust-bundle-revision`, object store `revisions`; a lower server bundle is rejected as rollback (`web/src/lib/trust-revision.ts:1-17`, `web/src/lib/trust-revision.ts:64-140`). Import validates bundle account/version/revision and merges active host pins while preserving local tombstones (`web/src/lib/trust-bootstrap.ts:65-101`, `web/src/lib/trust-bootstrap.ts:157-228`). The server merely enforces authentication, revision/CAS, at most 256 KiB of sealed text, and at most 32 passkey credential rows; it cannot decrypt (`server/spawn_server/routes/trust_bundle.py:1-32`, `server/spawn_server/routes/trust_bundle.py:35-210`). The client envelope independently caps wraps at 32 (`web/src/lib/trust-envelope.ts:32-39`).

The relevant REST paths and their web client shapes are (`web/src/lib/api.ts:699-769`):

```text
GET    /api/trust/bundle
PUT    /api/trust/bundle
GET    /api/trust/passkeys
POST   /api/trust/passkeys
DELETE /api/trust/passkeys/{credential_id}
GET    /api/trust/hosts/{host_id}/pins
GET    /api/trust/endorsements?endorsed_device_id={device_id}
POST   /api/trust/endorsements
```

The Trust settings UX separates “set up/unlock this device” from “back up/revoke passkey”, shows unsupported-platform messaging, and exposes revision/credential diagnostics (`web/src/components/settings/TrustPanel.tsx:89-172`, `web/src/components/settings/TrustPanel.tsx:193-307`, `web/src/components/settings/TrustPanel.tsx:430-474`).

### Why the PRF is not enough for a new phone

Opening the bundle teaches the phone which host keys to pin. It does not teach any daemon the phone's new browser public key. The daemon explicitly documents this limitation (`daemon/src/browser_endorsement.rs:1-18`). A working new-phone ceremony is therefore bidirectional:

1. Phone registers its new device identity.
2. Phone opens/imports the trust bundle and learns the host keys.
3. An already trusted device signs one endorsement per host for the phone key/device ID.
4. Phone verifies each introduction, compares the endorser fingerprint out of band, and accepts the host pins.
5. Server and daemon independently verify the same endorsements; daemon adds the phone key.

The server accepts an endorsement only after proving that the endorser is currently pinned for that host and verifies the signature before storing/pushing it (`server/spawn_server/routes/trust_bundle.py:269-389`). The receiving client fetches pending introductions, verifies every signature, groups them by endorser fingerprint, and requires human comparison before acceptance (`web/src/components/trust/introduction-panel.tsx:14-120`). The trusted device UI derives the target fingerprint and signs per-host transcripts (`web/src/components/trust/device-endorsement.tsx:53-181`). Core verification and pin acceptance are at `web/src/lib/endorsement-introduction.ts:38-180`.

### Native passkeys

`expo-local-authentication@57.0.2` is a biometric/device-auth prompt only. It does not create a WebAuthn credential, produce a PRF extension result, or interoperate with the server's passkey credential IDs. Although included in Expo Go, Face ID itself is unavailable there ([Expo LocalAuthentication documentation](https://docs.expo.dev/versions/latest/sdk/local-authentication/)). It must never be presented as trust-bundle unlock.

`react-native-passkey@3.6.1` is the most credible later native route. Its current documentation supports PRF from package 3.3, with iOS support requiring iOS 18+, and requires native platform configuration/associated domains ([react-native-passkey documentation](https://github.com/f-23/react-native-passkey)). It is not built into Expo Go; use requires an EAS development/production build.

`expo-passkeys@0.1.11` exists in the npm registry, but its PRF-extension behavior and Expo Go inclusion could not be verified from official Expo SDK documentation.

**RECOMMEND:** Ship an explicit `UnsupportedExpoGoPasskeyPort` in the Expo Go target. Its trust screen should say: “Passkey trust backup requires the installed spawn build. In Expo Go, approve this phone from another trusted device or pair each host directly.” Keep the wire/envelope implementation and fixtures ready, then inject a `react-native-passkey` adapter only in the later EAS binary.

**UNKNOWN / PRODUCT DECISION:** Literal passkey feature parity conflicts with the hard Expo Go constraint. No JavaScript-only library can access iOS AuthenticationServices passkeys/PRF. The orchestrator must approve: (a) Expo Go supports registration, endorsement, direct pairing, pins, and signed RTC but disables PRF UI; (b) an optional EAS binary enables `react-native-passkey`. There is no secure WebView/local-auth emulation fallback.

`forgetTrustOnThisDevice` can expose a raw/unprotected fallback in the web bootstrap code (`web/src/lib/trust-bootstrap.ts:230-267`), while the default daemon enforcement design rejects unintroduced browser keys (`docs/TRUST.md:415-430`).

**UNKNOWN:** Whether that unprotected browser fallback is intentionally supported in the currently deployed enforcement configuration. Native must not promise it as recovery. Endorsement or direct pairing are the only fail-closed Expo Go paths evidenced end to end.

## 7. All sensitive data at rest

### Status of the durable-sensitive-data design

The durable-data document is explicit that its encrypted host store is not implemented yet (`docs/DURABLE_SENSITIVE_DATA.md:1-18`). It nevertheless defines the data classification the phone must inherit. Protected values include:

- resolved agent working directory, argv, environment, install command, create-cwd flag, and exact skill snapshot;
- preset default argv, environment, install command, tool target, and policy;
- skill body and format;
- internal reconciliation/intent journal containing protected values;
- terminal input/output, file contents, tool messages/results, paths, errors, and launch payloads wherever transiently processed.

The exact `agent_manifest`, `preset_values`, skill snapshot, and encrypted internal journal fields are enumerated at `docs/DURABLE_SENSITIVE_DATA.md:20-64`. The design explicitly does not make PTY transcripts durable (`docs/DURABLE_SENSITIVE_DATA.md:20-64`). Its trust boundary keeps plaintext at the host endpoint (`docs/DURABLE_SENSITIVE_DATA.md:129-148`).

The proposed host implementation uses encrypted SQLite records/canonical CBOR (`docs/DURABLE_SENSITIVE_DATA.md:150-190`), a random master key, per-revision DEKs, HKDF-separated contexts, and XChaCha20-Poly1305 with memory-only live keys (`docs/DURABLE_SENSITIVE_DATA.md:192-220`). AAD binds object/account/revision/type/schema tuples (`docs/DURABLE_SENSITIVE_DATA.md:269-280`), and replay/replace semantics are object/revision-aware (`docs/DURABLE_SENSITIVE_DATA.md:285-328`). These are daemon responsibilities; a phone must not become a second canonical durable store.

Recovery archives use explicit user action and a passphrase KDF target of Argon2id with 64 MiB memory, 3 iterations, parallelism 1, followed by XChaCha20-Poly1305. Passphrases and derived keys are memory-only. Browsers must not persist protected plaintext in IndexedDB, service workers, analytics, error reports, or caches, and should best-effort clear memory (`docs/DURABLE_SENSITIVE_DATA.md:518-560`). Rotation/deletion rules are at `docs/DURABLE_SENSITIVE_DATA.md:581-639`; logs/metrics must not carry sensitive fields (`docs/DURABLE_SENSITIVE_DATA.md:710-735`). Browser IndexedDB as a canonical store and server-side ciphertext persistence are explicitly rejected (`docs/DURABLE_SENSITIVE_DATA.md:835-848`).

### Native storage matrix

| Data | Web/daemon store today or planned | Native location | Native rule |
|---|---|---|---|
| Phone Ed25519 seed | Non-extractable private `CryptoKey` in browser IndexedDB | SecureStore / iOS Keychain | Only durable application secret owned by this trust module. Never SQLite, AsyncStorage, MMKV, logs, crash state, clipboard, files, or backups. |
| Phone public key/device ID/label/fingerprint | IndexedDB + server | SQLite | Public. Strict canonical validation and account/origin scoping. |
| Local identity revocation marker | Browser localStorage | SQLite | Public/integrity state. Prevent silent key reuse locally. |
| Host pins, host IDs, fingerprints, tombstones | Browser IndexedDB | SQLite | Public but security-critical. Validate/recompute and fail closed. |
| Trust revision floor | Browser IndexedDB | SQLite | Public monotonic integer. Transactionally reject rollback. |
| Opaque sealed trust envelope cache | Server + web memory | SQLite only if offline cache is required | Ciphertext and format metadata only; still bounded. Do not cache PRF output or unsealed JSON. |
| Passkey credential IDs/labels | Server + web | SQLite optional | Non-secret/DoS-sensitive metadata. EAS-only adapter. |
| PRF result, HKDF outputs, data/wrap keys, AES keys | Browser memory | Memory only | Zero owned byte arrays after use; never serialize. |
| Decrypted trust bundle | Browser memory then pins | Memory only until validated transaction commits pins | Never persist decrypted bundle JSON as a cache. |
| Terminal input/output and scrollback | Browser terminal memory | Memory only | The terminal component may hold bounded scrollback in RAM; clear on close/logout/background policy. No analytics/crash breadcrumbs. |
| File contents/transfers | Browser memory/streams | Memory or explicit user-selected OS file only | Never implicit app cache. Temporary transfer files need separately designed lifecycle and OS data-protection semantics. |
| Tool calls/results, agent launch data, cwd/argv/env | Browser memory; host authority | Memory only | Never plain local database/cache. Redact logs and errors. |
| Agent manifest, preset values, skill body/format, reconciliation journal | Proposed encrypted host store | Not stored on phone | Fetch/use transiently; host remains canonical. |
| Auth access/refresh tokens | Browser cookies/auth layer | SecureStore, owned by auth module | Never co-store with trust seed JSON; separate service/key names and deletion policy. Exact token lifecycle belongs to auth research. |
| Recovery archive ciphertext | Explicit exported file | User-selected file only | Store only the already encrypted archive. Passphrase/key remain memory-only. |
| Daemon master key, DEKs, encrypted SQLite anchor | Keyring/host storage (planned) | Never on phone | Host-only authority. |

**RECOMMEND:** Use no MMKV in the trust module. `react-native-mmkv@4.3.2` is a native C++ module and does not run in Expo Go ([MMKV documentation](https://github.com/mrousavy/react-native-mmkv)); SQLite already handles structured public state. Use no AsyncStorage for secrets or protected plaintext. Use SecureStore only for small secrets, not as a general encrypted document database.

`expo-sqlite@57.0.1` supports Expo Go and persistent storage, but its development inspector and ordinary filesystem access make it plain storage. SQLCipher explicitly is not supported in Expo Go ([Expo SQLite documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/)). That is acceptable only because the proposed SQLite rows are public pins/metadata/ciphertext. If a future feature needs a durable plaintext protected value, the answer is not “put it in SecureStore”; redesign it as memory-only or host-side encrypted state.

### Memory and observability rules

Native code cannot guarantee erasure of strings/JS heap copies. Minimize copies anyway:

- represent secrets as `Uint8Array`, not JS strings, except the unavoidable SecureStore JSON/base64 boundary;
- decode into an operation-local array, derive/sign, then `.fill(0)` seed/intermediate arrays in `finally`;
- never put secret buffers in Zustand/Redux/query caches, React state, navigation params, component props beyond the immediate signer, Flipper/React DevTools, crash attachments, or persisted debug state;
- redact public keys only where privacy requires, but never redact them by truncating before cryptographic comparison;
- backgrounding should close terminal channels and clear decrypted/protected in-memory caches according to the app session policy;
- logout clears auth and transient content but retains the device identity and pins unless the user explicitly revokes/forgets them;
- errors identify field/category and correlation ID, never raw payload, argv/env, SDP, signature input, key, passphrase, PRF result, or terminal bytes.

## 8. Crypto primitive inventory and Expo Go implementation

### Verified package set (checked 2026-08-22)

Versions below were checked against the npm registry `latest` dist-tags on the report date and API behavior against the linked official project/Expo documentation.

Registry records used for the non-Expo package versions: [noble Ed25519](https://registry.npmjs.org/@noble%2fed25519/latest), [noble hashes](https://registry.npmjs.org/@noble%2fhashes/latest), [noble ciphers](https://registry.npmjs.org/@noble%2fciphers/latest), [StableLib UTF-8](https://registry.npmjs.org/@stablelib%2futf8/latest), [base64-js](https://registry.npmjs.org/base64-js/latest), [react-native-passkey](https://registry.npmjs.org/react-native-passkey/latest), and [react-native-get-random-values](https://registry.npmjs.org/react-native-get-random-values/latest). Expo package versions were cross-checked against the version displayed in each linked SDK 57 page.

| Package | Verified current version | Use | Expo Go | Decision |
|---|---:|---|---|---|
| `expo-crypto` | `57.0.1` | Production CSPRNG bridge; optional one-shot digests | Yes, included | **RECOMMEND.** Expo-supported randomness on Hermes. |
| `expo-secure-store` | `57.0.1` | Ed25519 seed and auth secrets in Keychain | Yes, included; Face ID-authenticated values are not | **RECOMMEND.** Use `requireAuthentication:false`. |
| `expo-local-authentication` | `57.0.2` | Optional UI/app lock only | Yes; Face ID unavailable in Go | Optional; not cryptographic trust. |
| `expo-sqlite` | `57.0.1` | Pins, tombstones, revision floor, public metadata | Yes, included | **RECOMMEND.** One transactional public state store. |
| `@noble/ed25519` | `3.1.0` | Key derivation, pure Ed25519 sign/strict verify, point validation | Yes, pure JS after RNG/hash setup | **RECOMMEND.** Matches existing web point behavior. |
| `@noble/hashes` | `2.3.0` | SHA-256, SHA-512, HKDF, incremental hashing | Yes, pure JS | **RECOMMEND.** Wires noble Ed and supports shared envelope/tests. |
| `@noble/ciphers` | `2.3.0` | AES-256-GCM trust envelope; XChaCha only for fixture/future host design | Yes, pure JS | **RECOMMEND.** Exact byte API works in Hermes and Node fixtures. |
| `@stablelib/utf8` | `2.1.0` | Strict local UTF-8 encode/decode | Yes, pure JS | **RECOMMEND.** Avoids permissive/missing Hermes globals. |
| `base64-js` | `1.5.1` | Bytes-to/from-standard-base64 core for strict local base64url wrapper | Yes, pure JS | **RECOMMEND.** Avoids `Buffer`, `atob`, and `btoa`. |
| `react-native-passkey` | `3.6.1` | Later native passkey/PRF adapter | No; EAS/custom binary | Recommend only for installed EAS target. |
| `expo-passkeys` | `0.1.11` | Possible native passkey package | Unverified / not SDK-included | Do not select without PRF and build verification. |
| `react-native-get-random-values` | `2.0.0` | Common RNG polyfill | No need; native package not in Go | Do not install; Expo Crypto supplies the adapter. |
| `react-native-mmkv` | `4.3.2` | Native key/value store | No | Do not use. |

Expo Crypto documents `~57.0.1` as included in Expo Go and provides `getRandomValues` backed by cryptographically secure randomness ([Expo Crypto documentation](https://docs.expo.dev/versions/latest/sdk/crypto/)). Expo permits arbitrary pure-JS libraries in Go; custom native code must already be part of the Expo SDK/Expo Go runtime ([Expo third-party overview](https://docs.expo.dev/versions/latest/sdk/third-party-overview/), [Expo native customization guide](https://docs.expo.dev/workflow/customizing/)).

### Primitive-by-primitive mapping

| Primitive | Current spawn use / web implementation | Native implementation |
|---|---|---|
| Ed25519 key generation | WebCrypto `generateKey({name:'Ed25519'}, false, ['sign','verify'])`; private non-extractable (`web/src/lib/signed-signal.ts:332-345`). | `expo-crypto.getRandomValues(new Uint8Array(32))`; `ed.getPublicKey(seed)`. SecureStore the seed. |
| Pure Ed25519 sign | WebCrypto `subtle.sign`; exact transcript bytes (`web/src/lib/signed-signal.ts:351-429`). | `ed.sign(message, seed)` after SHA-512 wiring. Never prehash. |
| Strict Ed25519 verify | Noble point parse/small-order guard plus WebCrypto/noble verification (`web/src/lib/signed-signal.ts:136-150`). | Noble point parse, small-order reject, `ed.verify(sig,msg,pub,{zip215:false})`; run negative corpus. |
| X25519 / ECDH | No application-layer X25519 trust primitive. WebRTC DTLS stack negotiates its own transport keys (`docs/TRUST.md:50-69`). | No JS X25519 package or key store. Let `react-native-webrtc`/platform DTLS own transport crypto. |
| SHA-256 | Fingerprints, PRF salt, diagnostic vectors, HKDF, transfer hashes. WebCrypto plus incremental custom SHA (`web/src/lib/sha256.ts:1-3`, `web/src/lib/sha256.ts:20-124`). | `@noble/hashes/sha2.js` `sha256`; use `.create()` for streaming. Expo digest is acceptable for bounded one-shot data. |
| SHA-512 | Ed25519 internals. WebCrypto/native noble setup. | `@noble/hashes/sha2.js` `sha512`, assigned to noble v3 hash hooks. |
| HKDF-SHA-256 | Trust bundle/data-key wrap derivation (`web/src/lib/trust-bundle.ts:145-179`; `web/src/lib/trust-envelope.ts:81-118`). | `hkdf(sha256, ikm, salt, info, 32)` from `@noble/hashes/hkdf.js`. |
| AES-256-GCM | PRF trust bundle/envelope; 12-byte IV, 16-byte tag, AAD (`web/src/lib/trust-envelope.ts:127-299`). | `gcm(key, nonce, aad).encrypt(plaintext)` from `@noble/ciphers/aes.js`; output is ciphertext+tag, prepend nonce exactly. |
| XChaCha20-Poly1305 | Proposed unimplemented durable host store/recovery only (`docs/DURABLE_SENSITIVE_DATA.md:192-220`). | Do not implement for phone persistence. Noble ciphers exposes it if fixtures/future encrypted archive parsing needs it. |
| Argon2id | Proposed recovery archive, fixed parameters (`docs/DURABLE_SENSITIVE_DATA.md:518-560`). | No Expo-Go implementation selected in this scope. Phone should not create/decrypt archive until a reviewed Expo-Go-compatible implementation exists. |
| CSPRNG | WebCrypto `crypto.getRandomValues`. | Expo Crypto `getRandomValues`; never `Math.random`. |
| Base64url | Strict local web helpers require no padding and canonical re-encode (`web/src/lib/signed-signal.ts:452-487`). | `base64-js` internally; local URL alphabet/no-padding/exact-length/re-encode wrapper. |
| UTF-8 | Browser `TextEncoder` plus strict roundtrip/validation for SDP (`web/src/lib/signed-signal.ts:89-118`). | `@stablelib/utf8` strict encode/decode; reject unpaired surrogates and malformed bytes. |
| UUID | Canonical lowercase RFC 4122 text and raw 16 bytes. | Local strict parser/formatter; no permissive normalization inside transcript function. |
| JSON | Signed signal and canonical trust envelope outer formats. | Exact schema parse; canonical serializer where the protocol requires it. |
| CBOR | Only proposed canonical durable host record encoding (`docs/DURABLE_SENSITIVE_DATA.md:150-190`). | No mobile dependency. Current trust protocols do not use CBOR. |
| Protobuf | Not used by these trust transcripts. | No trust-layer protobuf dependency. |

**UNKNOWN:** An Expo-Go-compatible, audited Argon2id implementation satisfying the document's 64 MiB/3/pass=1 parameters was not established. `@noble/hashes` does not provide Argon2id. This does not block current native trust because recovery archives are not a shipped mobile feature; it does block claiming full recovery-archive parity.

### Noble v3 and Hermes bootstrap

Noble's official React Native section requires cryptographic randomness and SHA-512 setup. In v3 the old v2 `etc.sha512Sync` hook moved to `ed.hashes.sha512`; v3 also offers an async hook ([noble-ed25519 documentation](https://github.com/paulmillr/noble-ed25519)). Therefore instructions that say “set `sha512Sync`” are stale for `@noble/ed25519@3.1.0`.

Import this side-effect module first in the app entry, before any noble module or code that might generate a nonce/key:

```ts
// mobile/src/platform/crypto-bootstrap.ts
import * as ExpoCrypto from "expo-crypto";

if (globalThis.crypto === undefined) {
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    configurable: true,
  });
}

if (globalThis.crypto.getRandomValues === undefined) {
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: (array: Uint8Array): Uint8Array =>
      ExpoCrypto.getRandomValues(array),
    configurable: true,
  });
}
```

Then configure Ed25519 exactly once:

```ts
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

ed.hashes.sha512 = sha512;
ed.hashes.sha512Async = async (message: Uint8Array) => sha512(message);
```

The app entry ordering is:

```ts
import "./src/platform/crypto-bootstrap"; // first import
import "./src/app-entry";                 // may import trust/noble
```

Do not:

- install/import `react-native-get-random-values`; Expo Crypto already provides the CSPRNG bridge and the native polyfill package cannot be assumed in Expo Go;
- install `text-encoding` or `fast-text-encoding`; use local strict `@stablelib/utf8` functions so transcript behavior is not a mutable global;
- install a `Buffer` polyfill; `base64-js` operates on byte arrays;
- let noble's `randomBytes` initialize before the bootstrap import;
- use Expo Crypto's synchronous `getRandomBytes` for secrets: its documentation describes a development fallback; `getRandomValues` is the chosen path;
- accept padded/base64 standard alphabet, whitespace, noncanonical UUIDs, or replacement-character UTF-8.

**RECOMMEND:** Keep all crypto calls behind a small `CryptoPort` and use the same noble implementation in Hermes and Node unit tests. This removes WebCrypto/Hermes behavioral drift and makes the repository vectors executable without a device.

### AES-GCM exactness

Noble ciphers' official API is:

```ts
import { gcm } from "@noble/ciphers/aes.js";

const cipher = gcm(key32, nonce12, aad);
const ciphertextAndTag = cipher.encrypt(plaintext);
const plaintextAgain = cipher.decrypt(ciphertextAndTag);
```

The package documents React Native support with a `getRandomValues` polyfill and 12-byte GCM nonces ([noble-ciphers documentation](https://github.com/paulmillr/noble-ciphers)). Spawn must generate the nonce itself via Expo Crypto and serialize:

```text
sealed = nonce[12] || ciphertext[plaintext.length] || tag[16]
```

Never use a “managed nonce” wrapper whose framing might differ. Bind the exact account/revision/credential AAD from `trust-envelope.ts`, validate all lengths before decrypting, map authentication failure to a generic corrupt/wrong-credential error, and never return partial plaintext.

## 9. Pairing a host from the phone

### Can the phone pair a host?

Yes. It can complete the browser side of the existing manual pairing protocol. It cannot create a pending ceremony by itself: a user first runs the daemon login command on the machine. The daemon generates/persists its host identity, starts a device code, signs possession, and only then displays the code/fingerprint (`daemon/src/login.rs:1-8`, `daemon/src/login.rs:28-99`).

There is no QR payload or QR parser in the current flow. The web form accepts an eight-character code such as `QZ4K-7HMT` and the server code alphabet excludes ambiguous characters (`web/src/components/hosts/connect-host.tsx:311-445`; `server/spawn_server/routes/device.py:23-57`).

### End-to-end protocol and UX

1. **Daemon creates/loads host identity.** The 32-byte Ed25519 seed and credentials live in the OS keyring when available, with a mode-0600 fallback; the record includes access token, server, host ID, host seed/public key, trusted browser pins, and proofs (`daemon/src/creds.rs:1-12`, `daemon/src/creds.rs:37-115`). Seed generation/derivation/signing are at `daemon/src/creds.rs:1344-1393`; strict load revalidates the seed/public relation (`daemon/src/creds.rs:1425-1450`).
2. **Daemon starts code.** `POST /api/auth/device/start` returns `device_code`, human `user_code`, `approval_nonce`, `verification_uri`, expiry, and poll interval. The server ceremony lasts 30 minutes and defaults to 5-second polling (`server/spawn_server/routes/device.py:88-149`; `server/spawn_server/schemas.py:221-317`).
3. **Daemon proves possession.** It signs `SPAWN-HOST-PAIR-POSSESSION-V1` and posts the host key/signature to the possession endpoint before displaying/using the ceremony (`server/spawn_server/routes/device.py:152-198`; `daemon/src/login.rs:28-99`).
4. **User opens “Connect a host” on phone.** Offer install and login instructions plus manual pairing, matching the desktop's three states (`web/src/components/hosts/connect-host.tsx:99-165`).
5. **User enters code.** Normalize only the documented display formatting/case before API lookup; do not guess/scan QR. Phone calls the pending lookup endpoint and receives the account-bound pending host key, approval nonce, host fingerprint/name, and expiry (`web/src/components/hosts/connect-host.tsx:171-216`; `server/spawn_server/routes/device.py:628-667`).
6. **Phone shows comparison screen.** Display server origin, host name, code expiry, host fingerprint, and this phone's browser fingerprint. Instruct the user to compare the host fingerprint to the daemon terminal and later the phone fingerprint to the daemon result. Warn that approval grants terminal/file/tool authority on that host.
7. **User explicitly approves.** Reload the exact device identity. Derive/revalidate the host fingerprint. Persist the host pin transaction first. Sign the 139-byte approval transcript with account ID, approval nonce, host key, and phone key. Post exact code/key/signature tuple (`web/src/components/hosts/connect-host.tsx:218-309`).
8. **Phone verifies response.** Require returned host key, phone/browser key, approval nonce, and fingerprints to exactly match the pending state and identity; also require that the locally captured authenticated account/origin has not changed (the approval response does not repeat account ID). If `host_id` is non-null, bind it to the already-persisted key in a transaction; it is null on first pairing because the daemon poll creates the Host row later. On request failure retain a safe pin/tombstone state and offer retry, never approve a different pending tuple.
9. **Server consumes ceremony.** It verifies phone registration/active status, exact pending tuple, approval signature, and ownership before marking approved (`server/spawn_server/routes/device.py:670-788`). A code is single-ceremony state; expired/used/wrong-account values must not be resumed silently.
10. **Daemon polls and verifies again.** Polling continues at the supplied interval (`daemon/src/login.rs:100-164`). The approved response contains access token, host/browser/account binding, and proof (`server/spawn_server/routes/device.py:610-625`; `server/spawn_server/schemas.py:332-417`). Daemon independently verifies the browser approval before persisting it (`daemon/src/login.rs:178-217`).
11. **Mutual comparison.** Daemon prints the approving browser fingerprint (`daemon/src/login.rs:318-321`). Phone shows success only after the approval response, tells the user to compare that fingerprint, and refreshes host state until the host row/control connection appears.

The exact ceremony endpoints share the router prefix declared at `server/spawn_server/routes/device.py:23`:

```text
POST /api/auth/device/start       daemon creates code/nonce
POST /api/auth/device/possession  daemon proves host-key possession
POST /api/auth/device/poll        daemon polls for approval/token
POST /api/auth/device/pending     authenticated phone resolves human code
POST /api/auth/device/approve     authenticated phone posts signed approval
```

The endpoint declarations are at `server/spawn_server/routes/device.py:88-93`, `server/spawn_server/routes/device.py:152-153`, `server/spawn_server/routes/device.py:235`, `server/spawn_server/routes/device.py:658-659`, and `server/spawn_server/routes/device.py:670-671`.

The concrete request/response fields are (`server/spawn_server/schemas.py:221-317`, `server/spawn_server/schemas.py:332-417`):

```ts
type DeviceStartRequest = {
  host_name: string;                 // max 128
  os?: string | null;
  arch?: string | null;
  version?: string | null;
  host_key_algorithm: "ed25519";
  host_public_key: string;           // exactly 43 base64url characters
};
type DeviceStartResponse = {
  device_code: string;
  user_code: string;
  approval_nonce: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
};

type DevicePossessionRequest = {
  device_code: string;
  approval_nonce: string;
  host_key_algorithm: "ed25519";
  host_public_key: string;
  signature: string;                 // exactly 86 base64url characters
};
type DevicePossessionResponse = { verified: true; version: 1 };

type DevicePendingRequest = { user_code: string };
type DevicePendingResponse = {
  host_name: string;
  approval_nonce: string;
  host_key_algorithm: "ed25519";
  host_public_key: string;
  host_key_fingerprint: string;
};

type DeviceApproveRequest = DevicePendingRequest & {
  approval_nonce: string;
  host_key_algorithm: "ed25519";
  host_public_key: string;
  host_key_fingerprint: string;
  browser_device_id: string;         // canonical lowercase UUID
  browser_key_algorithm: "ed25519";
  browser_public_key: string;
  browser_key_fingerprint: string;
  signature: string;
};
type DeviceApproveResponse = {
  host_name: string;
  approval_nonce: string;
  host_key_algorithm: "ed25519";
  host_public_key: string;
  host_key_fingerprint: string;
  browser_device_id: string;
  browser_key_algorithm: "ed25519";
  browser_public_key: string;
  browser_key_fingerprint: string;
  host_id: string | null;            // null on first pair; non-null on re-pair
};
```

The daemon's poll success adds `access_token`, non-null `host_id`, host/browser keys and fingerprints, `browser_device_id`, plus current `account_id` and `browser_approval_signature`; pending errors are `authorization_pending`, `slow_down`, `expired_token`, `denied`, `invalid_device_binding`, `key_conflict`, `pin_conflict`, or `pin_limit` (`server/spawn_server/schemas.py:289-329`).

The phone's possession in this flow is its already registered Ed25519 key; authentication alone is insufficient. It must never send the device seed to server/daemon or accept a server-supplied replacement phone public key.

### Re-pairing and already-paired hosts

For an already-paired host, a new phone has three legitimate paths:

- receive a bidirectional endorsement from a device already trusted by that host;
- in an installed EAS build, import host pins via passkey PRF and still receive daemon endorsement;
- run daemon login again and directly pair/reapprove the phone using the manual code.

The server account's host list by itself is not a pin ceremony. A phone may display an untrusted host as needing setup, but must not open its terminal until an active exact host pin and daemon-side phone trust both exist.

The daemon retains trusted-browser proofs and can reverify them rather than trusting deserialized booleans (`daemon/src/creds.rs:1855-1894`). Logout removes daemon credentials (`daemon/src/creds.rs:1452-1470`); a host that has lost its identity must appear as a different host key and require explicit replacement approval.

**RECOMMEND:** Keep code entry as the initial native implementation. Adding QR is a new protocol/UI feature because no canonical QR payload/version/domain-binding exists. If later added, QR should encode the same server origin plus user code—not bypass pending lookup, fingerprint display, or explicit approval.

## 10. Registration, revocation, and endorsement API behavior

The browser registration client exposes list/register/revoke/rename/prune functions and exact JSON shapes (`web/src/lib/api.ts:392-469`, `web/src/lib/api.ts:584-619`). Native should share these server endpoints rather than create mobile variants:

```text
GET    /api/browser-devices
POST   /api/browser-devices/register
POST   /api/browser-devices/prune
PATCH  /api/browser-devices/{device_id}
POST   /api/browser-devices/{device_id}/revoke
```

Registration request contains label, Ed25519 key algorithm/public key, and the possession signature. The transcript itself fixes version 1; there is no separate request `signature_algorithm` or version field. The server:

- derives the account from authenticated request state;
- parses canonical key/signature;
- reconstructs registration transcript;
- strict-verifies proof;
- enforces cross-account key uniqueness;
- returns an existing same-account active device idempotently;
- rejects an existing revoked device while its row exists.

(`server/spawn_server/routes/browser_devices.py:20-102`). List is account-scoped (`server/spawn_server/routes/browser_devices.py:105-121`). Revocation sets `revoked_at`, propagates to relevant daemons, and prevents further device use (`server/spawn_server/routes/browser_devices.py:148-213`). Rename changes display metadata only (`server/spawn_server/routes/browser_devices.py:216-242`).

The exact JSON shapes forbid extra fields (`server/spawn_server/schemas.py:67-115`):

```ts
type BrowserDeviceRegisterRequest = {
  label?: string | null;             // max 64
  key_algorithm: "ed25519";
  public_key: string;                // exactly 43 canonical base64url chars
  signature: string;                 // exactly 86 canonical base64url chars
};
type BrowserDeviceOut = {
  id: string;
  key_algorithm: "ed25519";
  public_key: string;
  fingerprint: string;
  label?: string | null;
  created_at: string;
  revoked_at?: string | null;
};
type BrowserDeviceRevokeRequest = { expected_public_key: string };
type BrowserDeviceRenameRequest = { label?: string | null };
type BrowserDevicePruneResponse = { pruned: number };
```

Self-revocation on phone must follow server-first semantics. If the server call is temporarily unreachable, keep the identity but put the UI in `revocation-pending`, disable generic terminal actions for that account, and retry. Deleting the only local key before server revocation would strand a still-authorized key with no way to sign the revoke flow and would make server state ambiguous.

Endorsement endpoints are listed in section 6. Introduction acceptance must verify all five transcript-bound values and signature locally before writing pins. A server “accepted” flag is not proof.

## 11. Failure policy and state machines

### Device identity states

```text
absent
  └─ explicit setup ─> generating ─> stored-unregistered
stored-unregistered
  └─ signed registration accepted/exactly revalidated ─> active
active
  ├─ server revoke begins ─> revocation-pending
  └─ corruption/key mismatch ─> storage-failed (fail closed)
revocation-pending
  └─ server confirms ─> locally-revoked marker + compare/delete key
locally-revoked
  └─ explicit “start fresh” ─> absent
```

No automatic edge goes from revoked/storage-failed to generating. Re-authentication does not change trust state. An account mismatch in the SecureStore record is corruption, never a migration opportunity.

### Host trust states

```text
unseen -> pending-comparison -> active pin
active pin -> explicit local revoke -> revoked tombstone
active pin + different presented key -> substituted/blocked
revoked tombstone + exact explicit reapproval -> active pin
store read/validation failure -> unavailable/blocked
```

Do not collapse `unseen`, `revoked`, `substituted`, and `store unavailable` into one “connect anyway” screen. The distinction is part of the security UX.

### Endorsement states

```text
server introduction
  -> exact parse
  -> strict endorser/key/signature verification
  -> human endorser-fingerprint comparison
  -> transactional pin acceptance
  -> server acknowledgement/deletion
```

If acknowledgement fails after a committed pin, retry the idempotent acknowledgement; do not undo a correctly verified pin or re-prompt fingerprint comparison unnecessarily. If the introduction changes between fetch and accept, restart verification.

### Error classes

The trust package should use typed non-secret codes:

```ts
type TrustErrorCode =
  | "IDENTITY_ABSENT"
  | "IDENTITY_REVOKED"
  | "IDENTITY_CORRUPT"
  | "IDENTITY_STORAGE_UNAVAILABLE"
  | "REGISTRATION_REJECTED"
  | "PIN_ABSENT"
  | "PIN_REVOKED"
  | "PIN_SUBSTITUTED"
  | "PIN_STORAGE_UNAVAILABLE"
  | "HOST_IDENTITY_WITHHELD"
  | "ENDORSEMENT_INVALID"
  | "SIGNAL_INVALID"
  | "PASSKEY_PRF_UNAVAILABLE"
  | "TRUST_BUNDLE_ROLLBACK"
  | "PAIRING_EXPIRED"
  | "PAIRING_MISMATCH";
```

Errors may carry safe UI fields such as expected/presented fingerprints and expiry, but never the seed, PRF result, derived keys, plaintext bundle, raw SDP, or protected payload.

## 12. Native trust module shape

### Directory/module boundaries

**RECOMMEND:** Ship one platform-neutral `mobile/src/trust/` package plus narrow storage/passkey adapters. Keep React components outside it. This lets Node tests run the same byte logic as Hermes.

```text
mobile/src/platform/crypto-bootstrap.ts        global RNG bridge; imported first
mobile/src/trust/bytes.ts                      strict UTF-8/base64url/UUID/concat
mobile/src/trust/ed25519.ts                    noble setup and strict sign/verify
mobile/src/trust/transcripts/registration.ts
mobile/src/trust/transcripts/host-pair.ts
mobile/src/trust/transcripts/endorsement.ts
mobile/src/trust/transcripts/signed-signal.ts
mobile/src/trust/device-identity.ts             bounded identity capabilities
mobile/src/trust/device-registration.ts         register/revoke/fresh state machine
mobile/src/trust/host-pins.ts                    platform-neutral pin rules
mobile/src/trust/host-pin-store.sqlite.ts        Expo SQLite adapter
mobile/src/trust/endorsements.ts                 fetch/verify/accept
mobile/src/trust/rtc-trust.ts                    sign/verify/gate SDP
mobile/src/trust/trust-bundle.ts                 canonical bundle + envelope
mobile/src/trust/passkey-prf.port.ts             unsupported-Go / later EAS adapter
mobile/src/trust/host-pairing.ts                 manual code state machine
mobile/src/trust/trust-errors.ts                 typed redacted errors
```

### Core byte and crypto exports

```ts
export function encodeUtf8Strict(value: string): Uint8Array;
export function decodeUtf8Strict(value: Uint8Array): string;
export function encodeBase64Url(value: Uint8Array): string;
export function decodeBase64UrlExact(value: string, length: number): Uint8Array;
export function parseCanonicalUuid(value: string): string;
export function uuidToBytes(value: string): Uint8Array;
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array;

export function randomBytes(length: number): Uint8Array;
export function sha256Bytes(value: Uint8Array): Uint8Array;
export function fingerprintEd25519(publicKeyWire: string): string;
export function deriveEd25519PublicKey(seed32: Uint8Array): Uint8Array;
export function assertStrictEd25519PublicKey(publicKey32: Uint8Array): void;
export function signPureEd25519(
  seed32: Uint8Array,
  message: Uint8Array,
): Uint8Array;
export function verifyPureEd25519Strict(
  publicKey32: Uint8Array,
  message: Uint8Array,
  signature64: Uint8Array,
): boolean;
```

`randomBytes` rejects non-integer/out-of-range lengths and delegates only to Expo Crypto. `decodeBase64UrlExact` rejects padding, whitespace, `+`, `/`, wrong character count/decoded length, and any input whose re-encoding differs. `parseCanonicalUuid` rejects uppercase and alternate textual forms rather than normalizing transcript input.

### Transcript exports

```ts
export function encodeBrowserRegistrationV1(input: {
  accountId: string;
  browserPublicKey: string;
}): Uint8Array;

export function encodeHostPairApprovalV1(input: {
  accountId: string;
  approvalNonce: string;
  hostPublicKey: string;
  browserPublicKey: string;
}): Uint8Array;

export function encodeHostPairPossessionV1(input: {
  deviceCode: string;       // base64url bytes, not human user code
  approvalNonce: string;
  hostPublicKey: string;
}): Uint8Array;

export function encodeBrowserEndorsementV1(input: {
  accountId: string;
  hostPublicKey: string;
  endorserPublicKey: string;
  endorsedPublicKey: string;
  endorsedDeviceId: string;
}): Uint8Array;

export function encodeSignedSignalV2(input: {
  type: "rtc.offer" | "rtc.answer";
  protocolVersion: number;
  sessionId: string;
  scopeType: "session" | "host";
  scopeId: string;
  senderRole: "browser" | "daemon";
  intendedPeerPublicKey: string;
  sdp: string;
}): Uint8Array;
```

Magic/version bytes are constants internal to these modules; callers cannot supply them. Each function enforces its own exact byte limit before allocation.

### Device identity exports

```ts
export interface NativeDeviceIdentity {
  readonly accountId: string;
  readonly publicKeyWire: string;
  readonly fingerprint: string;

  createRegistrationProof(): Promise<string>;
  createHostPairApprovalProof(input: {
    approvalNonce: string;
    hostPublicKey: string;
  }): Promise<string>;
  createEndorsementProof(input: {
    hostPublicKey: string;
    endorsedPublicKey: string;
    endorsedDeviceId: string;
  }): Promise<string>;
  signRtcSignal(input: UnsignedRtcSignal): Promise<SignedRtcSignal>;
}

export function loadDeviceIdentity(
  accountId: string,
): Promise<NativeDeviceIdentity | null>;

export function loadOrCreateDeviceIdentity(
  accountId: string,
): Promise<NativeDeviceIdentity>;

export function deleteDeviceIdentityIfMatches(
  accountId: string,
  expectedPublicKeyWire: string,
): Promise<boolean>;
```

There is intentionally no `getSeed`, `export`, `import`, or `sign(message)` export. Each bounded method reconstructs its own transcript from typed input, loads/validates seed, signs, re-verifies, zeroes buffers, and returns only canonical signature/public metadata.

### Registration exports

```ts
export interface RegisteredBrowserDevice {
  id: string;
  label: string | null;
  keyAlgorithm: "ed25519";
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  revokedAt: string | null;
}

export function ensureDeviceRegistered(input: {
  accountId: string;
  label: string;
  identity: NativeDeviceIdentity;
  api: TrustApi;
}): Promise<RegisteredBrowserDevice>;

export function revokeThisDevice(input: {
  accountId: string;
  deviceId: string;
  identity: NativeDeviceIdentity;
  api: TrustApi;
}): Promise<void>;

export function explicitlyStartFresh(accountId: string): Promise<void>;
```

`ensureDeviceRegistered` requires exact returned-key equality. `revokeThisDevice` server-revokes before marker/delete. `explicitlyStartFresh` requires a locally revoked marker or separately confirmed recovery UX; it cannot be called as registration error recovery.

### Host pin exports

```ts
export type HostPinState = "active" | "revoked";

export interface HostPin {
  accountId: string;
  serverOrigin: string;
  hostPublicKey: string;
  hostFingerprint: string;
  hostIds: readonly string[];
  state: HostPinState;
  createdAtMs: number;
  approvedAtMs: number;
  revokedAtMs: number | null;
}

export interface HostPinStore {
  approveExact(input: HostPinApproval): Promise<HostPin>;
  bindHostId(input: HostIdBinding): Promise<HostPin>;
  resolveByHostId(input: HostPinLookup): Promise<HostPin>;
  resolveByPublicKey(input: HostKeyLookup): Promise<HostPin | null>;
  revokeExact(input: HostKeyLookup): Promise<void>;
  list(accountId: string, serverOrigin: string): Promise<readonly HostPin[]>;
}

export function openHostPinStore(): Promise<HostPinStore>;
```

The store implementation owns transactions/bounds and throws typed unavailable/corrupt/conflict errors. No caller receives raw SQL access.

### Endorsement and RTC exports

```ts
export function verifyEndorsementIntroduction(input: {
  accountId: string;
  hostPublicKey: string;
  endorserPublicKey: string;
  endorsedPublicKey: string;
  endorsedDeviceId: string;
  signature: string;
  expectedPhonePublicKey: string;
}): VerifiedEndorsement;

export function acceptVerifiedEndorsement(input: {
  endorsement: VerifiedEndorsement;
  expectedEndorserFingerprint: string;
  pinStore: HostPinStore;
  api: TrustApi;
}): Promise<HostPin>;

export function resolveRtcTrust(input: {
  accountId: string;
  serverOrigin: string;
  hostId: string;
  claimedHostPublicKey: string | null;
  phoneIdentity: NativeDeviceIdentity | null;
  pinStore: HostPinStore;
}): Promise<RtcTrustDecision>;

export function verifySignedRtcSignal(input: {
  envelope: unknown;
  expected: ExpectedRtcTopology;
  trustedSenderPublicKey: string;
}): VerifiedRtcSignal;
```

`VerifiedEndorsement` and `VerifiedRtcSignal` are opaque/branded results created only after cryptographic checks. The WebRTC adapter accepts only `VerifiedRtcSignal.sdp`, preventing accidental use of raw server JSON.

### Trust bundle and passkey port exports

```ts
export interface PasskeyPrfPort {
  isAvailable(): Promise<boolean>;
  createCredential(input: {
    accountId: string;
    displayName: string;
    challenge: Uint8Array;
  }): Promise<{ credentialId: string; prfResult: Uint8Array }>;
  evaluate(input: {
    credentialIds: readonly string[];
    challenge: Uint8Array;
  }): Promise<{ credentialId: string; prfResult: Uint8Array }>;
}

export class UnsupportedExpoGoPasskeyPort implements PasskeyPrfPort {
  isAvailable(): Promise<false>;
  createCredential(): Promise<never>;
  evaluate(): Promise<never>;
}

export function sealTrustEnvelopeV2(input: {
  bundle: TrustBundleV1;
  wraps: readonly PrfWrapInput[];
}): string; // canonical base64url of the outer envelope JSON bytes

export function openTrustEnvelopeV2(input: {
  envelope: string;
  accountId: string;
  credentialId: string;
  prfResult: Uint8Array;
  minimumRevision: number;
}): TrustBundleV1;
```

The passkey adapter, not UI code, owns WebAuthn challenge/request mapping. All PRF result buffers are zeroed by the caller in `finally`. Bundle open commits a higher revision floor and pins transactionally only after complete authentication/schema/account/revision validation.

### Host pairing exports

```ts
export type HostPairingState =
  | { kind: "idle" }
  | { kind: "loading"; userCode: string }
  | { kind: "pending"; ceremony: VerifiedPendingHostPair }
  | { kind: "approving"; ceremony: VerifiedPendingHostPair }
  | { kind: "approved"; hostId: string | null; hostPublicKey: string }
  | { kind: "expired" }
  | { kind: "failed"; error: TrustError };

export interface HostPairingController {
  getState(): HostPairingState;
  lookup(userCode: string): Promise<VerifiedPendingHostPair>;
  approve(input: {
    ceremony: VerifiedPendingHostPair;
    identity: NativeDeviceIdentity;
    pinStore: HostPinStore;
  }): Promise<{ hostId: string | null; hostPublicKey: string }>;
  cancel(): void;
}
```

`VerifiedPendingHostPair` is an exact immutable snapshot including account, origin, approval nonce, host key/fingerprint, code, and expiry. `approve` refuses a stale snapshot and persists the pin before signing/posting.

### Durable key names

| Store | Key / table | Value |
|---|---|---|
| SecureStore | `spawn.identity.ed25519.v1.<accountId>` | Versioned seed/public record |
| SecureStore service | `spawn.trust.identity.v1` | Stable Keychain service, this-device-only |
| SQLite DB | `spawn-trust.db` | Public trust state only |
| SQLite | `host_pins` | Active pins and tombstones |
| SQLite | `trust_revisions` keyed by account | Monotonic bundle floor |
| SQLite | `device_revocations` keyed by account | Local revoked marker/public key/status |
| SQLite | `browser_device_metadata` keyed by account+origin | Server device ID/label/public fields |
| SQLite optional | `sealed_trust_envelopes` keyed by account | Opaque bounded ciphertext only |

Do not put mutable server origin into the SecureStore seed key/service. One account key is reusable only for that same account across configured origins if product policy explicitly allows it; current browser identity is keyed by account ID. Origin scoping remains mandatory for host pins.

### Self-test plan using repository fixtures

Tests must run in the ordinary Node unit-test process and import platform-neutral trust code. Inject a deterministic test RNG only into envelope tests; production modules must bind Expo Crypto and reject test adapters in release builds.

#### Transcript/vector suite

1. Load `proto/browser-device-registration-v1-vectors.json`.
2. Encode each case; assert exact `transcript_hex`, byte length, diagnostic SHA-256, public derivation where seed is present, signature generation where seed is present, and strict verification.
3. Load `proto/host-pair-approval-v1-vectors.json`; repeat exact byte/hash/signature assertions.
4. Load `proto/host-pair-possession-v1-vectors.json`; derive the RFC seed public key, assert exact transcript/hash/signature, and verify.
5. Load `proto/signed-signal-v1-vectors.json`; assert current revision-2 transcript hex/hash/signature for every offer/answer vector.
6. Load `proto/signed-signal-wire-v1-vectors.json`; exact-parse valid JSON and reject every wrong topology/field/type/role/scope/peer mutation.
7. Add a local test for the endorsement test example's exact SHA-256 until a shared `proto/browser-endorsement-v1-vectors.json` exists.

#### Strict-key suite

For every case in `proto/ed25519-public-key-negative-vectors.json`:

- require weak, noncanonical, and off-curve keys to throw in `assertStrictEd25519PublicKey`;
- require accepted mixed-torsion controls to pass point validation;
- require universal-forgery signatures to fail strict verification;
- verify behavior is identical under Node and Hermes/Expo smoke tests.

#### Parser mutation suite

For every transcript/wire fixture mutate one condition at a time:

- magic/version, every UUID byte/text form, integer byte order/bounds;
- missing/extra/reordered JSON fields;
- base64url padding, standard alphabet, whitespace, noncanonical alternate strings, truncation/extension;
- UTF-8 invalid bytes, unpaired UTF-16 surrogate input, embedded NUL, SDP over 1 MiB;
- role/kind/protocol/scope/session/host/intended-peer mismatch;
- public key/signature length and every signature bit.

All must fail before any storage commit or WebRTC remote-description call.

#### Identity/storage suite

- load absent → create exactly one 32-byte seed → reread/derive/self-test;
- two concurrent `loadOrCreate` calls return the same public key;
- wrong account/version/extra/missing JSON field, noncanonical seed/key, derived-key mismatch, SecureStore failure, and self-test failure all fail closed;
- ordinary logout retains identity; explicit confirmed revoke writes marker and compare-deletes; stale expected key cannot delete a different record;
- simulated reinstall/keychain-survival loads the existing record;
- no test snapshot/log contains the seed.

#### Pin/revision suite

- account/origin/key isolation and exact HTTP(S) origin validation;
- fingerprint recomputation; host-ID de-duplication/bounds/conflict rejection;
- active/revoked transitions, tombstone persistence, explicit exact reactivation;
- different presented key blocks without modifying existing pin;
- corrupt/unreadable DB produces unavailable, never unpinned TOFU;
- 256-record and 8-host-ID boundaries;
- trust revision monotonic update and rollback rejection in one transaction;
- endorsement acceptance preserves pre-existing revoked tombstones.

#### Envelope suite

- port any existing trust-bundle/envelope web test fixtures verbatim where available;
- fixed key/IV/AAD plaintext produces exact `IV || ciphertext || tag` bytes across web/native Node implementation;
- open succeeds for the matching account/credential/revision and fails for each altered byte/AAD/credential/account;
- wrap enrollment/revocation rotates data key and increments revision;
- key/PRF buffers are zeroed on success and every error path;
- canonical JSON sorting/duplicate/limit tests match web bounds.

#### Pairing/state-machine suite

- pending response exact key/nonce/account/origin/expiry validation;
- pin transaction occurs before approval POST;
- approval signature matches shared vector logic;
- changed response tuple, expired/used code, revoked phone, server rejection, network retry, and cancel all remain fail closed;
- successful response binds host ID only to the pinned exact key;
- no QR/noncanonical code path bypasses comparison/approval.

#### Device smoke tests after unit parity

The hard Expo Go acceptance pass on a physical iPhone should verify:

1. SecureStore identity survives app reload and logout.
2. Registration is idempotent and the server lists the same fingerprint.
3. Direct manual host pairing succeeds with mutual fingerprint display.
4. Substituted host key and corrupted local pin row block before WebRTC.
5. Trusted-device endorsement makes the phone usable on another already-paired host.
6. Terminal RTC offer/answer signatures verify on both daemon and phone.
7. Revoking the phone disconnects/refuses new sessions; explicit fresh start gets a new fingerprint.
8. Trust settings clearly mark Passkey PRF unavailable in Expo Go and route to endorsement/pairing.

## 13. Decisions the orchestrator must carry into implementation plans

1. Approve the Expo Go passkey limitation and an optional later EAS `react-native-passkey@3.6.1` adapter; no compliant Expo Go PRF exists.
2. Schedule a server fix/test for prune versus permanent browser-key revocation tombstones.
3. Schedule a shared browser-endorsement signing vector; current test has only transcript/hash data.
4. Treat recovery-archive Argon2id on native as unresolved and do not claim it in the Expo Go build.
5. Preserve direct manual pairing and bidirectional endorsement as mandatory bootstrap/recovery; account login and trust-bundle import alone are not host authorization.
6. Accept the documented native security delta: Keychain protects the seed at rest, but Hermes briefly sees extractable bytes because Expo Go has no non-extractable Ed25519 handle.
