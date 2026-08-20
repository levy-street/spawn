import { beforeAll, describe, expect, test } from "bun:test";
import { AccountHealError, planAccountHeal } from "./account-heal";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { encodeBase64Url } from "./signed-signal";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ROOT_ID = uuid(1);
const SELF_ID = uuid(2);
const LAPTOP_ID = uuid(3);
const PHONE_ID = uuid(4);
const ROGUE_ID = uuid(5);
const DEAD_ID = uuid(6);
const ORPHAN_ID = uuid(7);

/** A device identity that can sign real endorsement transcripts. */
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

/** A GENUINE edge: the endorser really signed the daemon's admission transcript. */
async function signedEdge(
  endorser: Signer,
  endorserDeviceId: string,
  endorsedPk: string,
  endorsedDeviceId: string,
) {
  const transcript = encodeAcctEndorsementTranscript(
    ACCOUNT_ID,
    endorser.pk,
    endorsedPk,
    endorsedDeviceId,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, endorser.key, owned),
  );
  return {
    endorser_device_id: endorserDeviceId,
    endorser_public_key: endorser.pk,
    endorsed_device_id: endorsedDeviceId,
    endorsed_public_key: endorsedPk,
    signature: encodeBase64Url(signature),
  };
}

/** A FORGED edge: well-formed fields, but a signature nobody produced. */
function forgedEdge(
  endorserPk: string,
  endorserDeviceId: string,
  endorsedPk: string,
  endorsedDeviceId: string,
) {
  return {
    endorser_device_id: endorserDeviceId,
    endorser_public_key: endorserPk,
    endorsed_device_id: endorsedDeviceId,
    endorsed_public_key: endorsedPk,
    signature: encodeBase64Url(new Uint8Array(64)),
  };
}

function device(id: string, publicKey: string, opts: { revoked?: boolean; isRoot?: boolean } = {}) {
  return {
    id,
    public_key: publicKey,
    revoked_at: opts.revoked ? "2026-08-20T00:00:00Z" : null,
    is_root: opts.isRoot ?? false,
  };
}

let root: Signer;
let self: Signer;
let laptop: Signer;
let phone: Signer;
let rogue: Signer;
let dead: Signer;
let orphan: Signer;
let attacker: Signer;

beforeAll(async () => {
  [root, self, laptop, phone, rogue, dead, orphan, attacker] = await Promise.all([
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
    makeSigner(),
  ]);
});

describe("planAccountHeal", () => {
  test("plans R→d along the verified chain; skips endorsed, revoked, and the root", async () => {
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(LAPTOP_ID, laptop.pk),
      device(PHONE_ID, phone.pk),
      device(DEAD_ID, dead.pk, { revoked: true }),
    ];
    const edges = [
      await signedEdge(root, ROOT_ID, laptop.pk, LAPTOP_ID), // laptop already root-endorsed
      await signedEdge(laptop, LAPTOP_ID, phone.pk, PHONE_ID), // phone ceremony-admitted
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, null, devices, edges);
    expect(plan.rootDevice?.id).toBe(ROOT_ID);
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual([PHONE_ID]);
  });

  test("C1 regression: a waiting/injected device (no verified edges) is never endorsed", async () => {
    // The original attack: the server fabricates a device row (or a real
    // sign-in sits unapproved) and waits for the victim's next passkey moment.
    // The heal must not sign R→that_device — full-mesh access with no ceremony.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk), // the device performing this heal
      device(LAPTOP_ID, laptop.pk), // ceremony-admitted: self endorsed it
      device(ROGUE_ID, rogue.pk), // server-claimed row, nothing behind it
    ];
    const edges = [await signedEdge(self, SELF_ID, laptop.pk, LAPTOP_ID)];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, edges);
    expect(plan.devicesToEndorse.map((d) => d.id).sort()).toEqual([SELF_ID, LAPTOP_ID].sort());
  });

  test("VECTOR A regression: forged or attacker-signed edges create no reachability", async () => {
    // (a1) a fabricated edge claiming the real root key with a bogus signature;
    // (a2) an edge with a VALID signature under the attacker's own key that
    //      name-drops a genuinely trusted device's id as endorser. The walk is
    //      over keys, so neither fires: a1 fails verification, a2 verifies but
    //      the attacker's key is outside the trusted graph.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(LAPTOP_ID, laptop.pk),
      device(ROGUE_ID, rogue.pk),
    ];
    const edges = [
      await signedEdge(root, ROOT_ID, laptop.pk, LAPTOP_ID), // laptop genuinely trusted
      forgedEdge(root.pk, ROOT_ID, rogue.pk, ROGUE_ID), // a1
      await signedEdge(attacker, LAPTOP_ID, rogue.pk, ROGUE_ID), // a2: claims laptop's id
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, null, devices, edges);
    expect(plan.devicesToEndorse.map((d) => d.id)).not.toContain(ROGUE_ID);
    expect(plan.devicesToEndorse).toEqual([]); // laptop is already root-endorsed
  });

  test("VECTOR B regression: server pin-membership claims are not an anchor", async () => {
    // Pin membership is no longer an input to selection AT ALL: the planner's
    // only anchors are the sealed root and this device's own key. A rogue row
    // the server claims is "pinned somewhere" stays out; so does a legitimate
    // pin-only sibling with no edges — it heals itself at its own passkey
    // unlock (TRUST_UX "additional device, passkey"), never via server say-so.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk),
      device(LAPTOP_ID, laptop.pk), // pin-only sibling, no edges
      device(ROGUE_ID, rogue.pk), // rogue "pinned" per the server
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, []);
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual([SELF_ID]);
  });

  test("a verified edge from a revoked device grants no reachability", async () => {
    // dead was even root-endorsed once; revocation removes its key from the
    // walk, so its (genuine) endorsement of orphan no longer carries.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(DEAD_ID, dead.pk, { revoked: true }),
      device(ORPHAN_ID, orphan.pk),
    ];
    const edges = [
      await signedEdge(root, ROOT_ID, dead.pk, DEAD_ID),
      await signedEdge(dead, DEAD_ID, orphan.pk, ORPHAN_ID),
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, null, devices, edges);
    expect(plan.devicesToEndorse).toEqual([]);
  });

  test("the device performing the heal is endorsed with no edges at all (passkey recovery)", async () => {
    // TRUST_UX "additional device, passkey" / recovery after total loss: the
    // fresh device that just proved the passkey is the one seed known
    // firsthand besides the root, so the heal may re-admit it — and only it.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk),
      device(ROGUE_ID, rogue.pk),
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, []);
    expect(plan.currentDevice?.id).toBe(SELF_ID);
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual([SELF_ID]);
  });

  test("a revoked row matching this device's key is not resurrected as self", async () => {
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk, { revoked: true }),
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, []);
    expect(plan.currentDevice).toBeNull();
    expect(plan.devicesToEndorse).toEqual([]);
  });

  test("a server root that differs from the sealed root aborts the heal", async () => {
    // The bundle is the authority on pk_R: a substituted is_root row must never
    // be endorsed or anchored.
    const devices = [device(ROGUE_ID, rogue.pk, { isRoot: true })];
    expect(planAccountHeal(ACCOUNT_ID, root.pk, null, devices, [])).rejects.toThrow(
      AccountHealError,
    );
    try {
      await planAccountHeal(ACCOUNT_ID, root.pk, null, devices, []);
      throw new Error("expected root_conflict");
    } catch (error) {
      expect((error as AccountHealError).code).toBe("root_conflict");
    }
  });

  test("a SECOND live is_root row with a different key also aborts", async () => {
    // Any live is_root row is an authority claim; one matching row must not
    // launder an additional, never-minted root past the provenance check.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(ROGUE_ID, rogue.pk, { isRoot: true }),
      device(LAPTOP_ID, laptop.pk),
    ];
    expect(
      planAccountHeal(ACCOUNT_ID, root.pk, null, devices, [
        await signedEdge(rogue, ROGUE_ID, laptop.pk, LAPTOP_ID),
      ]),
    ).rejects.toThrow(AccountHealError);
  });

  test("a REVOKED conflicting root does not block a fresh one", async () => {
    // Root rotation: the old root's tombstone stays; the new root heals.
    const devices = [
      device(uuid(8), rogue.pk, { isRoot: true, revoked: true }),
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk),
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, []);
    expect(plan.rootDevice?.id).toBe(ROOT_ID);
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual([SELF_ID]);
  });

  test("no registered root yields an empty plan, not an error", async () => {
    const plan = await planAccountHeal(
      ACCOUNT_ID,
      root.pk,
      self.pk,
      [device(SELF_ID, self.pk)],
      [],
    );
    expect(plan.rootDevice).toBeNull();
    expect(plan.devicesToEndorse).toEqual([]);
  });

  test("edges from other endorsers do not count as root endorsements", async () => {
    // A verified self→laptop edge makes laptop reachable, but only a VERIFIED
    // root edge marks a device as already covered — so both still get R→d.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk),
      device(LAPTOP_ID, laptop.pk),
    ];
    const edges = [await signedEdge(self, SELF_ID, laptop.pk, LAPTOP_ID)];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, edges);
    expect(plan.devicesToEndorse.map((d) => d.id).sort()).toEqual([SELF_ID, LAPTOP_ID].sort());
  });

  test("a forged R→d row cannot suppress a legitimate re-endorsement", async () => {
    // Availability twin of vector A: the server plants a bogus "root already
    // endorsed laptop" row to keep laptop off the star. Only verified root
    // edges count as coverage, so laptop is healed anyway.
    const devices = [
      device(ROOT_ID, root.pk, { isRoot: true }),
      device(SELF_ID, self.pk),
      device(LAPTOP_ID, laptop.pk),
    ];
    const edges = [
      await signedEdge(self, SELF_ID, laptop.pk, LAPTOP_ID),
      forgedEdge(root.pk, ROOT_ID, laptop.pk, LAPTOP_ID),
    ];
    const plan = await planAccountHeal(ACCOUNT_ID, root.pk, self.pk, devices, edges);
    expect(plan.devicesToEndorse.map((d) => d.id).sort()).toEqual([SELF_ID, LAPTOP_ID].sort());
  });
});
