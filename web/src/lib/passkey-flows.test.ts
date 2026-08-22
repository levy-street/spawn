import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { exportAccountRootMaterial, generateAccountRoot } from "./account-root";
import { ApiError } from "./api";
import {
  approveBrowserHostPin,
  listActiveBrowserHostPins,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import {
  addBackupPasskey,
  type DeviceRosterRow,
  describeUnlockImport,
  type PasskeyFlowsIo,
  type PasskeyRow,
  removeBackupPasskey,
  removeLastPasskey,
  type StoredBundleRow,
  setUpPasskey,
  UnreadableTrustStateError,
  unlockCredentialOffer,
  unlockPasskey,
} from "./passkey-flows";
import { PasskeyPrfError } from "./passkey-prf";
import { ed25519PublicKeyFingerprint } from "./signed-signal";
import { sealCurrentTrust } from "./trust-bootstrap";
import { MAX_RETIRED_ROOTS } from "./trust-bundle";
import { openTrustEnvelope, type PasskeyWrapInput, sealTrustEnvelope } from "./trust-envelope";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

function secretFor(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

/**
 * A fake server + authenticator pair implementing EXACTLY the contracts the
 * flows rely on: putBundle's create/replace CAS, deleteBundle's CAS, the
 * enrolled-credential list, and an authenticator that answers only for
 * credentials it actually holds (like allowCredentials does). The envelope,
 * pin-store, and rollback-floor logic underneath stays real.
 */
class Harness {
  readonly log: string[] = [];
  bundle: { sealed: string; revision: number } | null = null;
  passkeyRows: { id: string; credential_id: string }[] = [];
  roster: DeviceRosterRow[] = [];
  tombstonedKeys: string[] = [];
  revokedRows: { id: string; public_key: string }[] = [];
  /** credentialId → PRF secret this authenticator can produce. */
  authenticator = new Map<string, Uint8Array>();
  private nextCredential = 1;
  failAddPasskeyTimes = 0;
  failPutBundleWith: unknown = null;
  failDeleteBundleWith: unknown = null;
  failGetBundleWith: unknown = null;
  readonly pinStorage = { indexedDBFactory: new IDBFactory() };

  get scope() {
    return { accountId: ACCOUNT, origin: ORIGIN, pinStorage: this.pinStorage };
  }

  io(overrides: Partial<PasskeyFlowsIo> = {}): PasskeyFlowsIo {
    return {
      scope: this.scope,
      userLabel: "operator@example.com",
      trust: {
        getBundle: async (): Promise<StoredBundleRow | null> => {
          this.log.push("getBundle");
          if (this.failGetBundleWith !== null) throw this.failGetBundleWith;
          return this.bundle === null ? null : { ...this.bundle };
        },
        putBundle: async (sealed: string, expectedRevision?: number) => {
          this.log.push(`putBundle:${expectedRevision ?? "create"}`);
          if (this.failPutBundleWith !== null) throw this.failPutBundleWith;
          if (this.bundle === null) {
            if (expectedRevision !== undefined && expectedRevision !== 0) {
              throw new ApiError(409, "conflict", "no stored trust bundle to replace");
            }
            this.bundle = { sealed, revision: 1 };
            return;
          }
          if (expectedRevision !== this.bundle.revision) {
            throw new ApiError(409, "conflict", "trust bundle changed since it was read");
          }
          this.bundle = { sealed, revision: this.bundle.revision + 1 };
        },
        deleteBundle: async (expectedRevision: number) => {
          this.log.push(`deleteBundle:${expectedRevision}`);
          if (this.failDeleteBundleWith !== null) throw this.failDeleteBundleWith;
          if (this.bundle === null) return;
          if (this.bundle.revision !== expectedRevision) {
            throw new ApiError(409, "conflict", "trust bundle changed since it was read");
          }
          this.bundle = null;
        },
        listPasskeys: async () => this.passkeyRows.map((row) => ({ ...row })),
        addPasskey: async (credentialId: string, label?: string) => {
          this.log.push(`addPasskey:${credentialId}`);
          if (this.failAddPasskeyTimes > 0) {
            this.failAddPasskeyTimes -= 1;
            throw new ApiError(500, "server_error", "enrollment failed");
          }
          // Idempotent, like the real route.
          if (!this.passkeyRows.some((row) => row.credential_id === credentialId)) {
            this.passkeyRows.push({ id: `row-${credentialId}`, credential_id: credentialId });
          }
          void label;
        },
        removePasskey: async (id: string) => {
          this.log.push(`removePasskey:${id}`);
          const before = this.passkeyRows.length;
          this.passkeyRows = this.passkeyRows.filter((row) => row.id !== id);
          if (this.passkeyRows.length === before) {
            throw new ApiError(404, "not_found", "passkey not found");
          }
        },
      },
      browserDevices: {
        list: async () => this.roster.map((row) => ({ ...row })),
        revoke: async (deviceId: string, expectedPublicKey: string) => {
          this.log.push(`revokeDevice:${deviceId}`);
          this.revokedRows.push({ id: deviceId, public_key: expectedPublicKey });
        },
        revokedKeys: async () => this.tombstonedKeys.map((public_key) => ({ public_key })),
      },
      createTrustPasskey: async () => {
        const credentialId = `cred-${this.nextCredential}`;
        this.authenticator.set(credentialId, secretFor(this.nextCredential));
        this.nextCredential += 1;
        this.log.push(`create:${credentialId}`);
        return { credentialId, prfEnabled: true };
      },
      evaluateTrustPrf: async (_accountId: string, credentialIds: readonly string[]) => {
        this.log.push(`evaluate:${[...credentialIds].sort().join(",")}`);
        for (const credentialId of credentialIds) {
          const secret = this.authenticator.get(credentialId);
          if (secret !== undefined) return { credentialId, secret };
        }
        throw new PasskeyPrfError("no_credential", "no passkey was available for this account");
      },
      heal: async (root, hosts, source) => {
        this.log.push(`heal:${source}:${hosts.length}`);
        void root;
        return { report: null, failure: null };
      },
      ...overrides,
    };
  }

  /** Enroll a credential in the fake authenticator + server list directly. */
  listCredential(credentialId: string, secret?: Uint8Array): PasskeyRow {
    if (secret !== undefined) this.authenticator.set(credentialId, secret);
    const row = { id: `row-${credentialId}`, credential_id: credentialId };
    this.passkeyRows.push(row);
    return row;
  }

  wrapInput(credentialId: string): PasskeyWrapInput {
    const secret = this.authenticator.get(credentialId);
    if (secret === undefined) throw new Error(`test bug: no secret for ${credentialId}`);
    return { credentialId, prfSecret: secret };
  }
}

async function pinHost(harness: Harness, hostKey: string): Promise<void> {
  await approveBrowserHostPin(
    {
      accountId: ACCOUNT,
      origin: ORIGIN,
      hostPublicKey: hostKey,
      hostFingerprint: await ed25519PublicKeyFingerprint(hostKey),
    },
    harness.pinStorage,
  );
}

/** Seal a bundle directly into the fake server, wrapped for `credentialId`. */
async function storeBundle(
  harness: Harness,
  credentialId: string,
  seed: number,
  withRoot = false,
): Promise<void> {
  harness.authenticator.set(credentialId, secretFor(seed));
  const root = withRoot ? await exportAccountRootMaterial(await generateAccountRoot()) : null;
  const { sealed, revision } = await sealCurrentTrust(
    harness.wrapInput(credentialId),
    harness.scope,
    0,
    root,
  );
  harness.bundle = { sealed, revision };
}

// ---------------------------------------------------------------------------
// setUp: seal-before-enroll (P-C5)
// ---------------------------------------------------------------------------

describe("setUpPasskey ordering (P-C5)", () => {
  test("the bundle is stored BEFORE the server learns the credential", async () => {
    const harness = new Harness();
    const outcome = await setUpPasskey(harness.io());
    expect(outcome.hostCount).toBe(0);
    const put = harness.log.findIndex((entry) => entry.startsWith("putBundle"));
    const add = harness.log.findIndex((entry) => entry.startsWith("addPasskey"));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(put);
    // The stored wrap opens, and the credential it names is the enrolled one.
    expect(harness.bundle).not.toBeNull();
    const opened = await openTrustEnvelope(
      ACCOUNT,
      harness.bundle!.sealed,
      harness.wrapInput(harness.passkeyRows[0].credential_id),
    );
    expect(opened.root).not.toBeNull();
    expect(harness.log.some((entry) => entry === "heal:mint:0")).toBe(true);
  });

  test("a putBundle CAS loss enrolls NOTHING and points at Use passkey", async () => {
    const harness = new Harness();
    harness.failPutBundleWith = new ApiError(409, "conflict", "created concurrently");
    await expect(setUpPasskey(harness.io())).rejects.toThrow("Use passkey");
    // No ghost: the server never learned the credential.
    expect(harness.passkeyRows).toHaveLength(0);
    expect(harness.log.some((entry) => entry.startsWith("addPasskey"))).toBe(false);
  });

  test("partial setup (enrollment failed after the seal) retries without deadlock", async () => {
    const harness = new Harness();
    harness.failAddPasskeyTimes = 1;
    // The setup fails AFTER the bundle stored — the exact half-finished state.
    await expect(setUpPasskey(harness.io())).rejects.toThrow("enrollment failed");
    expect(harness.bundle).not.toBeNull();
    expect(harness.passkeyRows).toHaveLength(0);

    // Re-running setup refuses (a bundle exists) and directs to Use passkey…
    await expect(setUpPasskey(harness.io())).rejects.toThrow("Use passkey");

    // …and Use passkey actually works: with an EMPTY server list, the unlock
    // offers the envelope's own wrap and repairs the enrollment afterwards.
    const outcome = await unlockPasskey(harness.io());
    expect(outcome.enrollmentRepaired).toBe(true);
    expect(outcome.repairFailure).toBeNull();
    expect(harness.passkeyRows).toHaveLength(1);
    const wrapId = harness.passkeyRows[0].credential_id;
    expect(harness.authenticator.has(wrapId)).toBe(true);
    // The offered list was the wrap, not the (empty) server list.
    expect(harness.log).toContain(`evaluate:${wrapId}`);
  });
});

// ---------------------------------------------------------------------------
// unlock: honest credential offer (P-C5)
// ---------------------------------------------------------------------------

describe("unlock credential offer (P-C5)", () => {
  test("unlockCredentialOffer intersects, falls back to wraps, refuses nothing-opens", () => {
    expect(unlockCredentialOffer(["a", "b", "ghost"], ["b", "a"])).toEqual({
      offer: ["a", "b"],
      repairNeeded: false,
    });
    expect(unlockCredentialOffer(["ghost"], ["real"])).toEqual({
      offer: ["real"],
      repairNeeded: true,
    });
    expect(() => unlockCredentialOffer(["ghost"], [])).toThrow("cannot be used");
  });

  test("a ghost in the server list is never offered at unlock", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-real", 7, true);
    harness.listCredential("cred-real");
    // The ghost is server-listed AND present on the authenticator — the old
    // code offered it, and its gesture opened nothing.
    harness.listCredential("cred-ghost", secretFor(9));

    const outcome = await unlockPasskey(harness.io());
    expect(outcome.enrollmentRepaired).toBe(false);
    expect(harness.log).toContain("evaluate:cred-real");
    expect(harness.log.some((entry) => entry.includes("cred-ghost"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ghost removal + wrap-aware two-passkey rule (P-C5 escape hatch)
// ---------------------------------------------------------------------------

describe("removeBackupPasskey", () => {
  test("a ghost is removed after a working passkey proves the envelope; no reseal", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-real", 7);
    harness.listCredential("cred-real");
    const ghost = harness.listCredential("cred-ghost", secretFor(9));

    const putCallsBefore = harness.log.filter((e) => e.startsWith("putBundle")).length;
    const outcome = await removeBackupPasskey(harness.io(), ghost);
    expect(outcome).toEqual({ kind: "ghost" });
    // Authorized by the WORKING passkey, not the ghost.
    expect(harness.log).toContain("evaluate:cred-real");
    // Row gone; bundle untouched (no reseal, no revision change).
    expect(harness.passkeyRows.map((row) => row.credential_id)).toEqual(["cred-real"]);
    expect(harness.log.filter((e) => e.startsWith("putBundle")).length).toBe(putCallsBefore);
    expect(harness.bundle!.revision).toBe(1);
  });

  test("ghost removal refuses when no other passkey can open the envelope", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-elsewhere", 7);
    // Neither listed row holds a wrap; nothing here can prove anything.
    const ghostA = harness.listCredential("cred-ghost-a", secretFor(8));
    harness.listCredential("cred-ghost-b", secretFor(9));
    await expect(removeBackupPasskey(harness.io(), ghostA)).rejects.toThrow(
      "No other passkey here can open",
    );
    expect(harness.passkeyRows).toHaveLength(2); // untouched: both rows remain
  });

  test("the two-passkey rule counts WRAP-holders, so a ghost row does not block it", async () => {
    const harness = new Harness();
    // Two real wraps…
    harness.authenticator.set("cred-a", secretFor(1));
    harness.authenticator.set("cred-b", secretFor(2));
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [],
      [harness.wrapInput("cred-a"), harness.wrapInput("cred-b")],
      1,
    );
    harness.bundle = { sealed, revision: 1 };
    harness.listCredential("cred-a");
    const rowB = harness.listCredential("cred-b");
    // …plus a ghost row that would have made count()===3 and blocked removal.
    harness.listCredential("cred-ghost", secretFor(9));

    const outcome = await removeBackupPasskey(harness.io(), rowB);
    expect(outcome).toEqual({ kind: "resealed" });
    // The survivor unlocked and the bundle resealed for it alone.
    expect(harness.log).toContain("evaluate:cred-a");
    expect(harness.bundle!.revision).toBe(2);
    const opened = await openTrustEnvelope(
      ACCOUNT,
      harness.bundle!.sealed,
      harness.wrapInput("cred-a"),
    );
    expect(opened.revision).toBeGreaterThan(1);
    await expect(
      openTrustEnvelope(ACCOUNT, harness.bundle!.sealed, harness.wrapInput("cred-b")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Final removal: unreadable-bundle acknowledgement + delete CAS (P-C6, fix 4)
// ---------------------------------------------------------------------------

describe("removeLastPasskey", () => {
  test("an unreadable bundle is only abandoned under explicit acknowledgement", async () => {
    const harness = new Harness();
    // The bundle exists but its wrap names a credential this row is not:
    // the open fails, honestly unreadable from here.
    await storeBundle(harness, "cred-lost", 7);
    const row = harness.listCredential("cred-a", secretFor(1));
    // A live root row on the roster: the loud-skip path must be exercised.
    harness.roster = [
      { id: "root-row", public_key: "R".repeat(43), revoked_at: null, is_root: true },
    ];

    await expect(removeLastPasskey(harness.io(), row)).rejects.toBeInstanceOf(
      UnreadableTrustStateError,
    );
    // First ask destroys NOTHING.
    expect(harness.bundle).not.toBeNull();
    expect(harness.passkeyRows).toHaveLength(1);
    expect(harness.revokedRows).toHaveLength(0);

    const outcome = await removeLastPasskey(harness.io(), row, { acknowledgeUnreadable: true });
    expect(harness.bundle).toBeNull();
    expect(harness.passkeyRows).toHaveLength(0);
    // The live root row was NOT revoked on the server's word (hardening B3),
    // and the skip is loud.
    expect(harness.revokedRows).toHaveLength(0);
    expect(outcome.skippedRootReason).toContain("could not be opened");
  });

  test("a transient bundle-fetch failure fails the operation outright", async () => {
    const harness = new Harness();
    const row = harness.listCredential("cred-a", secretFor(1));
    harness.failGetBundleWith = new ApiError(502, "bad_gateway", "upstream flaked");
    await expect(
      removeLastPasskey(harness.io(), row, { acknowledgeUnreadable: true }),
    ).rejects.toThrow("upstream flaked");
    expect(harness.passkeyRows).toHaveLength(1);
  });

  test("losing the delete CAS keeps the passkey and says what happened", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-a", 1);
    const row = harness.listCredential("cred-a");
    // Another device replaced the bundle after our read (its backup
    // enrollment's putBundle landed): the guarded delete must lose.
    harness.failDeleteBundleWith = new ApiError(409, "conflict", "changed since read");

    await expect(removeLastPasskey(harness.io(), row)).rejects.toThrow("changed on another device");
    // The credential row survives: nothing was stranded.
    expect(harness.passkeyRows).toHaveLength(1);
    expect(harness.log.some((entry) => entry.startsWith("removePasskey"))).toBe(false);
  });

  test("a healthy readable bundle deletes at the revision it was read", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-a", 1);
    const row = harness.listCredential("cred-a");
    const outcome = await removeLastPasskey(harness.io(), row);
    expect(outcome.skippedRootReason).toBeNull();
    expect(harness.log).toContain("deleteBundle:1");
    expect(harness.bundle).toBeNull();
    expect(harness.passkeyRows).toHaveLength(0);
  });

  test("no bundle at all needs no acknowledgement — nothing to abandon", async () => {
    const harness = new Harness();
    const row = harness.listCredential("cred-a", secretFor(1));
    const outcome = await removeLastPasskey(harness.io(), row);
    expect(outcome.skippedRootReason).toBeNull();
    expect(harness.passkeyRows).toHaveLength(0);
    expect(harness.log.some((entry) => entry.startsWith("deleteBundle"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retired-roots cap: rotation at the cap must not break the unlock (fix 5)
// ---------------------------------------------------------------------------

describe("rotation at the retired-roots cap", () => {
  test("the 9th rotation still unlocks, paying the oldest retired seed", async () => {
    const harness = new Harness();
    harness.authenticator.set("cred-a", secretFor(1));
    const lineage = [];
    for (let i = 0; i < MAX_RETIRED_ROOTS + 1; i += 1) {
      lineage.push(await exportAccountRootMaterial(await generateAccountRoot()));
    }
    const live = lineage[lineage.length - 1];
    const retired = lineage.slice(0, MAX_RETIRED_ROOTS);
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [],
      [harness.wrapInput("cred-a")],
      1,
      live,
      retired,
    );
    harness.bundle = { sealed, revision: 1 };
    harness.listCredential("cred-a");
    // The sealed root's revocation is fully corroborated: roster row + the
    // permanent tombstone table both carry its key, and no live root remains.
    harness.roster = [
      { id: "old-root", public_key: live.publicKeyWire, revoked_at: "2026-08-01", is_root: true },
    ];
    harness.tombstonedKeys = [live.publicKeyWire];

    const outcome = await unlockPasskey(harness.io());
    expect(outcome.warning).toBeNull();
    // Rotation happened and healed off the successor.
    expect(harness.log.some((entry) => entry.startsWith("heal:bundle"))).toBe(true);
    const opened = await openTrustEnvelope(
      ACCOUNT,
      harness.bundle!.sealed,
      harness.wrapInput("cred-a"),
    );
    expect(opened.root!.publicKeyWire).not.toBe(live.publicKeyWire);
    expect(opened.retiredRoots).toHaveLength(MAX_RETIRED_ROOTS);
    // Oldest seed evicted, the outgoing live root retired at the end.
    expect(opened.retiredRoots.map((r) => r.publicKeyWire)).toEqual(
      [...retired.slice(1), live].map((r) => r.publicKeyWire),
    );
  });
});

// ---------------------------------------------------------------------------
// Forget/unlock honesty (P-C6, fix 3)
// ---------------------------------------------------------------------------

describe("forget-then-unlock honesty (P-C6)", () => {
  test("a forgotten host comes back at the next unlock, and the status says so", async () => {
    const harness = new Harness();
    await pinHost(harness, HOST_KEY);
    await storeBundle(harness, "cred-a", 1, true);
    harness.listCredential("cred-a");

    const { forgetTrustOnThisDevice } = await import("./trust-bootstrap");
    const forgotten = await forgetTrustOnThisDevice(harness.scope);
    expect(forgotten.forgotten).toBe(1);
    expect(
      await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, harness.pinStorage),
    ).toHaveLength(0);

    const outcome = await unlockPasskey(harness.io());
    expect(outcome.imported.added).toEqual([HOST_KEY]);
    expect(outcome.imported.skippedRevoked).toHaveLength(0);
    expect(describeUnlockImport(outcome.imported)).toBe("1 host now reachable from this device.");
    const pins = await listActiveBrowserHostPins(
      { accountId: ACCOUNT, origin: ORIGIN },
      harness.pinStorage,
    );
    expect(pins.map((p) => p.hostPublicKey)).toEqual([HOST_KEY]);
  });

  test("a TARGETED host removal stays removed, and the unlock says that too", async () => {
    const harness = new Harness();
    await pinHost(harness, HOST_KEY);
    await storeBundle(harness, "cred-a", 1, true);
    harness.listCredential("cred-a");
    // The operator's deliberate per-host withdrawal (not a device reset).
    await resolveActiveBrowserHostPin(
      { accountId: ACCOUNT, origin: ORIGIN, hostId: HOST_ID, claimedHostPublicKey: HOST_KEY },
      harness.pinStorage,
    );
    await revokeBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        targetHostId: HOST_ID,
        claimedHostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      harness.pinStorage,
    );

    const outcome = await unlockPasskey(harness.io());
    expect(outcome.imported.added).toHaveLength(0);
    expect(outcome.imported.skippedRevoked).toEqual([HOST_KEY]);
    // The old copy claimed "already knows your hosts" here, over zero pins.
    expect(describeUnlockImport(outcome.imported)).toBe(
      "No hosts came over to this device. 1 host stayed removed — you removed it on this device.",
    );
    expect(
      await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, harness.pinStorage),
    ).toHaveLength(0);
  });

  test("describeUnlockImport covers the empty and already-known buckets", () => {
    const base = { root: null, hosts: [], added: [], alreadyTrusted: [], skippedRevoked: [] };
    expect(describeUnlockImport(base)).toBe("Your passkey isn't protecting any hosts yet.");
    expect(
      describeUnlockImport({
        ...base,
        hosts: [{ hostPublicKey: HOST_KEY, hostFingerprint: "f", hostIds: [] }],
        alreadyTrusted: [HOST_KEY],
      }),
    ).toBe("This device already knows your hosts.");
  });
});

// ---------------------------------------------------------------------------
// addBackup: only wrap-holders may authorize
// ---------------------------------------------------------------------------

describe("addBackupPasskey", () => {
  test("directs to Use passkey when no listed credential holds a wrap", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-elsewhere", 7);
    harness.listCredential("cred-ghost", secretFor(9));
    await expect(addBackupPasskey(harness.io())).rejects.toThrow("Use passkey");
  });

  test("wraps first, enrolls after; both passkeys then open", async () => {
    const harness = new Harness();
    await storeBundle(harness, "cred-a", 1);
    harness.listCredential("cred-a");
    await addBackupPasskey(harness.io());
    const put = harness.log.lastIndexOf("putBundle:1");
    const add = harness.log.findIndex((entry) => entry === "addPasskey:cred-1");
    expect(put).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(put);
    for (const credentialId of ["cred-a", "cred-1"]) {
      await expect(
        openTrustEnvelope(ACCOUNT, harness.bundle!.sealed, harness.wrapInput(credentialId)),
      ).resolves.toBeDefined();
    }
  });
});
