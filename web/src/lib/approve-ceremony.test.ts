import { describe, expect, test } from "bun:test";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import {
  planApproverEndorsement,
  planReciprocalEndorsement,
  verifyAccountEndorsementSignature,
} from "./approve-ceremony";
import { encodeBase64Url, exportEd25519PublicKeyWire } from "./signed-signal";

const ACCOUNT = "0b6e6c64-0000-4000-8000-000000000001";
const ENDORSED_DEVICE = "0b6e6c64-0000-4000-8000-000000000002";
const INITIATOR_DEVICE = "0b6e6c64-0000-4000-8000-000000000003";

async function keyPair() {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function signTranscript(
  privateKey: CryptoKey,
  endorserWire: string,
  endorsedWire: string,
  endorsedDeviceId: string,
) {
  const transcript = encodeAcctEndorsementTranscript(
    ACCOUNT,
    endorserWire,
    endorsedWire,
    endorsedDeviceId,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, owned)),
  );
}

async function signedEdge() {
  const endorser = await keyPair();
  const endorsed = await keyPair();
  const endorserWire = await exportEd25519PublicKeyWire(endorser.publicKey);
  const endorsedWire = await exportEd25519PublicKeyWire(endorsed.publicKey);
  const signature = await signTranscript(
    endorser.privateKey,
    endorserWire,
    endorsedWire,
    ENDORSED_DEVICE,
  );
  return { endorserWire, endorsedWire, signature };
}

describe("verifyAccountEndorsementSignature", () => {
  test("accepts a genuine endorsement", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: edge.signature,
      }),
    ).toBe(true);
  });

  test("rejects a signature verified under a different endorser key", async () => {
    // The server-substitution case the reciprocal gate exists for: the edge's
    // claimed key differs from the ceremony-authenticated one the caller pins.
    const edge = await signedEdge();
    const other = await keyPair();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: await exportEd25519PublicKeyWire(other.publicKey),
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: edge.signature,
      }),
    ).toBe(false);
  });

  test("rejects a transcript-field swap (wrong endorsed device id)", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: "0b6e6c64-0000-4000-8000-00000000dead",
        signature: edge.signature,
      }),
    ).toBe(false);
  });

  test("rejects garbage signatures without throwing", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: "not-a-signature",
      }),
    ).toBe(false);
  });
});

// The C2 regression suite: after the human matched the number, the keys that
// went into it are pinned; a server that swaps a key on a later poll must get
// an ABORT, never a signed endorsement of the swapped key.

describe("planApproverEndorsement (C2)", () => {
  const pinned = { initiatorPublicKey: "approver-key", joinerPublicKey: "joiner-key" };
  const honestPairing = {
    initiator_public_key: "approver-key",
    joiner_public_key: "joiner-key",
    joiner_device_id: ENDORSED_DEVICE,
  };

  test("signs exactly the pinned joiner key while the live row still matches", () => {
    expect(planApproverEndorsement({ pairing: honestPairing, pinned })).toEqual({
      kind: "sign",
      endorsedDeviceId: ENDORSED_DEVICE,
      endorsedPublicKey: "joiner-key",
    });
  });

  test("post-match joiner-key swap aborts — the swapped key is never the sign target", () => {
    const plan = planApproverEndorsement({
      pairing: { ...honestPairing, joiner_public_key: "attacker-key" },
      pinned,
    });
    expect(plan.kind).toBe("abort");
  });

  test("post-match initiator-key swap aborts too", () => {
    const plan = planApproverEndorsement({
      pairing: { ...honestPairing, initiator_public_key: "attacker-key" },
      pinned,
    });
    expect(plan.kind).toBe("abort");
  });
});

describe("planReciprocalEndorsement (C2)", () => {
  async function ceremony() {
    const initiator = await keyPair();
    const joiner = await keyPair();
    const initiatorWire = await exportEd25519PublicKeyWire(initiator.publicKey);
    const joinerWire = await exportEd25519PublicKeyWire(joiner.publicKey);
    const signature = await signTranscript(
      initiator.privateKey,
      initiatorWire,
      joinerWire,
      ENDORSED_DEVICE,
    );
    return {
      initiator,
      initiatorWire,
      joinerWire,
      pinned: { initiatorPublicKey: initiatorWire, joinerPublicKey: joinerWire },
      currentDevice: { id: ENDORSED_DEVICE, public_key: joinerWire },
      pairing: {
        initiator_device_id: INITIATOR_DEVICE,
        initiator_public_key: initiatorWire,
        joiner_public_key: joinerWire,
      },
      edge: {
        endorser_device_id: INITIATOR_DEVICE,
        endorser_public_key: initiatorWire,
        endorsed_device_id: ENDORSED_DEVICE,
        endorsed_public_key: joinerWire,
        signature,
      },
    };
  }

  test("reciprocates with exactly the pinned initiator key on a genuine edge", async () => {
    const c = await ceremony();
    expect(
      await planReciprocalEndorsement({
        accountId: ACCOUNT,
        pairing: c.pairing,
        pinned: c.pinned,
        currentDevice: c.currentDevice,
        edges: [c.edge],
      }),
    ).toEqual({
      kind: "sign",
      endorsedDeviceId: INITIATOR_DEVICE,
      endorsedPublicKey: c.initiatorWire,
    });
  });

  test("post-match initiator swap aborts even when the attacker's edge verifies under its own key", async () => {
    // The exact C2 attack: the server relays honestly through the number
    // match (pinning K), then swaps the row to the attacker key K' and
    // fabricates a self-consistent edge validly signed by K'. Without the
    // pin, the old live-poll code verified against K' and signed K'.
    const c = await ceremony();
    const attacker = await keyPair();
    const attackerWire = await exportEd25519PublicKeyWire(attacker.publicKey);
    const attackerSignature = await signTranscript(
      attacker.privateKey,
      attackerWire,
      c.joinerWire,
      ENDORSED_DEVICE,
    );
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: { ...c.pairing, initiator_public_key: attackerWire },
      pinned: c.pinned,
      currentDevice: c.currentDevice,
      edges: [
        {
          endorser_device_id: INITIATOR_DEVICE,
          endorser_public_key: attackerWire,
          endorsed_device_id: ENDORSED_DEVICE,
          endorsed_public_key: c.joinerWire,
          signature: attackerSignature,
        },
      ],
    });
    expect(plan.kind).toBe("abort");
  });

  test("post-match joiner swap on the live row aborts", async () => {
    const c = await ceremony();
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: { ...c.pairing, joiner_public_key: "attacker-key" },
      pinned: c.pinned,
      currentDevice: c.currentDevice,
      edges: [c.edge],
    });
    expect(plan.kind).toBe("abort");
  });

  test("a pinned joiner key this device does not hold aborts", async () => {
    // The number covered a joiner key that is not ours: the peer was induced
    // to endorse someone else. Nothing to reciprocate — ever.
    const c = await ceremony();
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: c.pairing,
      pinned: c.pinned,
      currentDevice: { id: ENDORSED_DEVICE, public_key: "some-other-key" },
      edges: [c.edge],
    });
    expect(plan.kind).toBe("abort");
  });

  test("an edge claiming unpinned keys is not this ceremony's edge — wait, sign nothing", async () => {
    const c = await ceremony();
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: c.pairing,
      pinned: c.pinned,
      currentDevice: c.currentDevice,
      edges: [{ ...c.edge, endorser_public_key: "attacker-key" }],
    });
    expect(plan.kind).toBe("wait");
  });

  test("a forged signature never reciprocates", async () => {
    const c = await ceremony();
    const forger = await keyPair();
    const forged = await signTranscript(
      forger.privateKey,
      c.initiatorWire,
      c.joinerWire,
      ENDORSED_DEVICE,
    );
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: c.pairing,
      pinned: c.pinned,
      currentDevice: c.currentDevice,
      edges: [{ ...c.edge, signature: forged }],
    });
    expect(plan.kind).toBe("wait");
  });

  test("no edge yet means wait, not abort", async () => {
    const c = await ceremony();
    const plan = await planReciprocalEndorsement({
      accountId: ACCOUNT,
      pairing: c.pairing,
      pinned: c.pinned,
      currentDevice: c.currentDevice,
      edges: [],
    });
    expect(plan.kind).toBe("wait");
  });
});
