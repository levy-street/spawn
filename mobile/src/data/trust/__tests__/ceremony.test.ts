import {
  planApproverEndorsement,
  planReciprocalEndorsement,
  reciprocalEdgeVerified,
} from "@/data/trust/ceremony";
import { decodeHex, encodeBase64Url } from "@/lib/crypto/bytes";
import { deriveEd25519PublicKey, signPureEd25519 } from "@/lib/crypto/ed25519";
import { encodeAccountEndorsementV1 } from "@/lib/crypto/transcripts";

// The approver (initiator) holds the RFC 8032 test key; the phone (joiner) a
// second deterministic key. Only genuine signatures may move trust.
const ACCOUNT = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const APPROVER_ID = "00000000-0000-4000-8000-000000000a01";
const PHONE_ID = "00000000-0000-4000-8000-000000000b02";
const APPROVER_SEED = decodeHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const APPROVER_KEY = encodeBase64Url(deriveEd25519PublicKey(APPROVER_SEED));
const PHONE_KEY = encodeBase64Url(deriveEd25519PublicKey(new Uint8Array(32).fill(7)));
const OTHER_KEY = encodeBase64Url(deriveEd25519PublicKey(new Uint8Array(32).fill(9)));

const pairing = {
  initiator_device_id: APPROVER_ID,
  initiator_public_key: APPROVER_KEY,
  joiner_device_id: PHONE_ID,
  joiner_public_key: PHONE_KEY,
};
const pinned = { initiatorPublicKey: APPROVER_KEY, joinerPublicKey: PHONE_KEY };
const self = { id: PHONE_ID, public_key: PHONE_KEY };

function approverEdge(signature?: string) {
  const transcript = encodeAccountEndorsementV1({
    accountId: ACCOUNT,
    endorserPublicKey: APPROVER_KEY,
    endorsedPublicKey: PHONE_KEY,
    endorsedDeviceId: PHONE_ID,
  });
  return {
    endorser_device_id: APPROVER_ID,
    endorser_public_key: APPROVER_KEY,
    endorsed_device_id: PHONE_ID,
    endorsed_public_key: PHONE_KEY,
    signature: signature ?? encodeBase64Url(signPureEd25519(APPROVER_SEED, transcript)),
    created_at: "2026-08-25T00:00:00Z",
  };
}

describe("planApproverEndorsement", () => {
  test("signs the pinned joiner key while the row still carries it", () => {
    expect(planApproverEndorsement({ pairing, pinned })).toEqual({
      kind: "sign",
      endorsedDeviceId: PHONE_ID,
      endorsedPublicKey: PHONE_KEY,
    });
  });
  test("aborts if the relay swapped a key after the match", () => {
    expect(
      planApproverEndorsement({ pairing: { ...pairing, joiner_public_key: OTHER_KEY }, pinned })
        .kind,
    ).toBe("abort");
  });
});

describe("planReciprocalEndorsement", () => {
  test("waits until a genuine approver edge names this device", () => {
    expect(
      planReciprocalEndorsement({ accountId: ACCOUNT, pairing, pinned, self, edges: [] }),
    ).toEqual({ kind: "wait" });
    expect(
      planReciprocalEndorsement({
        accountId: ACCOUNT,
        pairing,
        pinned,
        self,
        edges: [approverEdge(encodeBase64Url(new Uint8Array(64)))],
      }),
    ).toEqual({ kind: "wait" });
  });
  test("reciprocates over the pinned initiator key once the edge verifies", () => {
    expect(
      planReciprocalEndorsement({
        accountId: ACCOUNT,
        pairing,
        pinned,
        self,
        edges: [approverEdge()],
      }),
    ).toEqual({ kind: "sign", endorsedDeviceId: APPROVER_ID, endorsedPublicKey: APPROVER_KEY });
  });
  test("never reciprocates for a number that covered a key this phone does not hold", () => {
    expect(
      planReciprocalEndorsement({
        accountId: ACCOUNT,
        pairing: { ...pairing, joiner_public_key: OTHER_KEY },
        pinned: { ...pinned, joinerPublicKey: OTHER_KEY },
        self,
        edges: [approverEdge()],
      }).kind,
    ).toBe("abort");
  });
});

describe("reciprocalEdgeVerified", () => {
  test("is true only for a signature that verifies under the claimed peer key", () => {
    const input = {
      accountId: ACCOUNT,
      peerDeviceId: APPROVER_ID,
      peerPublicKey: APPROVER_KEY,
      self,
    };
    expect(reciprocalEdgeVerified({ ...input, edges: [approverEdge()] })).toBe(true);
    expect(
      reciprocalEdgeVerified({
        ...input,
        edges: [approverEdge(encodeBase64Url(new Uint8Array(64)))],
      }),
    ).toBe(false);
    expect(
      reciprocalEdgeVerified({ ...input, peerPublicKey: OTHER_KEY, edges: [approverEdge()] }),
    ).toBe(false);
  });
});
