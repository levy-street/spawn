import { describe, expect, test } from "bun:test";
import {
  encodeHostIntroductionTranscript,
  HOST_INTRO_TRANSCRIPT_BYTES,
  MAX_HOST_INTRODUCTIONS,
  planHostIntroductionAcceptance,
} from "./host-introduction";
import {
  ed25519PublicKeyFingerprint,
  encodeBase64Url,
  exportEd25519PublicKeyWire,
} from "./signed-signal";

const ACCOUNT = "0b6e6c64-0000-4000-8000-000000000001";
const HOST_ID = "0b6e6c64-0000-4000-8000-00000000000a";

async function keyPair() {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function wire(key: CryptoKey) {
  return exportEd25519PublicKeyWire(key);
}

async function signIntroduction(
  introducer: CryptoKeyPair,
  hostWire: string,
  joinerWire: string,
  accountId = ACCOUNT,
) {
  const transcript = encodeHostIntroductionTranscript(
    accountId,
    await wire(introducer.publicKey),
    hostWire,
    joinerWire,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, introducer.privateKey, owned)),
  );
}

/** Introducer + host + joiner keys, and a genuine signed introduction. */
async function fixture() {
  const introducer = await keyPair();
  const host = await keyPair();
  const joiner = await keyPair();
  const hostWire = await wire(host.publicKey);
  const joinerWire = await wire(joiner.publicKey);
  return {
    introducer,
    introducerWire: await wire(introducer.publicKey),
    hostWire,
    joinerWire,
    signature: await signIntroduction(introducer, hostWire, joinerWire),
  };
}

describe("encodeHostIntroductionTranscript", () => {
  test("fixed length, and every field shifts the bytes", async () => {
    const f = await fixture();
    const base = encodeHostIntroductionTranscript(
      ACCOUNT,
      f.introducerWire,
      f.hostWire,
      f.joinerWire,
    );
    expect(base.byteLength).toBe(HOST_INTRO_TRANSCRIPT_BYTES);
    const other = await keyPair();
    const otherWire = await wire(other.publicKey);
    for (const variant of [
      encodeHostIntroductionTranscript(
        "0b6e6c64-0000-4000-8000-0000000000ff",
        f.introducerWire,
        f.hostWire,
        f.joinerWire,
      ),
      encodeHostIntroductionTranscript(ACCOUNT, otherWire, f.hostWire, f.joinerWire),
      encodeHostIntroductionTranscript(ACCOUNT, f.introducerWire, otherWire, f.joinerWire),
      encodeHostIntroductionTranscript(ACCOUNT, f.introducerWire, f.hostWire, otherWire),
    ]) {
      expect(encodeBase64Url(variant)).not.toBe(encodeBase64Url(base));
    }
  });

  test("a device may not introduce hosts to itself", async () => {
    const f = await fixture();
    expect(() =>
      encodeHostIntroductionTranscript(ACCOUNT, f.introducerWire, f.hostWire, f.introducerWire),
    ).toThrow("may not introduce hosts to itself");
  });
});

describe("planHostIntroductionAcceptance", () => {
  test("accepts a genuine introduction and derives the fingerprint locally", async () => {
    const f = await fixture();
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire,
      ownPublicKey: f.joinerWire,
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: f.hostWire,
          signature: f.signature,
        },
      ],
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]).toMatchObject({
      hostId: HOST_ID,
      hostName: "dream",
      hostPublicKey: f.hostWire,
      hostFingerprint: await ed25519PublicKeyFingerprint(f.hostWire),
    });
  });

  test("rejects a substituted host key — the payload the server would love to swap", async () => {
    const f = await fixture();
    const evilHost = await wire((await keyPair()).publicKey);
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire,
      ownPublicKey: f.joinerWire,
      claimed: [
        { host_id: HOST_ID, host_name: "dream", host_public_key: evilHost, signature: f.signature },
      ],
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  test("rejects a signer other than the ceremony-pinned key", async () => {
    const f = await fixture();
    const rogue = await keyPair();
    const rogueSignature = await signIntroduction(rogue, f.hostWire, f.joinerWire);
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire, // pinned ≠ rogue
      ownPublicKey: f.joinerWire,
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: f.hostWire,
          signature: rogueSignature,
        },
      ],
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  test("rejects a replay minted for a different joiner", async () => {
    const f = await fixture();
    const otherJoiner = await wire((await keyPair()).publicKey);
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire,
      ownPublicKey: otherJoiner, // not the joiner the statement names
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: f.hostWire,
          signature: f.signature,
        },
      ],
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  test("rejects an introduction signed for a different account", async () => {
    const f = await fixture();
    const foreign = await signIntroduction(
      f.introducer,
      f.hostWire,
      f.joinerWire,
      "0b6e6c64-0000-4000-8000-0000000000ee",
    );
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire,
      ownPublicKey: f.joinerWire,
      claimed: [
        { host_id: HOST_ID, host_name: "dream", host_public_key: f.hostWire, signature: foreign },
      ],
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  test("garbage never throws out of the plan; it rejects per item and caps the list", async () => {
    const f = await fixture();
    const overCap = Array.from({ length: MAX_HOST_INTRODUCTIONS + 8 }, () => ({
      host_id: HOST_ID,
      host_name: "dream",
      host_public_key: f.hostWire,
      signature: f.signature,
    }));
    const plan = await planHostIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: f.introducerWire,
      ownPublicKey: f.joinerWire,
      claimed: [
        { host_id: HOST_ID, host_name: "", host_public_key: "not-a-key", signature: "short" },
        ...overCap,
      ],
    });
    expect(plan.accepted.length + plan.rejected.length).toBeLessThanOrEqual(MAX_HOST_INTRODUCTIONS);
    expect(plan.rejected.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Continuous gossip
// ---------------------------------------------------------------------------

import {
  DEVICE_INTRO_TRANSCRIPT_BYTES,
  encodeDeviceIntroductionTranscript,
  encodeHostIntroductionBroadcastTranscript,
  HOST_INTRO_BCAST_TRANSCRIPT_BYTES,
  planBroadcastIntroductionAcceptance,
  planDeviceIntroductionAcceptance,
} from "./host-introduction";

async function signBroadcast(publisher: CryptoKeyPair, hostWire: string, accountId = ACCOUNT) {
  const transcript = encodeHostIntroductionBroadcastTranscript(
    accountId,
    await wire(publisher.publicKey),
    hostWire,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, publisher.privateKey, owned)),
  );
}

describe("encodeHostIntroductionBroadcastTranscript", () => {
  test("fixed length, distinct domain, every field shifts the bytes", async () => {
    const f = await fixture();
    const base = encodeHostIntroductionBroadcastTranscript(ACCOUNT, f.introducerWire, f.hostWire);
    expect(base.byteLength).toBe(HOST_INTRO_BCAST_TRANSCRIPT_BYTES);
    // Never byte-compatible with the ceremony-scoped transcript.
    expect(base.byteLength).not.toBe(HOST_INTRO_TRANSCRIPT_BYTES);
    const other = await keyPair();
    const otherWire = await wire(other.publicKey);
    for (const variant of [
      encodeHostIntroductionBroadcastTranscript(
        "0b6e6c64-0000-4000-8000-0000000000ff",
        f.introducerWire,
        f.hostWire,
      ),
      encodeHostIntroductionBroadcastTranscript(ACCOUNT, otherWire, f.hostWire),
      encodeHostIntroductionBroadcastTranscript(ACCOUNT, f.introducerWire, otherWire),
    ]) {
      expect(encodeBase64Url(variant)).not.toBe(encodeBase64Url(base));
    }
  });
});

describe("planBroadcastIntroductionAcceptance", () => {
  test("accepts a valid row from a firsthand-known publisher and derives the fingerprint locally", async () => {
    const publisher = await keyPair();
    const publisherWire = await wire(publisher.publicKey);
    const host = await keyPair();
    const hostWire = await wire(host.publicKey);
    const own = await keyPair();
    const plan = await planBroadcastIntroductionAcceptance({
      accountId: ACCOUNT,
      ownPublicKey: await wire(own.publicKey),
      trustedPeerKeys: new Set([publisherWire]),
      claimed: [
        {
          publisher_device_id: "d-1",
          publisher_public_key: publisherWire,
          host_id: HOST_ID,
          host_name: "minivac",
          host_public_key: hostWire,
          signature: await signBroadcast(publisher, hostWire),
        },
      ],
    });
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.hostFingerprint).toBe(await ed25519PublicKeyFingerprint(hostWire));
    expect(plan.unknownPublisher).toBe(0);
    expect(plan.rejected).toHaveLength(0);
  });

  test("THE TRAP: a self-signed row from a key nobody learned firsthand moves no trust", async () => {
    // A hostile server can mint a keypair, claim it as a "publisher", and
    // self-sign a perfectly valid broadcast. The signature verifies under its
    // own claimed key — and must still be worthless, because the key is not in
    // the firsthand store. This is exactly why the store must never be seeded
    // from server-claimed metadata (endorsement edges included).
    const attacker = await keyPair();
    const attackerWire = await wire(attacker.publicKey);
    const evilHost = await keyPair();
    const evilHostWire = await wire(evilHost.publicKey);
    const own = await keyPair();
    const plan = await planBroadcastIntroductionAcceptance({
      accountId: ACCOUNT,
      ownPublicKey: await wire(own.publicKey),
      trustedPeerKeys: new Set(), // firsthand memory is empty
      claimed: [
        {
          publisher_device_id: "d-evil",
          publisher_public_key: attackerWire,
          host_id: HOST_ID,
          host_name: "evil",
          host_public_key: evilHostWire,
          signature: await signBroadcast(attacker, evilHostWire),
        },
      ],
    });
    expect(plan.accepted).toHaveLength(0);
    expect(plan.unknownPublisher).toBe(1);
    expect(plan.rejected).toHaveLength(0); // not an error — just never trusted
  });

  test("a tampered host key is rejected; own rows are skipped", async () => {
    const publisher = await keyPair();
    const publisherWire = await wire(publisher.publicKey);
    const host = await keyPair();
    const hostWire = await wire(host.publicKey);
    const substituted = await wire((await keyPair()).publicKey);
    const own = await keyPair();
    const ownWire = await wire(own.publicKey);
    const signature = await signBroadcast(publisher, hostWire);
    const plan = await planBroadcastIntroductionAcceptance({
      accountId: ACCOUNT,
      ownPublicKey: ownWire,
      trustedPeerKeys: new Set([publisherWire, ownWire]),
      claimed: [
        {
          publisher_device_id: "d-1",
          publisher_public_key: publisherWire,
          host_id: HOST_ID,
          host_name: "swapped",
          host_public_key: substituted, // signature no longer covers this key
          signature,
        },
        {
          publisher_device_id: "d-me",
          publisher_public_key: ownWire,
          host_id: HOST_ID,
          host_name: "mine",
          host_public_key: hostWire,
          signature,
        },
      ],
    });
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
  });

  test("a wrong-account signature is rejected", async () => {
    const publisher = await keyPair();
    const publisherWire = await wire(publisher.publicKey);
    const host = await keyPair();
    const hostWire = await wire(host.publicKey);
    const own = await keyPair();
    const plan = await planBroadcastIntroductionAcceptance({
      accountId: ACCOUNT,
      ownPublicKey: await wire(own.publicKey),
      trustedPeerKeys: new Set([publisherWire]),
      claimed: [
        {
          publisher_device_id: "d-1",
          publisher_public_key: publisherWire,
          host_id: HOST_ID,
          host_name: "cross-account",
          host_public_key: hostWire,
          signature: await signBroadcast(
            publisher,
            hostWire,
            "0b6e6c64-0000-4000-8000-0000000000ff",
          ),
        },
      ],
    });
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
  });
});

describe("planDeviceIntroductionAcceptance", () => {
  const PEER_DEVICE_ID = "0b6e6c64-0000-4000-8000-00000000000b";

  async function signDeviceIntro(
    introducer: CryptoKeyPair,
    peerWire: string,
    joinerWire: string,
    peerDeviceId = PEER_DEVICE_ID,
  ) {
    const transcript = encodeDeviceIntroductionTranscript(
      ACCOUNT,
      await wire(introducer.publicKey),
      peerWire,
      peerDeviceId,
      joinerWire,
    );
    const owned = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(owned).set(transcript);
    return encodeBase64Url(
      new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, introducer.privateKey, owned)),
    );
  }

  test("fixed length and byte-shifts on every field", async () => {
    const introducer = await keyPair();
    const peer = await keyPair();
    const joiner = await keyPair();
    const base = encodeDeviceIntroductionTranscript(
      ACCOUNT,
      await wire(introducer.publicKey),
      await wire(peer.publicKey),
      PEER_DEVICE_ID,
      await wire(joiner.publicKey),
    );
    expect(base.byteLength).toBe(DEVICE_INTRO_TRANSCRIPT_BYTES);
    const variant = encodeDeviceIntroductionTranscript(
      ACCOUNT,
      await wire(introducer.publicKey),
      await wire(peer.publicKey),
      "0b6e6c64-0000-4000-8000-0000000000ff",
      await wire(joiner.publicKey),
    );
    expect(encodeBase64Url(variant)).not.toBe(encodeBase64Url(base));
  });

  test("accepts a genuine handover, rejects a substituted peer key, skips self and introducer", async () => {
    const introducer = await keyPair();
    const introducerWire = await wire(introducer.publicKey);
    const peer = await keyPair();
    const peerWire = await wire(peer.publicKey);
    const joiner = await keyPair();
    const joinerWire = await wire(joiner.publicKey);
    const substituted = await wire((await keyPair()).publicKey);
    const genuine = await signDeviceIntro(introducer, peerWire, joinerWire);
    const plan = await planDeviceIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: introducerWire,
      ownPublicKey: joinerWire,
      claimed: [
        {
          device_id: PEER_DEVICE_ID,
          device_label: "Mac",
          device_public_key: peerWire,
          signature: genuine,
        },
        {
          device_id: PEER_DEVICE_ID,
          device_label: "swapped",
          device_public_key: substituted,
          signature: genuine,
        },
        {
          device_id: PEER_DEVICE_ID,
          device_label: "me",
          device_public_key: joinerWire,
          signature: genuine,
        },
        {
          device_id: PEER_DEVICE_ID,
          device_label: "the approver",
          device_public_key: introducerWire,
          signature: genuine,
        },
      ],
    });
    expect(plan.accepted.map((peerIntro) => peerIntro.devicePublicKey)).toEqual([peerWire]);
    expect(plan.rejected).toHaveLength(1);
  });

  test("a replay toward a different joiner never verifies", async () => {
    const introducer = await keyPair();
    const peer = await keyPair();
    const peerWire = await wire(peer.publicKey);
    const intendedJoiner = await keyPair();
    const otherJoiner = await keyPair();
    const signature = await signDeviceIntro(
      introducer,
      peerWire,
      await wire(intendedJoiner.publicKey),
    );
    const plan = await planDeviceIntroductionAcceptance({
      accountId: ACCOUNT,
      pinnedIntroducerPublicKey: await wire(introducer.publicKey),
      ownPublicKey: await wire(otherJoiner.publicKey),
      claimed: [
        {
          device_id: PEER_DEVICE_ID,
          device_label: "Mac",
          device_public_key: peerWire,
          signature,
        },
      ],
    });
    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
  });
});
