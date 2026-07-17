import { describe, expect, test } from "bun:test";
import negativeKeysJson from "../../../proto/ed25519-public-key-negative-vectors.json";
import goldenJson from "../../../proto/signed-signal-v1-vectors.json";
import {
  decodeBase64Url,
  decodeSignedSignalTranscript,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_PUBLIC_KEY_WIRE_CHARS,
  ED25519_SIGNATURE_WIRE_CHARS,
  ed25519PublicKeyFingerprint,
  encodeBase64Url,
  encodeSignedSignalTranscript,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  importEd25519PublicKey,
  importEd25519PublicKeyWire,
  MAX_SCOPE_ID_BYTES,
  MAX_SDP_BYTES,
  MAX_SESSION_ID_BYTES,
  type ScopeType,
  type SenderRole,
  SIGNED_SIGNAL_MAGIC,
  type SignalKind,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";

interface GoldenVector {
  id: string;
  signal_kind: SignalKind;
  protocol_version: number;
  session_id: string;
  scope_type: ScopeType;
  scope_id: string;
  sender_role: SenderRole;
  intended_peer_public_key_hex: string;
  sdp: string;
  transcript_hex: string;
  sha256_hex: string;
  signature_hex: string;
  signature_wire: string;
  replay_signature_from: string;
}

interface GoldenFile {
  format: string;
  signing_key: {
    seed_hex: string;
    public_key_hex: string;
    public_key_wire: string;
  };
  intended_peer_key: {
    public_key_hex: string;
    public_key_wire: string;
  };
  mutation_fields: string[];
  vectors: GoldenVector[];
}

const golden = goldenJson as GoldenFile;
const mutatedSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef";
const mutatedScopeId = "11111111-2222-4333-8444-555555555556";

interface NegativeKeyVector {
  id: string;
  public_key_hex: string;
}

interface NegativeKeyFile {
  format: string;
  weak_public_keys: NegativeKeyVector[];
  noncanonical_public_key_hex: string[];
  invalid_encodings: NegativeKeyVector[];
  accepted_mixed_torsion_public_key_hex: string[];
  universal_forgery: {
    public_key_id: string;
    signature_hex: string;
  };
}

const negativeKeys = negativeKeysJson as NegativeKeyFile;

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) throw new Error("invalid test hex");
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function transcript(vector: GoldenVector): SignedSignalTranscript {
  return {
    signalKind: vector.signal_kind,
    protocolVersion: vector.protocol_version,
    sessionId: vector.session_id,
    scopeType: vector.scope_type,
    scopeId: vector.scope_id,
    senderRole: vector.sender_role,
    intendedPeerPublicKey: hexToBytes(vector.intended_peer_public_key_hex),
    sdp: vector.sdp,
  };
}

function mutate(original: SignedSignalTranscript, field: string): SignedSignalTranscript {
  const mutated: SignedSignalTranscript = {
    ...original,
    intendedPeerPublicKey: original.intendedPeerPublicKey.slice(),
  };
  switch (field) {
    case "signal_kind":
      mutated.signalKind = original.signalKind === "offer" ? "answer" : "offer";
      break;
    case "protocol_version":
      mutated.protocolVersion += 1;
      break;
    case "session_id":
      mutated.sessionId = mutatedSessionId;
      break;
    case "scope_type":
      mutated.scopeType = original.scopeType === "agent" ? "host" : "agent";
      break;
    case "scope_id":
      mutated.scopeId = mutatedScopeId;
      break;
    case "sender_role":
      mutated.senderRole = original.senderRole === "browser" ? "daemon" : "browser";
      break;
    case "intended_peer_public_key":
      mutated.intendedPeerPublicKey = hexToBytes(golden.signing_key.public_key_hex);
      break;
    case "sdp":
      mutated.sdp += "a=x-mutated:1\r\n";
      break;
    default:
      throw new Error(`unknown mutation field ${field}`);
  }
  return mutated;
}

function privateKeyPkcs8(seedHex: string): Uint8Array {
  // RFC 8410 OneAsymmetricKey prefix for a 32-byte Ed25519 seed.
  return hexToBytes(`302e020100300506032b657004220420${seedHex}`);
}

async function importTestEd25519PrivateKey(seedHex: string): Promise<CryptoKey> {
  const pkcs8 = privateKeyPkcs8(seedHex);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } finally {
    pkcs8.fill(0);
  }
}

describe("signed signaling transcript", () => {
  test("round trips the exact binary format and rejects malformed input", () => {
    const original = transcript(golden.vectors[0]);
    const encoded = encodeSignedSignalTranscript(original);
    expect(decodeSignedSignalTranscript(encoded)).toEqual(original);

    const invalidMagic = encoded.slice();
    invalidMagic[0] ^= 1;
    expect(() => decodeSignedSignalTranscript(invalidMagic)).toThrow("invalid transcript magic");
    const invalidVersion = encoded.slice();
    invalidVersion[SIGNED_SIGNAL_MAGIC.byteLength] = 2;
    expect(() => decodeSignedSignalTranscript(invalidVersion)).toThrow(
      "unsupported transcript version",
    );
    const invalidKind = encoded.slice();
    invalidKind[SIGNED_SIGNAL_MAGIC.byteLength + 1] = 0xff;
    expect(() => decodeSignedSignalTranscript(invalidKind)).toThrow("invalid signalKind");
    const sessionLengthOffset = SIGNED_SIGNAL_MAGIC.byteLength + 1 + 1 + 4;
    const sessionLength = new DataView(
      encoded.buffer,
      encoded.byteOffset + sessionLengthOffset,
      2,
    ).getUint16(0, false);
    const sessionOffset = sessionLengthOffset + 2;
    const invalidUtf8 = encoded.slice();
    invalidUtf8[sessionOffset] = 0xff;
    expect(() => decodeSignedSignalTranscript(invalidUtf8)).toThrow("invalid UTF-8 in sessionId");
    const scopeTypeOffset = sessionOffset + sessionLength;
    const scopeLengthOffset = scopeTypeOffset + 1;
    const scopeLength = new DataView(
      encoded.buffer,
      encoded.byteOffset + scopeLengthOffset,
      2,
    ).getUint16(0, false);
    const senderRoleOffset = scopeLengthOffset + 2 + scopeLength;
    for (const [offset, field] of [
      [scopeTypeOffset, "scopeType"],
      [senderRoleOffset, "senderRole"],
    ] as const) {
      const invalid = encoded.slice();
      invalid[offset] = 0xff;
      expect(() => decodeSignedSignalTranscript(invalid)).toThrow(`invalid ${field}`);
    }
    expect(() => decodeSignedSignalTranscript(encoded.slice(0, -1))).toThrow(
      "truncated transcript",
    );
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(() => decodeSignedSignalTranscript(trailing)).toThrow("trailing bytes");
  });

  test("enforces numeric, canonical UUID, key, and SDP bounds", () => {
    const base = transcript(golden.vectors[0]);
    expect(() => encodeSignedSignalTranscript({ ...base, protocolVersion: 0 })).toThrow(
      "protocolVersion",
    );
    expect(() => encodeSignedSignalTranscript({ ...base, protocolVersion: 1.5 })).toThrow(
      "protocolVersion",
    );
    expect(() =>
      encodeSignedSignalTranscript({
        ...base,
        sessionId: "s".repeat(MAX_SESSION_ID_BYTES + 1),
      }),
    ).toThrow("sessionId");
    expect(() =>
      encodeSignedSignalTranscript({
        ...base,
        scopeId: "s".repeat(MAX_SCOPE_ID_BYTES + 1),
      }),
    ).toThrow("scopeId");
    expect(() =>
      encodeSignedSignalTranscript({
        ...base,
        sdp: "s".repeat(MAX_SDP_BYTES + 1),
      }),
    ).toThrow("sdp");
    expect(() => encodeSignedSignalTranscript({ ...base, sessionId: "\ud800" })).toThrow(
      "canonical UUID",
    );
    expect(() =>
      encodeSignedSignalTranscript({
        ...base,
        intendedPeerPublicKey: new Uint8Array(ED25519_PUBLIC_KEY_BYTES - 1),
      }),
    ).toThrow("intendedPeerPublicKey");
    expect(() =>
      encodeSignedSignalTranscript({
        ...base,
        protocolVersion: 0xffff_ffff,
        sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        scopeId: "11111111-2222-4333-8444-555555555555",
        sdp: "x".repeat(MAX_SDP_BYTES),
      }),
    ).not.toThrow();
  });

  test("rejects noncanonical UUID spellings at encoder and decoder ingress", () => {
    const base = transcript(golden.vectors[0]);
    for (const invalid of [
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
      "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}",
      " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ",
      "not-a-uuid-not-a-uuid-not-a-uuid!!!",
    ]) {
      expect(() => encodeSignedSignalTranscript({ ...base, sessionId: invalid })).toThrow();
      expect(() => encodeSignedSignalTranscript({ ...base, scopeId: invalid })).toThrow();
    }

    const encoded = encodeSignedSignalTranscript(base);
    const sessionOffset = SIGNED_SIGNAL_MAGIC.byteLength + 1 + 1 + 4 + 2;
    const uppercaseSession = encoded.slice();
    const sessionLetter = uppercaseSession.findIndex(
      (byte, index) =>
        index >= sessionOffset && index < sessionOffset + MAX_SESSION_ID_BYTES && byte >= 97,
    );
    expect(sessionLetter).toBeGreaterThanOrEqual(sessionOffset);
    uppercaseSession[sessionLetter] -= 32;
    expect(() => decodeSignedSignalTranscript(uppercaseSession)).toThrow("canonical UUID");

    const scopeEncoded = encodeSignedSignalTranscript({
      ...base,
      scopeId: "bbbbbbbb-2222-4333-8444-555555555555",
    });
    const scopeOffset = sessionOffset + MAX_SESSION_ID_BYTES + 1 + 2;
    const uppercaseScope = scopeEncoded.slice();
    const scopeLetter = uppercaseScope.findIndex(
      (byte, index) =>
        index >= scopeOffset && index < scopeOffset + MAX_SCOPE_ID_BYTES && byte >= 97,
    );
    expect(scopeLetter).toBeGreaterThanOrEqual(scopeOffset);
    uppercaseScope[scopeLetter] -= 32;
    expect(() => decodeSignedSignalTranscript(uppercaseScope)).toThrow("canonical UUID");
  });

  test("uses strict canonical unpadded base64url", () => {
    const value = hexToBytes(golden.signing_key.public_key_hex);
    expect(encodeBase64Url(value)).toBe(golden.signing_key.public_key_wire);
    expect(decodeBase64Url(golden.signing_key.public_key_wire, 32)).toEqual(value);
    expect(() => decodeBase64Url(`${golden.signing_key.public_key_wire}=`, 32)).toThrow(
      "canonical base64url",
    );
    expect(() => decodeBase64Url("not+base64url", 32)).toThrow("canonical base64url");
    expect(() => decodeBase64Url(golden.signing_key.public_key_wire, 31)).toThrow(
      "canonical base64url",
    );
    expect(ED25519_PUBLIC_KEY_WIRE_CHARS).toBe(43);
    expect(ED25519_SIGNATURE_WIRE_CHARS).toBe(86);
  });

  test("derives the exact bounded fingerprint only from a strict public key", async () => {
    await expect(
      ed25519PublicKeyFingerprint("PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw"),
    ).resolves.toBe("SHA256:OfcT0KZEJT8EUpQh");
    await expect(
      ed25519PublicKeyFingerprint("AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toThrow("weak Ed25519 public key");
  });

  test("rejects oversized fixed-width wire values before base64 decoding", () => {
    const huge = "A".repeat(16 * 1024 * 1024);
    expect(() => decodeBase64Url(huge, ED25519_PUBLIC_KEY_BYTES)).toThrow("canonical base64url");
  });
});

describe("shared Rust/WebCrypto Ed25519 vectors", () => {
  test("matches bytes, hashes, signatures, mutations, and cross-transcript replay", async () => {
    expect(golden.format).toBe("spawn-signed-signal-v1");
    expect(golden.mutation_fields).toEqual([
      "signal_kind",
      "protocol_version",
      "session_id",
      "scope_type",
      "scope_id",
      "sender_role",
      "intended_peer_public_key",
      "sdp",
    ]);
    const privateKey = await importTestEd25519PrivateKey(golden.signing_key.seed_hex);
    const publicKey = await importEd25519PublicKeyWire(golden.signing_key.public_key_wire);
    expect(privateKey.extractable).toBe(false);

    for (const vector of golden.vectors) {
      const value = transcript(vector);
      const encoded = encodeSignedSignalTranscript(value);
      expect(bytesToHex(encoded)).toBe(vector.transcript_hex);
      expect(
        bytesToHex(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(encoded).buffer)),
        ),
      ).toBe(vector.sha256_hex);
      expect(decodeSignedSignalTranscript(hexToBytes(vector.transcript_hex))).toEqual(value);
      const signature = await signSignedSignalTranscript(privateKey, value);
      expect(signature).toBe(vector.signature_wire);
      expect(bytesToHex(decodeBase64Url(signature, 64))).toBe(vector.signature_hex);
      expect(await verifySignedSignalTranscript(publicKey, value, signature)).toBe(true);
      for (const field of golden.mutation_fields) {
        expect(
          await verifySignedSignalTranscript(publicKey, mutate(value, field), signature),
          `${vector.id} accepted mutated ${field}`,
        ).toBe(false);
      }
      const replay = golden.vectors.find(
        (candidate) => candidate.id === vector.replay_signature_from,
      );
      expect(replay).toBeDefined();
      expect(await verifySignedSignalTranscript(publicKey, value, replay!.signature_wire)).toBe(
        false,
      );
    }
  });

  test("generates non-extractable private keys and round-trips public wire keys", async () => {
    const generated = await generateEd25519IdentityKeyPair();
    expect(generated.privateKey.extractable).toBe(false);
    const publicWire = await exportEd25519PublicKeyWire(generated.publicKey);
    const importedPublic = await importEd25519PublicKeyWire(publicWire);
    const value = transcript(golden.vectors[0]);
    const signature = await signSignedSignalTranscript(generated.privateKey, value);
    expect(await verifySignedSignalTranscript(importedPublic, value, signature)).toBe(true);
  });

  test("rejects the complete small-order corpus and malformed point encodings", async () => {
    expect(negativeKeys.format).toBe("spawn-ed25519-public-key-negative-v1");
    expect(negativeKeys.weak_public_keys).toHaveLength(8);
    expect(negativeKeys.noncanonical_public_key_hex).toHaveLength(40);
    const rejected = [
      ...negativeKeys.weak_public_keys,
      ...negativeKeys.noncanonical_public_key_hex.map((public_key_hex, index) => ({
        id: `noncanonical-${index}`,
        public_key_hex,
      })),
      ...negativeKeys.invalid_encodings,
    ];
    for (const vector of rejected) {
      const raw = hexToBytes(vector.public_key_hex);
      expect(raw).toHaveLength(ED25519_PUBLIC_KEY_BYTES);
      await expect(importEd25519PublicKey(raw), vector.id).rejects.toThrow("Ed25519 public key");
    }
    expect(negativeKeys.accepted_mixed_torsion_public_key_hex).toHaveLength(7);
    for (const publicKeyHex of negativeKeys.accepted_mixed_torsion_public_key_hex) {
      await expect(importEd25519PublicKey(hexToBytes(publicKeyHex))).resolves.toBeDefined();
    }
  });

  test("applies the full strict point contract to intended-peer keys at every core boundary", async () => {
    const rejected = [
      ...negativeKeys.weak_public_keys,
      ...negativeKeys.noncanonical_public_key_hex.map((public_key_hex, index) => ({
        id: `noncanonical-${index}`,
        public_key_hex,
      })),
      ...negativeKeys.invalid_encodings,
    ];
    expect(rejected).toHaveLength(49);
    const privateKey = await importTestEd25519PrivateKey(golden.signing_key.seed_hex);
    const publicKey = await importEd25519PublicKeyWire(golden.signing_key.public_key_wire);
    const base = transcript(golden.vectors[0]);
    const encoded = encodeSignedSignalTranscript(base);
    const peerOffset =
      SIGNED_SIGNAL_MAGIC.byteLength +
      1 +
      1 +
      4 +
      2 +
      MAX_SESSION_ID_BYTES +
      1 +
      2 +
      MAX_SCOPE_ID_BYTES +
      1;

    for (const vector of rejected) {
      const raw = hexToBytes(vector.public_key_hex);
      const invalid = { ...base, intendedPeerPublicKey: raw };
      expect(() => encodeSignedSignalTranscript(invalid), `encoder: ${vector.id}`).toThrow(
        "Ed25519 public key",
      );
      await expect(
        signSignedSignalTranscript(privateKey, invalid),
        `signer: ${vector.id}`,
      ).rejects.toThrow("Ed25519 public key");
      await expect(
        verifySignedSignalTranscript(publicKey, invalid, golden.vectors[0].signature_wire),
        `verifier: ${vector.id}`,
      ).rejects.toThrow("Ed25519 public key");

      const forgedWire = encoded.slice();
      forgedWire.set(raw, peerOffset);
      expect(() => decodeSignedSignalTranscript(forgedWire), `decoder: ${vector.id}`).toThrow(
        "Ed25519 public key",
      );
    }

    expect(negativeKeys.accepted_mixed_torsion_public_key_hex).toHaveLength(7);
    for (const publicKeyHex of negativeKeys.accepted_mixed_torsion_public_key_hex) {
      const accepted = {
        ...base,
        intendedPeerPublicKey: hexToBytes(publicKeyHex),
      };
      const acceptedBytes = encodeSignedSignalTranscript(accepted);
      expect(decodeSignedSignalTranscript(acceptedBytes)).toEqual(accepted);
      const signature = await signSignedSignalTranscript(privateKey, accepted);
      expect(await verifySignedSignalTranscript(publicKey, accepted, signature)).toBe(true);
    }
  });

  test("blocks the identity-key universal forgery even for externally imported keys", async () => {
    const identity = negativeKeys.weak_public_keys.find(
      ({ id }) => id === negativeKeys.universal_forgery.public_key_id,
    );
    expect(identity).toBeDefined();
    const raw = hexToBytes(identity!.public_key_hex);
    const signature = hexToBytes(negativeKeys.universal_forgery.signature_hex);
    const value = transcript(golden.vectors[0]);
    const encoded = encodeSignedSignalTranscript(value);

    // Node/Bun WebCrypto imports this weak key and accepts R=identity,S=0 for
    // arbitrary messages. The project verifier must reject a CryptoKey even
    // when a caller bypasses importEd25519PublicKey.
    const externallyImported = await crypto.subtle.importKey(
      "raw",
      raw.buffer as ArrayBuffer,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        externallyImported,
        signature.buffer as ArrayBuffer,
        encoded.buffer as ArrayBuffer,
      ),
    ).toBe(true);
    await expect(
      verifySignedSignalTranscript(externallyImported, value, encodeBase64Url(signature)),
    ).rejects.toThrow("weak Ed25519 public key");
  });
});
