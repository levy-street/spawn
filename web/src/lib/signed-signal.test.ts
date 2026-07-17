import { describe, expect, test } from "bun:test";

import goldenJson from "../../../proto/signed-signal-v1-vectors.json";
import {
  decodeBase64Url,
  decodeSignedSignalTranscript,
  ED25519_PUBLIC_KEY_BYTES,
  encodeBase64Url,
  encodeSignedSignalTranscript,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  importEd25519PrivateKeyPkcs8,
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
      mutated.sessionId += "-mutated";
      break;
    case "scope_type":
      mutated.scopeType = original.scopeType === "agent" ? "host" : "agent";
      break;
    case "scope_id":
      mutated.scopeId += "-mutated";
      break;
    case "sender_role":
      mutated.senderRole = original.senderRole === "browser" ? "daemon" : "browser";
      break;
    case "intended_peer_public_key":
      mutated.intendedPeerPublicKey[0] ^= 1;
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

  test("enforces numeric, byte, strict-Unicode, key, and SDP bounds", () => {
    const base = transcript(golden.vectors[0]);
    expect(() => encodeSignedSignalTranscript({ ...base, protocolVersion: 0 })).toThrow(
      "protocolVersion",
    );
    expect(() => encodeSignedSignalTranscript({ ...base, protocolVersion: 1.5 })).toThrow(
      "protocolVersion",
    );
    expect(() =>
      encodeSignedSignalTranscript({ ...base, sessionId: "s".repeat(MAX_SESSION_ID_BYTES + 1) }),
    ).toThrow("sessionId");
    expect(() =>
      encodeSignedSignalTranscript({ ...base, scopeId: "s".repeat(MAX_SCOPE_ID_BYTES + 1) }),
    ).toThrow("scopeId");
    expect(() =>
      encodeSignedSignalTranscript({ ...base, sdp: "s".repeat(MAX_SDP_BYTES + 1) }),
    ).toThrow("sdp");
    expect(() => encodeSignedSignalTranscript({ ...base, sessionId: "\ud800" })).toThrow(
      "strict Unicode",
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
        sessionId: "s".repeat(MAX_SESSION_ID_BYTES),
        scopeId: "h".repeat(MAX_SCOPE_ID_BYTES),
        sdp: "x".repeat(MAX_SDP_BYTES),
      }),
    ).not.toThrow();
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
    const privateKey = await importEd25519PrivateKeyPkcs8(
      privateKeyPkcs8(golden.signing_key.seed_hex),
    );
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
});
