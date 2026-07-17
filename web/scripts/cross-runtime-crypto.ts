import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import negativeKeysJson from "../../proto/ed25519-public-key-negative-vectors.json";

import {
  encodeBrowserDeviceRegistrationTranscript,
  verifyBrowserDeviceRegistrationProof,
} from "../src/lib/browser-device-registration-transcript";
import {
  encodeHostPairApprovalTranscript,
  verifyHostPairApprovalProof,
} from "../src/lib/host-pair-approval-transcript";
import {
  decodeBase64Url,
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  encodeBase64Url,
  encodeSignedSignalTranscript,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  importEd25519PublicKeyWire,
  signSignedSignalTranscript,
  type SignedSignalTranscript,
  verifySignedSignalTranscript,
} from "../src/lib/signed-signal";
import {
  signRtcSignalWire,
  verifyRtcSignalWire,
} from "../src/lib/signed-signal-wire";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const rustArgs = [
  "run",
  "--quiet",
  "--locked",
  "--manifest-path",
  "daemon/Cargo.toml",
  "--bin",
  "cross-runtime-crypto",
  "--",
];
const dtlsFingerprint =
  "9A:61:07:51:B5:42:4C:95:2B:7A:57:3D:CD:0C:12:F8:72:91:4B:72:21:6F:4B:47:9E:AC:85:F1:42:19:21:AD";

interface ExchangeArtifact {
  producer: "rust" | "webcrypto";
  browser_public_key: string;
  host_public_key: string;
  browser_key_fingerprint: string;
  host_key_fingerprint: string;
  exact_sdp: string;
  invalid_identifiers: string[];
  invalid_intended_peer_public_keys: string[];
  accepted_intended_peer_public_keys: string[];
  signal: SignalArtifact;
  wire: WireArtifact;
  registration: RegistrationArtifact;
  host_pair: HostPairArtifact;
}

interface SignalArtifact {
  signal_kind: "offer";
  protocol_version: number;
  session_id: string;
  scope_type: "agent";
  scope_id: string;
  sender_role: "browser";
  intended_peer_public_key: string;
  sdp: string;
  canonical_bytes: string;
  canonical_sha256: string;
  signature: string;
}

interface WireArtifact {
  envelope: string;
  envelope_sha256: string;
}

interface RegistrationArtifact {
  user_id: string;
  browser_public_key: string;
  canonical_bytes: string;
  canonical_sha256: string;
  signature: string;
}

interface HostPairArtifact {
  user_id: string;
  approval_nonce: string;
  host_public_key: string;
  browser_public_key: string;
  canonical_bytes: string;
  canonical_sha256: string;
  signature: string;
}

interface NegativeKeyVector {
  public_key_hex: string;
}

interface NegativeKeyCorpus {
  weak_public_keys: NegativeKeyVector[];
  noncanonical_public_key_hex: string[];
  invalid_encodings: NegativeKeyVector[];
  accepted_mixed_torsion_public_key_hex: string[];
}

const negativeKeys = negativeKeysJson as NegativeKeyCorpus;

function rust(command: "produce" | "verify", input?: string): string {
  const result = spawnSync("cargo", [...rustArgs, command], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Rust ${command} failed (${result.status ?? "signal"}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error("invalid shared Ed25519 corpus hex");
  }
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function intendedPeerKeyCorpus(): { accepted: string[]; invalid: string[] } {
  const invalidHex = [
    ...negativeKeys.weak_public_keys.map((vector) => vector.public_key_hex),
    ...negativeKeys.noncanonical_public_key_hex,
    ...negativeKeys.invalid_encodings.map((vector) => vector.public_key_hex),
  ];
  return {
    accepted: negativeKeys.accepted_mixed_torsion_public_key_hex.map((value) =>
      encodeBase64Url(hexToBytes(value)),
    ),
    invalid: invalidHex.map((value) => encodeBase64Url(hexToBytes(value))),
  };
}

function assertEqual(field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${field} mismatch`);
}

async function sha256Wire(value: Uint8Array): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(value))),
  );
}

async function keyFingerprint(publicKeyWire: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      ownedBuffer(decodeEd25519PublicKeyWire(publicKeyWire)),
    ),
  );
  return `SHA256:${encodeBase64Url(digest.slice(0, 12))}`;
}

function exactSdp(hostFingerprint: string, browserFingerprint: string): string {
  return `v=0\r\no=spawn 424242 2 IN IP4 127.0.0.1\r\ns=spawn cross-runtime\r\nt=0 0\r\na=fingerprint:sha-256 ${dtlsFingerprint}\r\na=x-spawn-host-key-fingerprint:${hostFingerprint}\r\na=x-spawn-browser-key-fingerprint:${browserFingerprint}\r\n`;
}

function transcriptFrom(artifact: SignalArtifact): SignedSignalTranscript {
  return {
    signalKind: artifact.signal_kind,
    protocolVersion: artifact.protocol_version,
    sessionId: artifact.session_id,
    scopeType: artifact.scope_type,
    scopeId: artifact.scope_id,
    senderRole: artifact.sender_role,
    intendedPeerPublicKey: decodeEd25519PublicKeyWire(
      artifact.intended_peer_public_key,
    ),
    sdp: artifact.sdp,
  };
}

async function verifyRustArtifact(artifact: ExchangeArtifact): Promise<void> {
  assertEqual("producer", artifact.producer, "rust");
  assertEqual(
    "browser fingerprint",
    artifact.browser_key_fingerprint,
    await keyFingerprint(artifact.browser_public_key),
  );
  assertEqual(
    "host fingerprint",
    artifact.host_key_fingerprint,
    await keyFingerprint(artifact.host_public_key),
  );
  const expectedSdp = exactSdp(
    artifact.host_key_fingerprint,
    artifact.browser_key_fingerprint,
  );
  assertEqual("exact SDP", artifact.exact_sdp, expectedSdp);
  assertEqual("signal SDP", artifact.signal.sdp, expectedSdp);
  assertEqual(
    "signal intended peer",
    artifact.signal.intended_peer_public_key,
    artifact.host_public_key,
  );
  for (const invalid of artifact.invalid_identifiers) {
    let rejectedSession = false;
    try {
      encodeSignedSignalTranscript({
        ...transcriptFrom(artifact.signal),
        sessionId: invalid,
      });
    } catch {
      rejectedSession = true;
    }
    if (!rejectedSession)
      throw new Error(
        `WebCrypto accepted noncanonical session UUID ${invalid}`,
      );
    let rejectedScope = false;
    try {
      encodeSignedSignalTranscript({
        ...transcriptFrom(artifact.signal),
        scopeId: invalid,
      });
    } catch {
      rejectedScope = true;
    }
    if (!rejectedScope)
      throw new Error(`WebCrypto accepted noncanonical scope UUID ${invalid}`);
  }
  assertEqual(
    "invalid intended-peer corpus size",
    artifact.invalid_intended_peer_public_keys.length,
    49,
  );
  assertEqual(
    "accepted intended-peer corpus size",
    artifact.accepted_intended_peer_public_keys.length,
    7,
  );
  for (const invalid of artifact.invalid_intended_peer_public_keys) {
    let rejected = false;
    try {
      encodeSignedSignalTranscript({
        ...transcriptFrom(artifact.signal),
        intendedPeerPublicKey: decodeBase64Url(
          invalid,
          ED25519_PUBLIC_KEY_BYTES,
        ),
      });
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw new Error(
        "WebCrypto accepted exchanged invalid intended-peer point",
      );
  }
  for (const accepted of artifact.accepted_intended_peer_public_keys) {
    encodeSignedSignalTranscript({
      ...transcriptFrom(artifact.signal),
      intendedPeerPublicKey: decodeBase64Url(
        accepted,
        ED25519_PUBLIC_KEY_BYTES,
      ),
    });
  }

  const transcript = transcriptFrom(artifact.signal);
  const transcriptBytes = encodeSignedSignalTranscript(transcript);
  assertEqual(
    "signed-signal bytes",
    artifact.signal.canonical_bytes,
    encodeBase64Url(transcriptBytes),
  );
  assertEqual(
    "signed-signal hash",
    artifact.signal.canonical_sha256,
    await sha256Wire(transcriptBytes),
  );
  const browserKey = await importEd25519PublicKeyWire(
    artifact.browser_public_key,
  );
  if (
    !(await verifySignedSignalTranscript(
      browserKey,
      transcript,
      artifact.signal.signature,
    ))
  ) {
    throw new Error("WebCrypto rejected the Rust signed-signal signature");
  }

  assertEqual(
    "wire hash",
    artifact.wire.envelope_sha256,
    await sha256Wire(new TextEncoder().encode(artifact.wire.envelope)),
  );
  const verifiedWire = await verifyRtcSignalWire(
    artifact.wire.envelope,
    artifact.browser_public_key,
    artifact.host_public_key,
  );
  assertEqual(
    "wire sender",
    verifiedWire.senderPublicKeyWire,
    artifact.browser_public_key,
  );
  assertEqual("wire protocol", verifiedWire.protocol, "spawn.pty");
  assertEqual(
    "wire session",
    verifiedWire.transcript.sessionId,
    transcript.sessionId,
  );
  assertEqual(
    "wire scope",
    verifiedWire.transcript.scopeId,
    transcript.scopeId,
  );
  assertEqual("wire SDP", verifiedWire.transcript.sdp, expectedSdp);

  assertEqual(
    "registration browser key",
    artifact.registration.browser_public_key,
    artifact.browser_public_key,
  );
  const registrationBytes = encodeBrowserDeviceRegistrationTranscript(
    artifact.registration.user_id,
    artifact.registration.browser_public_key,
  );
  assertEqual(
    "registration bytes",
    artifact.registration.canonical_bytes,
    encodeBase64Url(registrationBytes),
  );
  assertEqual(
    "registration hash",
    artifact.registration.canonical_sha256,
    await sha256Wire(registrationBytes),
  );
  if (
    !(await verifyBrowserDeviceRegistrationProof(
      artifact.registration.user_id,
      artifact.registration.browser_public_key,
      artifact.registration.signature,
    ))
  ) {
    throw new Error(
      "WebCrypto rejected the Rust browser-registration signature",
    );
  }

  assertEqual(
    "host-pair user",
    artifact.host_pair.user_id,
    artifact.registration.user_id,
  );
  assertEqual(
    "host-pair host key",
    artifact.host_pair.host_public_key,
    artifact.host_public_key,
  );
  assertEqual(
    "host-pair browser key",
    artifact.host_pair.browser_public_key,
    artifact.browser_public_key,
  );
  const hostPairBytes = encodeHostPairApprovalTranscript(
    artifact.host_pair.user_id,
    artifact.host_pair.approval_nonce,
    artifact.host_pair.host_public_key,
    artifact.host_pair.browser_public_key,
  );
  assertEqual(
    "host-pair bytes",
    artifact.host_pair.canonical_bytes,
    encodeBase64Url(hostPairBytes),
  );
  assertEqual(
    "host-pair hash",
    artifact.host_pair.canonical_sha256,
    await sha256Wire(hostPairBytes),
  );
  if (
    !(await verifyHostPairApprovalProof(
      artifact.host_pair.user_id,
      artifact.host_pair.approval_nonce,
      artifact.host_pair.host_public_key,
      artifact.host_pair.browser_public_key,
      artifact.host_pair.signature,
    ))
  ) {
    throw new Error("WebCrypto rejected the Rust host-pair signature");
  }
}

async function rawSignature(
  privateKey: CryptoKey,
  transcript: Uint8Array,
): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        ownedBuffer(transcript),
      ),
    ),
  );
}

async function produceWebCryptoArtifact(): Promise<ExchangeArtifact> {
  const browserKey = await generateEd25519IdentityKeyPair();
  const hostKey = await generateEd25519IdentityKeyPair();
  const browserPublicKey = await exportEd25519PublicKeyWire(
    browserKey.publicKey,
  );
  const hostPublicKey = await exportEd25519PublicKeyWire(hostKey.publicKey);
  const browserFingerprint = await keyFingerprint(browserPublicKey);
  const hostFingerprint = await keyFingerprint(hostPublicKey);
  const sdp = exactSdp(hostFingerprint, browserFingerprint);
  const transcript: SignedSignalTranscript = {
    signalKind: "offer",
    protocolVersion: 2,
    sessionId: crypto.randomUUID(),
    scopeType: "agent",
    scopeId: crypto.randomUUID(),
    senderRole: "browser",
    intendedPeerPublicKey: decodeEd25519PublicKeyWire(hostPublicKey),
    sdp,
  };
  const signalBytes = encodeSignedSignalTranscript(transcript);
  const signalSignature = await signSignedSignalTranscript(
    browserKey.privateKey,
    transcript,
  );
  const envelope = await signRtcSignalWire(
    {
      publicKeyWire: browserPublicKey,
      sign: (value) => signSignedSignalTranscript(browserKey.privateKey, value),
    },
    { protocol: "spawn.pty", transcript },
  );

  const userId = crypto.randomUUID();
  const registrationBytes = encodeBrowserDeviceRegistrationTranscript(
    userId,
    browserPublicKey,
  );
  const approvalNonce = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const hostPairBytes = encodeHostPairApprovalTranscript(
    userId,
    approvalNonce,
    hostPublicKey,
    browserPublicKey,
  );
  const intendedPeerKeys = intendedPeerKeyCorpus();
  return {
    producer: "webcrypto",
    browser_public_key: browserPublicKey,
    host_public_key: hostPublicKey,
    browser_key_fingerprint: browserFingerprint,
    host_key_fingerprint: hostFingerprint,
    exact_sdp: sdp,
    invalid_identifiers: [
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
      "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}",
      " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ",
      "not-a-uuid-not-a-uuid-not-a-uuid!!!",
    ],
    invalid_intended_peer_public_keys: intendedPeerKeys.invalid,
    accepted_intended_peer_public_keys: intendedPeerKeys.accepted,
    signal: {
      signal_kind: "offer",
      protocol_version: transcript.protocolVersion,
      session_id: transcript.sessionId,
      scope_type: "agent",
      scope_id: transcript.scopeId,
      sender_role: "browser",
      intended_peer_public_key: hostPublicKey,
      sdp,
      canonical_bytes: encodeBase64Url(signalBytes),
      canonical_sha256: await sha256Wire(signalBytes),
      signature: signalSignature,
    },
    wire: {
      envelope,
      envelope_sha256: await sha256Wire(new TextEncoder().encode(envelope)),
    },
    registration: {
      user_id: userId,
      browser_public_key: browserPublicKey,
      canonical_bytes: encodeBase64Url(registrationBytes),
      canonical_sha256: await sha256Wire(registrationBytes),
      signature: await rawSignature(browserKey.privateKey, registrationBytes),
    },
    host_pair: {
      user_id: userId,
      approval_nonce: approvalNonce,
      host_public_key: hostPublicKey,
      browser_public_key: browserPublicKey,
      canonical_bytes: encodeBase64Url(hostPairBytes),
      canonical_sha256: await sha256Wire(hostPairBytes),
      signature: await rawSignature(browserKey.privateKey, hostPairBytes),
    },
  };
}

const rustArtifact = JSON.parse(rust("produce")) as ExchangeArtifact;
await verifyRustArtifact(rustArtifact);
const webCryptoArtifact = await produceWebCryptoArtifact();
const rustVerification = rust("verify", JSON.stringify(webCryptoArtifact));
if (!rustVerification.includes("Rust verified WebCrypto artifacts")) {
  throw new Error("Rust verification did not emit its success marker");
}
console.log(
  "cross-runtime-crypto: passed fresh Rust <-> WebCrypto exchange for signed signal, signed wire, browser registration, and host pairing",
);
