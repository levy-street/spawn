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
