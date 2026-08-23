import { sha256 } from "@noble/hashes/sha2.js";

import { decodeBase64UrlExact, decodeHex, encodeBase64Url, encodeHex } from "@/lib/crypto/bytes";
import { deriveEd25519PublicKey, verifyPureEd25519Strict } from "@/lib/crypto/ed25519";
import {
  decodeSignedSignalEnvelope,
  decodeSignedSignalV2,
  encodeSignedSignalV2,
  parseSignedSignalEnvelope,
  type SignalTranscript,
  serializeSignedSignalEnvelope,
  signSignedSignalV2,
  verifySignedSignalEnvelope,
  verifySignedSignalV2,
} from "@/lib/crypto/signed-signal";
import {
  encodeBrowserEndorsementV1,
  encodeBrowserRegistrationV1,
  encodeHostPairApprovalV1,
  encodeHostPairPossessionV1,
  signBrowserRegistrationV1,
  signHostPairApprovalV1,
  signHostPairPossessionV1,
  verifyHostPairPossessionV1,
} from "@/lib/crypto/transcripts";
import registrationFixture from "../../../../tests/fixtures/browser-device-registration-v1-vectors.json";
import approvalFixture from "../../../../tests/fixtures/host-pair-approval-v1-vectors.json";
import possessionFixture from "../../../../tests/fixtures/host-pair-possession-v1-vectors.json";
import signalFixture from "../../../../tests/fixtures/signed-signal-v1-vectors.json";
import wireFixture from "../../../../tests/fixtures/signed-signal-wire-v1-vectors.json";

const RFC_SEED = decodeHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const RFC_PUBLIC_KEY = deriveEd25519PublicKey(RFC_SEED);

describe("canonical trust transcripts", () => {
  test("matches the browser registration vector", () => {
    const input = {
      accountId: registrationFixture.positive.user_id,
      browserPublicKey: registrationFixture.positive.public_key,
    };
    const transcript = encodeBrowserRegistrationV1(input);
    expect(encodeHex(transcript)).toBe(registrationFixture.positive.transcript_hex);
    expect(encodeHex(sha256(transcript))).toBe(registrationFixture.positive.transcript_sha256);
    expect(encodeBase64Url(signBrowserRegistrationV1(RFC_SEED, input))).toBe(
      registrationFixture.positive.signature,
    );
    for (const accountId of registrationFixture.malformed_user_ids) {
      expect(() => encodeBrowserRegistrationV1({ ...input, accountId })).toThrow();
    }
    for (const browserPublicKey of registrationFixture.malformed_public_keys) {
      expect(() => encodeBrowserRegistrationV1({ ...input, browserPublicKey })).toThrow();
    }
  });

  test("matches the host approval vector", () => {
    const input = {
      accountId: approvalFixture.positive.user_id,
      approvalNonce: approvalFixture.positive.approval_nonce,
      hostPublicKey: approvalFixture.positive.host_public_key,
      browserPublicKey: approvalFixture.positive.browser_public_key,
    };
    const transcript = encodeHostPairApprovalV1(input);
    expect(encodeHex(transcript)).toBe(approvalFixture.positive.transcript_hex);
    expect(encodeHex(sha256(transcript))).toBe(approvalFixture.positive.transcript_sha256);
    expect(encodeBase64Url(signHostPairApprovalV1(RFC_SEED, input))).toBe(
      approvalFixture.positive.signature,
    );
    for (const approvalNonce of approvalFixture.malformed_nonces) {
      expect(() => encodeHostPairApprovalV1({ ...input, approvalNonce })).toThrow();
    }
  });

  test("matches and verifies the host possession vector", () => {
    const input = {
      deviceCode: possessionFixture.positive.device_code,
      approvalNonce: possessionFixture.positive.approval_nonce,
      hostPublicKey: possessionFixture.positive.host_public_key,
    };
    const transcript = encodeHostPairPossessionV1(input);
    const signature = signHostPairPossessionV1(RFC_SEED, input);
    expect(encodeHex(transcript)).toBe(possessionFixture.positive.transcript_hex);
    expect(encodeHex(sha256(transcript))).toBe(possessionFixture.positive.transcript_sha256);
    expect(encodeBase64Url(signature)).toBe(possessionFixture.positive.signature);
    expect(verifyHostPairPossessionV1(RFC_PUBLIC_KEY, input, signature)).toBe(true);
  });

  test("matches the browser endorsement transcript/hash example", () => {
    const transcript = encodeBrowserEndorsementV1({
      accountId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
      endorsedDeviceId: "11111111-2222-4333-8444-555555555555",
      hostPublicKey: "Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo",
      endorserPublicKey: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0",
      endorsedPublicKey: "kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo",
    });
    expect(transcript).toHaveLength(153);
    expect(encodeBase64Url(sha256(transcript))).toBe("zWI0kvAu5asJ4YKWiXSmlbSZM2u8_z7DOiVQ6vE220Y");
  });
});

describe("signed-signal revision 2 vectors", () => {
  test.each(signalFixture.vectors)("matches $id transcript and signature", (vector) => {
    const transcript: SignalTranscript = {
      signalKind: vector.signal_kind as SignalTranscript["signalKind"],
      protocolVersion: vector.protocol_version,
      sessionId: vector.session_id,
      scopeType: vector.scope_type as SignalTranscript["scopeType"],
      scopeId: vector.scope_id,
      senderRole: vector.sender_role as SignalTranscript["senderRole"],
      intendedPeerPublicKey: signalFixture.intended_peer_key.public_key_wire,
      sdp: vector.sdp,
    };
    const encoded = encodeSignedSignalV2(transcript);
    const signature = signSignedSignalV2(RFC_SEED, transcript);
    expect(encoded[23]).toBe(2);
    expect(encodeHex(encoded)).toBe(vector.transcript_hex);
    expect(encodeHex(sha256(encoded))).toBe(vector.sha256_hex);
    expect(encodeHex(signature)).toBe(vector.signature_hex);
    expect(encodeBase64Url(signature)).toBe(vector.signature_wire);
    expect(verifySignedSignalV2(RFC_PUBLIC_KEY, transcript, signature)).toBe(true);
    expect(decodeSignedSignalV2(encoded)).toEqual(transcript);
  });

  test("signs canonical transcript bytes rather than the diagnostic hash", () => {
    const vector = signalFixture.vectors[0];
    expect(vector).toBeDefined();
    if (vector === undefined) return;
    const signature = decodeBase64UrlExact(vector.signature_wire, 64);
    expect(
      verifyPureEd25519Strict(RFC_PUBLIC_KEY, sha256(decodeHex(vector.transcript_hex)), signature),
    ).toBe(false);
  });

  test.each(wireFixture.vectors)("round-trips and verifies wire vector $id", ({ envelope }) => {
    const parsed = parseSignedSignalEnvelope(envelope);
    expect(verifySignedSignalEnvelope(envelope)).toEqual(parsed);
    expect(decodeSignedSignalEnvelope(serializeSignedSignalEnvelope(parsed))).toEqual(parsed);
    if (parsed.scope_type === "session") expect(parsed.scope_type).toBe("session");
  });

  test.each(wireFixture.wrong_topology_vectors)(
    "rejects correctly signed wrong topology $id",
    ({ envelope }) => {
      expect(() => parseSignedSignalEnvelope(envelope)).toThrow();
    },
  );

  test.each(wireFixture.protocol_version_json_tokens.session_accepted)(
    "accepts JSON integer spelling %s for session protocol version",
    (token) => {
      const vector = wireFixture.vectors[0];
      expect(vector).toBeDefined();
      if (vector === undefined) return;
      const json = JSON.stringify(vector.envelope).replace(
        '"protocol_version":2',
        `"protocol_version":${token}`,
      );
      expect(decodeSignedSignalEnvelope(json).protocol_version).toBe(2);
    },
  );

  test.each(wireFixture.protocol_version_json_tokens.host_accepted)(
    "accepts JSON integer spelling %s for host protocol version",
    (token) => {
      const vector = wireFixture.vectors[1];
      expect(vector).toBeDefined();
      if (vector === undefined) return;
      const json = JSON.stringify(vector.envelope).replace(
        '"protocol_version":1',
        `"protocol_version":${token}`,
      );
      expect(decodeSignedSignalEnvelope(json).protocol_version).toBe(1);
    },
  );

  test.each(wireFixture.protocol_version_json_tokens.rejected)(
    "rejects invalid JSON protocol-version token %s",
    (token) => {
      const vector = wireFixture.vectors[0];
      expect(vector).toBeDefined();
      if (vector === undefined) return;
      const json = JSON.stringify(vector.envelope).replace(
        '"protocol_version":2',
        `"protocol_version":${token}`,
      );
      expect(() => decodeSignedSignalEnvelope(json)).toThrow();
    },
  );

  test("rejects extra wire fields and a replayed signature", () => {
    const first = wireFixture.vectors[0];
    const second = wireFixture.vectors[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(() => parseSignedSignalEnvelope({ ...first.envelope, extra: true })).toThrow();
    expect(() =>
      verifySignedSignalEnvelope({ ...first.envelope, signature: second.envelope.signature }),
    ).toThrow();
  });
});
