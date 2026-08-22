import { beforeAll, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  type ClaimedRootIntroduction,
  encodeRootIntroductionTranscript,
  planRootAnchorSweep,
  planRootIntroductionAcceptance,
  ROOT_INTRO_TRANSCRIPT_BYTES,
} from "./root-introduction";
import {
  loadFirsthandRoot,
  RootKnowledgeConflictError,
  rememberFirsthandRoot,
} from "./root-knowledge";
import { encodeBase64Url } from "./signed-signal";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORIGIN = "https://spawn.test";

interface Signer {
  pk: string;
  key: CryptoKey;
}

async function makeSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pk: encodeBase64Url(raw), key: pair.privateKey };
}

async function signedIntro(
  introducer: Signer,
  rootPk: string,
  deviceId = "00000000-0000-4000-8000-000000000001",
): Promise<ClaimedRootIntroduction> {
  const transcript = encodeRootIntroductionTranscript(ACCOUNT_ID, introducer.pk, rootPk);
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, introducer.key, owned),
  );
  return {
    introducer_device_id: deviceId,
    introducer_public_key: introducer.pk,
    root_public_key: rootPk,
    signature: encodeBase64Url(signature),
  };
}

let peer: Signer;
let stranger: Signer;
let root: Signer;
let successor: Signer;
let own: Signer;

beforeAll(async () => {
  [peer, stranger, root, successor, own] = await Promise.all([
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
  ]);
});

describe("encodeRootIntroductionTranscript", () => {
  test("shared cross-runtime vector matches the server's bytes", async () => {
    // The same fixed inputs (Ed25519 keys from the all-0x07 and all-0x0b
    // seeds) are asserted in tests/test_root_introductions.py; a drift on
    // either side silently forks the signed bytes.
    const introducer = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
    const rootKey = "Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo";
    const transcript = encodeRootIntroductionTranscript(ACCOUNT_ID, introducer, rootKey);
    expect(transcript.byteLength).toBe(100);
    expect(ROOT_INTRO_TRANSCRIPT_BYTES).toBe(100);
    const owned = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(owned).set(transcript);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("e96fcac0039e3ceedce84e4b1f055975efe6be19da4aba71c2ce2bd75ddf5389");
  });

  test("a key may not introduce itself as the root", () => {
    expect(() => encodeRootIntroductionTranscript(ACCOUNT_ID, peer.pk, peer.pk)).toThrow(
      /may not introduce itself/,
    );
  });
});

describe("planRootIntroductionAcceptance", () => {
  const base = () => ({
    accountId: ACCOUNT_ID,
    ownPublicKey: own.pk,
    devices: [] as { public_key: string; revoked_at: string | null }[],
    tombstonedKeys: [] as string[],
  });

  test("a verified introduction from a firsthand peer is accepted", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: null,
      claimed: [await signedIntro(peer, root.pk)],
    });
    expect(plan.accept).toBe(root.pk);
    expect(plan.conflicts).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  test("TRAP: an unknown introducer's self-consistent row moves no trust", async () => {
    // The attacker shape: the server registers its own device row and signs a
    // valid introduction of ITS root under its own key. Nothing verified it
    // firsthand, so honoring it would be a forged-anchor path (P2).
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: null,
      claimed: [await signedIntro(stranger, root.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.unknownIntroducer).toBe(1);
    expect(plan.conflicts).toEqual([]);
  });

  test("a tampered root key kills the signature", async () => {
    const intro = await signedIntro(peer, root.pk);
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: null,
      claimed: [{ ...intro, root_public_key: successor.pk }],
    });
    expect(plan.accept).toBeNull();
    expect(plan.rejected.length).toBe(1);
  });

  test("the signature must verify under the FIRSTHAND key, not the claimed one", async () => {
    // A row claiming the peer's identity but signed by the stranger: the
    // firsthand copy is what the bytes are checked against.
    const forged = { ...(await signedIntro(stranger, root.pk)), introducer_public_key: peer.pk };
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: null,
      claimed: [forged],
    });
    expect(plan.accept).toBeNull();
    expect(plan.rejected.length).toBe(1);
  });

  test("CONFLICT: introductions naming different roots record nothing, loudly", async () => {
    const other = await makeSigner();
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk, other.pk]),
      knownRootPublicKey: null,
      claimed: [await signedIntro(peer, root.pk), await signedIntro(other, successor.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.conflicts.length).toBe(1);
  });

  test("CONFLICT: a different root than the held one, old root not corroborated-dead", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: root.pk,
      claimed: [await signedIntro(peer, successor.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.conflicts.length).toBe(1);
  });

  test("a half-corroborated old-root revocation (roster only) still refuses", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      devices: [{ public_key: root.pk, revoked_at: "2026-08-22T00:00:00Z" }],
      tombstonedKeys: [],
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: root.pk,
      claimed: [await signedIntro(peer, successor.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.conflicts.length).toBe(1);
  });

  test("ROTATION: a unanimous successor is accepted once the old root is corroborated dead", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      devices: [{ public_key: root.pk, revoked_at: "2026-08-22T00:00:00Z" }],
      tombstonedKeys: [root.pk],
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: root.pk,
      claimed: [await signedIntro(peer, successor.pk)],
    });
    expect(plan.accept).toBe(successor.pk);
    expect(plan.conflicts).toEqual([]);
  });

  test("agreement with the held root changes nothing and raises nothing", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: root.pk,
      claimed: [await signedIntro(peer, root.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.conflicts).toEqual([]);
  });

  test("a tombstoned candidate is never adopted (R10: tombstones are permanent)", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      tombstonedKeys: [root.pk],
      trustedPeerKeys: new Set([peer.pk]),
      knownRootPublicKey: null,
      claimed: [await signedIntro(peer, root.pk)],
    });
    expect(plan.accept).toBeNull();
  });

  test("this device's own rows are skipped without judging them", async () => {
    const plan = await planRootIntroductionAcceptance({
      ...base(),
      trustedPeerKeys: new Set([own.pk]),
      knownRootPublicKey: null,
      claimed: [await signedIntro(own, root.pk)],
    });
    expect(plan.accept).toBeNull();
    expect(plan.unknownIntroducer).toBe(0);
    expect(plan.rejected).toEqual([]);
  });
});

describe("planRootAnchorSweep", () => {
  const HOST_A = "00000000-0000-4000-8000-00000000000a";
  const HOST_B = "00000000-0000-4000-8000-00000000000b";
  const OWN_DEVICE = "00000000-0000-4000-8000-000000000101";
  const ROOT_DEVICE = "00000000-0000-4000-8000-000000000102";
  const KEY_A = "A".repeat(43);
  const KEY_B = "B".repeat(43);

  test("signs only for hosts where THIS device is pinned and the root is not", () => {
    const targets = planRootAnchorSweep({
      ownDeviceId: OWN_DEVICE,
      rootDeviceId: ROOT_DEVICE,
      pins: [
        { hostPublicKey: KEY_A, hostIds: [HOST_A] },
        { hostPublicKey: KEY_B, hostIds: [HOST_B] },
      ],
      pinsByHost: new Map([
        [HOST_A, [OWN_DEVICE]], // pinned, unanchored → target
        [HOST_B, ["someone-else"]], // not pinned → the 409 gate would refuse
      ]),
    });
    expect(targets).toEqual([{ hostId: HOST_A, hostPublicKey: KEY_A }]);
  });

  test("idempotence: an already-anchored host is never re-targeted", () => {
    const targets = planRootAnchorSweep({
      ownDeviceId: OWN_DEVICE,
      rootDeviceId: ROOT_DEVICE,
      pins: [{ hostPublicKey: KEY_A, hostIds: [HOST_A] }],
      pinsByHost: new Map([[HOST_A, [OWN_DEVICE, ROOT_DEVICE]]]),
    });
    expect(targets).toEqual([]);
  });

  test("a host with no advisory pin data yet is skipped, not guessed at", () => {
    const targets = planRootAnchorSweep({
      ownDeviceId: OWN_DEVICE,
      rootDeviceId: ROOT_DEVICE,
      pins: [{ hostPublicKey: KEY_A, hostIds: [HOST_A] }],
      pinsByHost: new Map(),
    });
    expect(targets).toEqual([]);
  });

  test("only LOCAL pins produce targets — no local pin, no statement", () => {
    // The host key signed into the endorsement comes from the local pin store
    // (firsthand); a host known only from server rows is never swept.
    const targets = planRootAnchorSweep({
      ownDeviceId: OWN_DEVICE,
      rootDeviceId: ROOT_DEVICE,
      pins: [],
      pinsByHost: new Map([[HOST_A, [OWN_DEVICE]]]),
    });
    expect(targets).toEqual([]);
  });
});

describe("rememberFirsthandRoot (durable provenance memory)", () => {
  const storage = () => ({ indexedDBFactory: new IDBFactory(), now: () => 1_000 });

  test("mint records, introduction of the same key refreshes quietly", async () => {
    const s = storage();
    await rememberFirsthandRoot(
      { accountId: ACCOUNT_ID, origin: ORIGIN, rootPublicKey: root.pk, source: "mint" },
      s,
    );
    await rememberFirsthandRoot(
      { accountId: ACCOUNT_ID, origin: ORIGIN, rootPublicKey: root.pk, source: "introduction" },
      s,
    );
    const held = await loadFirsthandRoot({ accountId: ACCOUNT_ID, origin: ORIGIN }, s);
    expect(held?.rootPublicKey).toBe(root.pk);
  });

  test("an introduction never silently replaces a DIFFERENT held key", async () => {
    const s = storage();
    await rememberFirsthandRoot(
      { accountId: ACCOUNT_ID, origin: ORIGIN, rootPublicKey: root.pk, source: "bundle" },
      s,
    );
    await expect(
      rememberFirsthandRoot(
        {
          accountId: ACCOUNT_ID,
          origin: ORIGIN,
          rootPublicKey: successor.pk,
          source: "introduction",
        },
        s,
      ),
    ).rejects.toBeInstanceOf(RootKnowledgeConflictError);
    const held = await loadFirsthandRoot({ accountId: ACCOUNT_ID, origin: ORIGIN }, s);
    expect(held?.rootPublicKey).toBe(root.pk);
  });

  test("replace (corroborated rotation) and bundle sources may supersede", async () => {
    const s = storage();
    await rememberFirsthandRoot(
      { accountId: ACCOUNT_ID, origin: ORIGIN, rootPublicKey: root.pk, source: "introduction" },
      s,
    );
    await rememberFirsthandRoot(
      {
        accountId: ACCOUNT_ID,
        origin: ORIGIN,
        rootPublicKey: successor.pk,
        source: "introduction",
        replace: true,
      },
      s,
    );
    expect(
      (await loadFirsthandRoot({ accountId: ACCOUNT_ID, origin: ORIGIN }, s))?.rootPublicKey,
    ).toBe(successor.pk);
    // The bundle (passkey-authenticated, rollback-floored) always wins.
    await rememberFirsthandRoot(
      { accountId: ACCOUNT_ID, origin: ORIGIN, rootPublicKey: root.pk, source: "bundle" },
      s,
    );
    expect(
      (await loadFirsthandRoot({ accountId: ACCOUNT_ID, origin: ORIGIN }, s))?.rootPublicKey,
    ).toBe(root.pk);
  });
});
