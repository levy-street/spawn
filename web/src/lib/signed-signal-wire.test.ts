import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import goldenJson from "../../../proto/signed-signal-wire-v1-vectors.json";
import { loadOrCreateBrowserDeviceIdentity } from "./browser-device-identity";
import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
  MAX_SDP_BYTES,
  type ScopeType,
  type SenderRole,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
} from "./signed-signal";
import {
  MAX_SIGNED_RTC_WIRE_CHARS,
  type RtcSignalProtocol,
  type SignedRtcIdentitySigner,
  SignedRtcWireError,
  signRtcSignalWire,
  verifyRtcSignalWire,
} from "./signed-signal-wire";

interface WireEnvelope {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: string;
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: RtcSignalProtocol;
  protocol_version: number;
  session_id: string;
  scope_type: ScopeType;
  scope_id: string;
  sender_role: SenderRole;
  sdp: string;
  signature: string;
  [key: string]: unknown;
}

interface GoldenFile {
  format: string;
  signing_seed_hex: string;
  sender_public_key_wire: string;
  intended_peer_public_key_wire: string;
  mutation_fields: string[];
  vectors: Array<{ id: string; envelope: WireEnvelope }>;
}

const golden = goldenJson as GoldenFile;

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) throw new Error("invalid test hex");
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function importTestEd25519PrivateKey(seedHex: string): Promise<CryptoKey> {
  // RFC 8410 OneAsymmetricKey prefix for a 32-byte Ed25519 seed.
  const pkcs8 = hexToBytes(`302e020100300506032b657004220420${seedHex}`);
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

function transcript(envelope: WireEnvelope): SignedSignalTranscript {
  return {
    signalKind: envelope.type === "rtc.offer" ? "offer" : "answer",
    protocolVersion: envelope.protocol_version,
    sessionId: envelope.session_id,
    scopeType: envelope.scope_type,
    scopeId: envelope.scope_id,
    senderRole: envelope.sender_role,
    intendedPeerPublicKey: decodeBase64Url(
      envelope.intended_peer_identity_public_key,
      ED25519_PUBLIC_KEY_BYTES,
    ),
    sdp: envelope.sdp,
  };
}

function mutate(envelope: WireEnvelope, field: string): WireEnvelope {
  const value = structuredClone(envelope);
  switch (field) {
    case "type":
      value.type = value.type === "rtc.offer" ? "rtc.answer" : "rtc.offer";
      break;
    case "signature_algorithm":
      value.signature_algorithm = "ed448";
      break;
    case "sender_identity_public_key":
      value.sender_identity_public_key = golden.intended_peer_public_key_wire;
      break;
    case "intended_peer_identity_public_key":
      value.intended_peer_identity_public_key = golden.sender_public_key_wire;
      break;
    case "protocol":
      value.protocol = "spawn.ctl" as RtcSignalProtocol;
      break;
    case "protocol_version":
      value.protocol_version += 1;
      break;
    case "session_id":
      value.session_id += "-mutated";
      break;
    case "scope_type":
      value.scope_type = value.scope_type === "agent" ? "host" : "agent";
      break;
    case "scope_id":
      value.scope_id += "-mutated";
      break;
    case "sender_role":
      value.sender_role = value.sender_role === "browser" ? "daemon" : "browser";
      break;
    case "sdp":
      value.sdp += "a=x-mutated:1\r\n";
      break;
    case "signature":
      value.signature = `${value.signature.startsWith("A") ? "B" : "A"}${value.signature.slice(1)}`;
      break;
    default:
      throw new Error(`uncovered mutation field ${field}`);
  }
  return value;
}

async function expectWireError(promise: Promise<unknown>, code: SignedRtcWireError["code"]) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SignedRtcWireError);
  expect((caught as SignedRtcWireError).code).toBe(code);
}

describe("signed RTC JSON wire adapter", () => {
  test("shares exact vectors with Rust and returns only verified transcripts", async () => {
    expect(golden.format).toBe("spawn-signed-signal-wire-v1");
    const privateKey = await importTestEd25519PrivateKey(golden.signing_seed_hex);
    const signer: SignedRtcIdentitySigner = {
      publicKeyWire: golden.sender_public_key_wire,
      sign: (value) => signSignedSignalTranscript(privateKey, value),
    };
    for (const vector of golden.vectors) {
      const value = transcript(vector.envelope);
      const wire = await signRtcSignalWire(signer, {
        protocol: vector.envelope.protocol,
        transcript: value,
      });
      expect(JSON.parse(wire)).toEqual(vector.envelope);
      const verified = await verifyRtcSignalWire(
        wire,
        golden.sender_public_key_wire,
        golden.intended_peer_public_key_wire,
      );
      expect(verified.protocol).toBe(vector.envelope.protocol);
      expect(verified.senderPublicKeyWire).toBe(golden.sender_public_key_wire);
      expect(verified.transcript).toEqual(value);
    }
  });

  test("accepts the persisted public-only browser identity handle", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity("wire-adapter-account", {
      indexedDBFactory: new IDBFactory(),
    });
    const value: SignedSignalTranscript = {
      signalKind: "offer",
      protocolVersion: 2,
      sessionId: "persisted-identity-session",
      scopeType: "agent",
      scopeId: "agent-persisted-identity",
      senderRole: "browser",
      intendedPeerPublicKey: decodeBase64Url(
        golden.intended_peer_public_key_wire,
        ED25519_PUBLIC_KEY_BYTES,
      ),
      sdp: "v=0\r\ns=persisted-browser-identity\r\n",
    };
    const wire = await signRtcSignalWire(identity, { protocol: "spawn.pty", transcript: value });
    const verified = await verifyRtcSignalWire(
      wire,
      identity.publicKeyWire,
      golden.intended_peer_public_key_wire,
    );
    expect(verified.transcript).toEqual(value);
    expect(Object.keys(identity).sort()).toEqual(["publicKey", "publicKeyWire", "sign"]);
  });

  test("rejects mismatched opaque signer closure and declared public handle", async () => {
    const factory = new IDBFactory();
    const first = await loadOrCreateBrowserDeviceIdentity("wire-signer-first", {
      indexedDBFactory: factory,
    });
    const second = await loadOrCreateBrowserDeviceIdentity("wire-signer-second", {
      indexedDBFactory: factory,
    });
    const mismatch: SignedRtcIdentitySigner = {
      publicKeyWire: second.publicKeyWire,
      sign: first.sign,
    };
    await expectWireError(
      signRtcSignalWire(mismatch, {
        protocol: golden.vectors[0].envelope.protocol,
        transcript: transcript(golden.vectors[0].envelope),
      }),
      "signature_mismatch",
    );
  });

  test("snapshots mutable caller input across opaque asynchronous signing", async () => {
    const privateKey = await importTestEd25519PrivateKey(golden.signing_seed_hex);
    const value = transcript(golden.vectors[0].envelope);
    const originalSession = value.sessionId;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signing = signRtcSignalWire(
      {
        publicKeyWire: golden.sender_public_key_wire,
        sign: async (snapshot) => {
          await waiting;
          return signSignedSignalTranscript(privateKey, snapshot);
        },
      },
      { protocol: "spawn.pty", transcript: value },
    );
    value.sessionId = "caller-mutated-session";
    value.intendedPeerPublicKey.fill(0);
    release();
    const wire = await signing;
    const verified = await verifyRtcSignalWire(
      wire,
      golden.sender_public_key_wire,
      golden.intended_peer_public_key_wire,
    );
    expect(verified.transcript.sessionId).toBe(originalSession);
  });

  test("rejects every envelope-field mutation and both wrong pins", async () => {
    expect(golden.mutation_fields).toHaveLength(12);
    for (const vector of golden.vectors) {
      for (const field of golden.mutation_fields) {
        await expect(
          verifyRtcSignalWire(
            JSON.stringify(mutate(vector.envelope, field)),
            golden.sender_public_key_wire,
            golden.intended_peer_public_key_wire,
          ),
          `${vector.id} accepted mutated ${field}`,
        ).rejects.toThrow();
      }
    }
    const wire = JSON.stringify(golden.vectors[0].envelope);
    await expectWireError(
      verifyRtcSignalWire(
        wire,
        golden.intended_peer_public_key_wire,
        golden.intended_peer_public_key_wire,
      ),
      "sender_pin_mismatch",
    );
    await expectWireError(
      verifyRtcSignalWire(wire, golden.sender_public_key_wire, golden.sender_public_key_wire),
      "peer_pin_mismatch",
    );
  });

  test("rejects duplicate, missing, unknown, malformed, enum, and bounded input", async () => {
    const vector = golden.vectors[0].envelope;
    const wire = JSON.stringify(vector);
    const duplicate = wire.replace("{", '{"type":"rtc.answer",');
    await expectWireError(
      verifyRtcSignalWire(
        duplicate,
        golden.sender_public_key_wire,
        golden.intended_peer_public_key_wire,
      ),
      "invalid_shape",
    );
    for (const invalid of [
      { ...vector, unexpected: true },
      Object.fromEntries(Object.entries(vector).filter(([field]) => field !== "scope_id")),
      { ...vector, protocol: "spawn.ctl" },
      { ...vector, protocol_version: 1.5 },
      { ...vector, scope_type: "workspace" },
      { ...vector, sender_role: "server" },
      {
        ...vector,
        sender_identity_public_key: `${vector.sender_identity_public_key}=`,
      },
      {
        ...vector,
        intended_peer_identity_public_key: `${vector.intended_peer_identity_public_key}=`,
      },
      { ...vector, sender_identity_public_key: "A".repeat(43) },
      { ...vector, signature: `${vector.signature}=` },
      { ...vector, sdp: "x".repeat(MAX_SDP_BYTES + 1) },
    ]) {
      await expect(
        verifyRtcSignalWire(
          JSON.stringify(invalid),
          golden.sender_public_key_wire,
          golden.intended_peer_public_key_wire,
        ),
      ).rejects.toThrow();
    }
    await expectWireError(
      verifyRtcSignalWire("{", golden.sender_public_key_wire, golden.intended_peer_public_key_wire),
      "invalid_json",
    );
    await expectWireError(
      verifyRtcSignalWire(
        "x".repeat(MAX_SIGNED_RTC_WIRE_CHARS + 1),
        golden.sender_public_key_wire,
        golden.intended_peer_public_key_wire,
      ),
      "wire_too_large",
    );
    await expect(
      signRtcSignalWire(
        {
          publicKeyWire: golden.sender_public_key_wire,
          sign: async () => golden.vectors[0].envelope.signature,
        },
        {
          protocol: "spawn.pty",
          transcript: { ...transcript(vector), sdp: "x".repeat(MAX_SDP_BYTES + 1) },
        },
      ),
    ).rejects.toThrow("sdp");
  });
});
