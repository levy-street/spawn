import { describe, expect, test } from "bun:test";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import {
  accountEndorsementEdgeVerified,
  planApproverEndorsement,
  planReciprocalEndorsement,
  planVanishedCeremonyCompletion,
  RECIPROCAL_SETTLE_MS,
  reciprocalStillSettling,
  vanishedCeremonyScreen,
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

// The C1 regression suite: a vanished relay row (10-min TTL, peer cancel, or
// the peer's completing delete) proves nothing by itself. The terminal state
// each side shows must come from signature-verified endorsement edges — an
// approver whose reciprocal never landed reads half-done ("not finished"),
// never "every host is ready"; a joiner the approver's verified edge admits
// reads done (and reciprocates), never "nothing was trusted".

describe("planVanishedCeremonyCompletion (C1)", () => {
  const APPROVER_DEVICE = INITIATOR_DEVICE;
  const JOINER_DEVICE = ENDORSED_DEVICE;

  async function vanishedCeremony() {
    const initiator = await keyPair();
    const joiner = await keyPair();
    const initiatorWire = await exportEd25519PublicKeyWire(initiator.publicKey);
    const joinerWire = await exportEd25519PublicKeyWire(joiner.publicKey);
    const pinned = { initiatorPublicKey: initiatorWire, joinerPublicKey: joinerWire };
    // x→c: the approver's endorsement of the joiner.
    const approverEdge = {
      endorser_device_id: APPROVER_DEVICE,
      endorser_public_key: initiatorWire,
      endorsed_device_id: JOINER_DEVICE,
      endorsed_public_key: joinerWire,
      signature: await signTranscript(
        initiator.privateKey,
        initiatorWire,
        joinerWire,
        JOINER_DEVICE,
      ),
    };
    // c→x: the joiner's reciprocal.
    const joinerEdge = {
      endorser_device_id: JOINER_DEVICE,
      endorser_public_key: joinerWire,
      endorsed_device_id: APPROVER_DEVICE,
      endorsed_public_key: initiatorWire,
      signature: await signTranscript(
        joiner.privateKey,
        joinerWire,
        initiatorWire,
        APPROVER_DEVICE,
      ),
    };
    return {
      initiator,
      joiner,
      initiatorWire,
      joinerWire,
      pinned,
      approverEdge,
      joinerEdge,
      approver: {
        accountId: ACCOUNT,
        role: "approver" as const,
        pinned,
        currentDevice: { id: APPROVER_DEVICE, public_key: initiatorWire },
        peerDeviceId: JOINER_DEVICE,
      },
      joinerSide: {
        accountId: ACCOUNT,
        role: "new-device" as const,
        pinned,
        currentDevice: { id: JOINER_DEVICE, public_key: joinerWire },
        peerDeviceId: APPROVER_DEVICE,
      },
    };
  }

  test("TTL after the approver signs, before the reciprocal: half-done, never success", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({ ...c.approver, signedMine: true, edges: [] }),
    ).toEqual({ kind: "half-done" });
  });

  test("TTL after the joiner reciprocated: the approver reads done", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({
        ...c.approver,
        signedMine: true,
        edges: [c.joinerEdge],
      }),
    ).toEqual({ kind: "done", signReciprocal: false });
  });

  test("a forged reciprocal never upgrades the approver to done", async () => {
    const c = await vanishedCeremony();
    const forger = await keyPair();
    const forged = {
      ...c.joinerEdge,
      signature: await signTranscript(
        forger.privateKey,
        c.joinerWire,
        c.initiatorWire,
        APPROVER_DEVICE,
      ),
    };
    expect(
      await planVanishedCeremonyCompletion({ ...c.approver, signedMine: true, edges: [forged] }),
    ).toEqual({ kind: "half-done" });
  });

  test("a reciprocal claiming a key the ceremony never pinned is not evidence", async () => {
    const c = await vanishedCeremony();
    const other = await keyPair();
    const swapped = {
      ...c.joinerEdge,
      endorser_public_key: await exportEd25519PublicKeyWire(other.publicKey),
    };
    expect(
      await planVanishedCeremonyCompletion({ ...c.approver, signedMine: true, edges: [swapped] }),
    ).toEqual({ kind: "half-done" });
  });

  test("peer cancel before the approver's entry: stopped, nothing was trusted", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({ ...c.approver, signedMine: false, edges: [] }),
    ).toEqual({ kind: "stopped" });
  });

  test("a prior-session approver edge counts as mine only when its signature verifies", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({
        ...c.approver,
        signedMine: false,
        edges: [c.approverEdge],
      }),
    ).toEqual({ kind: "half-done" });
    const forger = await keyPair();
    const forgedMine = {
      ...c.approverEdge,
      signature: await signTranscript(
        forger.privateKey,
        c.initiatorWire,
        c.joinerWire,
        JOINER_DEVICE,
      ),
    };
    expect(
      await planVanishedCeremonyCompletion({
        ...c.approver,
        signedMine: false,
        edges: [forgedMine],
      }),
    ).toEqual({ kind: "stopped" });
  });

  test("TTL before the joiner reciprocated, x→c verified: the joiner is admitted — done + reciprocate", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({
        ...c.joinerSide,
        signedMine: false,
        edges: [c.approverEdge],
      }),
    ).toEqual({ kind: "done", signReciprocal: true });
  });

  test("a forged x→c leaves the joiner stopped — admission is never the server's claim", async () => {
    const c = await vanishedCeremony();
    const forger = await keyPair();
    const forged = {
      ...c.approverEdge,
      signature: await signTranscript(
        forger.privateKey,
        c.initiatorWire,
        c.joinerWire,
        JOINER_DEVICE,
      ),
    };
    expect(
      await planVanishedCeremonyCompletion({ ...c.joinerSide, signedMine: false, edges: [forged] }),
    ).toEqual({ kind: "stopped" });
  });

  test("peer cancel with nothing signed: the joiner reads stopped", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({ ...c.joinerSide, signedMine: false, edges: [] }),
    ).toEqual({ kind: "stopped" });
  });

  test("a joiner that already reciprocated reads done without re-signing", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({ ...c.joinerSide, signedMine: true, edges: [] }),
    ).toEqual({ kind: "done", signReciprocal: false });
  });

  test("half-done upgrades to done when the reciprocal lands late", async () => {
    const c = await vanishedCeremony();
    const before = await planVanishedCeremonyCompletion({
      ...c.approver,
      signedMine: true,
      edges: [],
    });
    expect(before).toEqual({ kind: "half-done" });
    const after = await planVanishedCeremonyCompletion({
      ...c.approver,
      signedMine: true,
      edges: [c.joinerEdge],
    });
    expect(after).toEqual({ kind: "done", signReciprocal: false });
  });

  test("no pinned keys means nothing verifiable: claim only what this side did", async () => {
    const c = await vanishedCeremony();
    expect(
      await planVanishedCeremonyCompletion({
        ...c.joinerSide,
        pinned: null,
        signedMine: false,
        edges: [c.approverEdge],
      }),
    ).toEqual({ kind: "stopped" });
  });
});

describe("accountEndorsementEdgeVerified", () => {
  test("verifies exactly the expected direction and keys", async () => {
    const endorser = await keyPair();
    const endorsed = await keyPair();
    const endorserWire = await exportEd25519PublicKeyWire(endorser.publicKey);
    const endorsedWire = await exportEd25519PublicKeyWire(endorsed.publicKey);
    const edge = {
      endorser_device_id: INITIATOR_DEVICE,
      endorser_public_key: endorserWire,
      endorsed_device_id: ENDORSED_DEVICE,
      endorsed_public_key: endorsedWire,
      signature: await signTranscript(
        endorser.privateKey,
        endorserWire,
        endorsedWire,
        ENDORSED_DEVICE,
      ),
    };
    const base = {
      accountId: ACCOUNT,
      edges: [edge],
      endorserDeviceId: INITIATOR_DEVICE,
      endorserPublicKey: endorserWire,
      endorsedDeviceId: ENDORSED_DEVICE,
      endorsedPublicKey: endorsedWire,
    };
    expect(await accountEndorsementEdgeVerified(base)).toBe(true);
    // The reverse direction is a different statement entirely.
    expect(
      await accountEndorsementEdgeVerified({
        ...base,
        endorserDeviceId: ENDORSED_DEVICE,
        endorsedDeviceId: INITIATOR_DEVICE,
        endorserPublicKey: endorsedWire,
        endorsedPublicKey: endorserWire,
      }),
    ).toBe(false);
    // Claimed metadata naming an unexpected key is not this edge.
    expect(await accountEndorsementEdgeVerified({ ...base, endorserPublicKey: endorsedWire })).toBe(
      false,
    );
  });
});

// The peer signs its reciprocal edge and only THEN deletes the relay row, so
// the edge is on the server before the row is gone — the only thing missing at
// that instant is this side's next endorsement poll. Rendering "not finished"
// in that window flashes a failure one second before the success that
// contradicts it, which is exactly what a trust screen may not do.
describe("a vanished row that is still settling", () => {
  const RECORD = { done: false, stopped: false, halfDone: false, signedMine: true };

  test("holds the waiting screen instead of blinking the dialog away", () => {
    expect(vanishedCeremonyScreen(RECORD)).toBe("waiting");
  });

  test("shows nothing for a ceremony this side never signed", () => {
    expect(vanishedCeremonyScreen({ ...RECORD, signedMine: false })).toBeNull();
  });

  test("every settled verdict still owns the screen", () => {
    expect(vanishedCeremonyScreen({ ...RECORD, done: true })).toBe("done");
    expect(vanishedCeremonyScreen({ ...RECORD, halfDone: true })).toBe("half-done");
    expect(vanishedCeremonyScreen({ ...RECORD, stopped: true })).toBe("stopped");
    // Stopped outranks the rest: a ceremony that was aborted never becomes a
    // success because a later flag was set on the same record.
    expect(vanishedCeremonyScreen({ ...RECORD, done: true, stopped: true })).toBe("stopped");
  });

  test("the reciprocal is in flight for a window, and absent after it", () => {
    const signedAt = 10_000;
    expect(reciprocalStillSettling(signedAt, signedAt + 500)).toBe(true);
    expect(reciprocalStillSettling(signedAt, signedAt + RECIPROCAL_SETTLE_MS)).toBe(false);
    // A row reaped by the 10-minute TTL long after the entry is not a race —
    // "not finished" is the truth there and must not be held back.
    expect(reciprocalStillSettling(signedAt, signedAt + 600_000)).toBe(false);
  });

  test("a side that never signed has no window to wait out", () => {
    expect(reciprocalStillSettling(null, 10_000)).toBe(false);
  });
});
