import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import goldenJson from "../../../proto/signed-signal-wire-v1-vectors.json";
import {
  signRtcSignalWireForTestOnly,
  type TestOnlySignedRtcIdentitySigner,
} from "../../test-support/signed-signal-wire-test-only";
import {
  loadOrCreateBrowserDeviceIdentity,
  scopeBrowserDeviceIdentityToTrustEpoch,
  signBrowserDeviceRtcTranscriptWithinTrustEpoch,
} from "./browser-device-identity";
import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
  importEd25519PublicKeyWire,
  MAX_SDP_BYTES,
  type ScopeType,
  type SenderRole,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";
import {
  MAX_SIGNED_RTC_WIRE_CHARS,
  type RtcSignalProtocol,
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
  protocol_version_json_tokens: {
    agent_accepted: string[];
    host_accepted: string[];
    rejected: string[];
  };
  vectors: Array<{ id: string; envelope: WireEnvelope }>;
  wrong_topology_vectors: Array<{ id: string; envelope: WireEnvelope }>;
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
    const signer: TestOnlySignedRtcIdentitySigner = {
      publicKeyWire: golden.sender_public_key_wire,
      sign: (value) => signSignedSignalTranscript(privateKey, value),
    };
    for (const vector of golden.vectors) {
      const value = transcript(vector.envelope);
      const wire = await signRtcSignalWireForTestOnly(signer, {
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

  test("accepts only the exact epoch-scoped browser identity handle", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(
      "00000000-0000-0000-0000-000000000101",
      {
        indexedDBFactory: new IDBFactory(),
      },
    );
    const value: SignedSignalTranscript = {
      signalKind: "offer",
      protocolVersion: 2,
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      scopeType: "agent",
      scopeId: "11111111-2222-4333-8444-555555555555",
      senderRole: "browser",
      intendedPeerPublicKey: decodeBase64Url(
        golden.intended_peer_public_key_wire,
        ED25519_PUBLIC_KEY_BYTES,
      ),
      sdp: "v=0\r\ns=persisted-browser-identity\r\n",
    };
    const controller = new AbortController();
    const scoped = scopeBrowserDeviceIdentityToTrustEpoch(
      identity,
      "00000000-0000-0000-0000-000000000101",
      identity.publicKeyWire,
      controller.signal,
    );
    const wire = await signRtcSignalWire(scoped, {
      protocol: "spawn.pty",
      transcript: value,
    });
    const verified = await verifyRtcSignalWire(
      wire,
      identity.publicKeyWire,
      golden.intended_peer_public_key_wire,
    );
    expect(verified.transcript).toEqual(value);
    expect(Object.keys(identity).sort()).toEqual(["publicKey", "publicKeyWire"]);
    expect(Object.keys(scoped).sort()).toEqual(["publicKey", "publicKeyWire"]);
  });

  test("rejects raw identities, frozen copies, wrappers, proxies, and rebound sign methods", async () => {
    const factory = new IDBFactory();
    const first = await loadOrCreateBrowserDeviceIdentity("00000000-0000-0000-0000-000000000102", {
      indexedDBFactory: factory,
    });
    const second = await loadOrCreateBrowserDeviceIdentity("00000000-0000-0000-0000-000000000103", {
      indexedDBFactory: factory,
    });
    const controller = new AbortController();
    const scoped = scopeBrowserDeviceIdentityToTrustEpoch(
      first,
      "00000000-0000-0000-0000-000000000102",
      first.publicKeyWire,
      controller.signal,
    );
    const input = {
      protocol: golden.vectors[0].envelope.protocol,
      transcript: transcript(golden.vectors[0].envelope),
    } as const;
    expect("sign" in first).toBe(false);
    expect("sign" in scoped).toBe(false);
    const reboundSign = signBrowserDeviceRtcTranscriptWithinTrustEpoch.bind(undefined, scoped);
    let reboundInvoked = false;
    const observedReboundSign = async (value: SignedSignalTranscript) => {
      reboundInvoked = true;
      return reboundSign(value);
    };
    const rejected = [
      first,
      Object.freeze({ ...scoped }),
      Object.freeze({ ...scoped, publicKeyWire: second.publicKeyWire }),
      Object.freeze({ ...scoped, sign: reboundSign }),
      Object.freeze({ ...scoped, sign: observedReboundSign }),
      new Proxy(scoped, {}),
    ];
    for (const value of rejected) {
      await expect(signRtcSignalWire(value as typeof scoped, input)).rejects.toMatchObject({
        code: "key_mismatch",
      });
    }
    expect(reboundInvoked).toBe(false);
  });

  test("snapshots mutable caller input across opaque asynchronous signing", async () => {
    const privateKey = await importTestEd25519PrivateKey(golden.signing_seed_hex);
    const value = transcript(golden.vectors[0].envelope);
    const originalSession = value.sessionId;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signing = signRtcSignalWireForTestOnly(
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

  test("rejects noncanonical session and scope UUID text at signed wire ingress", async () => {
    const privateKey = await importTestEd25519PrivateKey(golden.signing_seed_hex);
    const signer: TestOnlySignedRtcIdentitySigner = {
      publicKeyWire: golden.sender_public_key_wire,
      sign: (value) => signSignedSignalTranscript(privateKey, value),
    };
    const base = golden.vectors[0].envelope;
    for (const invalid of [
      "018F0F77-86D2-7A8E-9B1C-1F3B847CA2A1",
      "018f0f7786d27a8e9b1c1f3b847ca2a1",
      "{018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1}",
      " 018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1 ",
      "not-a-uuid-not-a-uuid-not-a-uuid!!!",
    ]) {
      await expect(
        signRtcSignalWireForTestOnly(signer, {
          protocol: base.protocol,
          transcript: { ...transcript(base), sessionId: invalid },
        }),
      ).rejects.toThrow("canonical UUID");
      await expect(
        signRtcSignalWireForTestOnly(signer, {
          protocol: base.protocol,
          transcript: { ...transcript(base), scopeId: invalid },
        }),
      ).rejects.toThrow("canonical UUID");
      await expect(
        verifyRtcSignalWire(
          JSON.stringify({ ...base, session_id: invalid }),
          golden.sender_public_key_wire,
          golden.intended_peer_public_key_wire,
        ),
      ).rejects.toThrow("canonical UUID");
      await expect(
        verifyRtcSignalWire(
          JSON.stringify({ ...base, scope_id: invalid }),
          golden.sender_public_key_wire,
          golden.intended_peer_public_key_wire,
        ),
      ).rejects.toThrow("canonical UUID");
    }
  });

  test("uses the shared value-semantic JSON number contract", async () => {
    for (const [vector, tokens] of [
      [golden.vectors[0], golden.protocol_version_json_tokens.agent_accepted],
      [golden.vectors[1], golden.protocol_version_json_tokens.host_accepted],
    ] as const) {
      const canonical = JSON.stringify(vector.envelope);
      const needle = `"protocol_version":${vector.envelope.protocol_version}`;
      expect(canonical.split(needle)).toHaveLength(2);
      for (const token of tokens) {
        const wire = canonical.replace(needle, `"protocol_version":${token}`);
        await expect(
          verifyRtcSignalWire(
            wire,
            golden.sender_public_key_wire,
            golden.intended_peer_public_key_wire,
          ),
          `${vector.id} rejected equivalent JSON number ${token}`,
        ).resolves.toBeDefined();
      }
    }

    const canonical = JSON.stringify(golden.vectors[0].envelope);
    const needle = '"protocol_version":2';
    for (const token of golden.protocol_version_json_tokens.rejected) {
      const wire = canonical.replace(needle, `"protocol_version":${token}`);
      await expect(
        verifyRtcSignalWire(
          wire,
          golden.sender_public_key_wire,
          golden.intended_peer_public_key_wire,
        ),
        `accepted invalid JSON number ${token}`,
      ).rejects.toThrow();
    }
  });

  test("rejects correctly signed agent v1 and host v2 envelopes", async () => {
    const sender = await importEd25519PublicKeyWire(golden.sender_public_key_wire);
    expect(golden.wrong_topology_vectors).toHaveLength(2);
    for (const vector of golden.wrong_topology_vectors) {
      const value = transcript(vector.envelope);
      expect(
        await verifySignedSignalTranscript(sender, value, vector.envelope.signature),
        `${vector.id} fixture signature is not valid`,
      ).toBe(true);
      await expectWireError(
        verifyRtcSignalWire(
          JSON.stringify(vector.envelope),
          golden.sender_public_key_wire,
          golden.intended_peer_public_key_wire,
        ),
        "inconsistent_tuple",
      );
      await expectWireError(
        signRtcSignalWireForTestOnly(
          {
            publicKeyWire: golden.sender_public_key_wire,
            sign: async () => vector.envelope.signature,
          },
          { protocol: vector.envelope.protocol, transcript: value },
        ),
        "inconsistent_tuple",
      );
    }
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
      signRtcSignalWireForTestOnly(
        {
          publicKeyWire: golden.sender_public_key_wire,
          sign: async () => golden.vectors[0].envelope.signature,
        },
        {
          protocol: "spawn.pty",
          transcript: {
            ...transcript(vector),
            sdp: "x".repeat(MAX_SDP_BYTES + 1),
          },
        },
      ),
    ).rejects.toThrow("sdp");
  });
});
