import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import negativeKeysJson from "../../../proto/ed25519-public-key-negative-vectors.json";
import {
  approveBrowserHostPin,
  BROWSER_HOST_PIN_DATABASE_NAME,
  BROWSER_HOST_PIN_MAX_RECORDS,
  BROWSER_HOST_PIN_STORAGE_VERSION,
  BROWSER_HOST_PIN_STORE_NAME,
  BrowserHostPinError,
  forgetActiveBrowserHostPins,
  getBrowserHostPinRevision,
  loadBrowserHostPin,
  loadBrowserHostPinByHostId,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
  subscribeToBrowserHostPinChanges,
} from "./browser-host-pins";
import { ed25519PublicKeyFingerprint, encodeBase64Url } from "./signed-signal";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000002";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HOST_ID = "00000000-0000-4000-8000-000000000004";
const ORIGIN = "https://spawn.example";
const OTHER_ORIGIN = "https://other.spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_HOST_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

interface RawPin {
  accountId: string;
  approvedAtMs: number;
  createdAtMs: number;
  hostFingerprint: string;
  hostIds: string[];
  hostPublicKey: string;
  origin: string;
  recordId: string;
  revokedAtMs: number | null;
  state: "active" | "revoked";
  version: number;
  [key: string]: unknown;
}

interface NegativeKeyFile {
  weak_public_keys: Array<{ id: string; public_key_hex: string }>;
  noncanonical_public_key_hex: string[];
  invalid_encodings: Array<{ id: string; public_key_hex: string }>;
}

const negativeKeys = negativeKeysJson as NegativeKeyFile;

function options(factory: IDBFactory, now = 1_000) {
  return { indexedDBFactory: factory, now: () => now } as const;
}

function approvalInput(
  overrides: Partial<{
    accountId: string;
    origin: string;
    hostPublicKey: string;
    hostFingerprint: string;
  }> = {},
) {
  return {
    accountId: ACCOUNT,
    origin: ORIGIN,
    hostPublicKey: HOST_KEY,
    hostFingerprint: "SHA256:OfcT0KZEJT8EUpQh",
    ...overrides,
  };
}

function resolveInput(
  overrides: Partial<{
    accountId: string;
    origin: string;
    hostId: string;
    claimedHostPublicKey: string | null;
  }> = {},
) {
  return {
    accountId: ACCOUNT,
    origin: ORIGIN,
    hostId: HOST_ID,
    claimedHostPublicKey: HOST_KEY,
    ...overrides,
  };
}

function revokeInput(
  overrides: Partial<{
    accountId: string;
    origin: string;
    targetHostId: string;
    claimedHostId: string;
    claimedHostPublicKey: string | null;
  }> = {},
) {
  return {
    accountId: ACCOUNT,
    origin: ORIGIN,
    targetHostId: HOST_ID,
    claimedHostId: HOST_ID,
    claimedHostPublicKey: HOST_KEY,
    ...overrides,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => undefined;
  });
}

async function rawRecords(factory: IDBFactory): Promise<RawPin[]> {
  const database = await requestResult(factory.open(BROWSER_HOST_PIN_DATABASE_NAME));
  try {
    const transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readonly");
    const completion = transactionResult(transaction);
    const records = await requestResult(
      transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME).getAll(),
    );
    await completion;
    return records as RawPin[];
  } finally {
    database.close();
  }
}

async function putRaw(factory: IDBFactory, record: RawPin): Promise<void> {
  const database = await requestResult(factory.open(BROWSER_HOST_PIN_DATABASE_NAME));
  try {
    const transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readwrite");
    const completion = transactionResult(transaction);
    transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME).put(record);
    await completion;
  } finally {
    database.close();
  }
}

async function expectPinError(
  promise: Promise<unknown>,
  code: BrowserHostPinError["code"],
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrowserHostPinError);
  expect((caught as BrowserHostPinError).code).toBe(code);
}

async function expectRevokeBlockedWithoutDelete(
  factory: IDBFactory,
  input: Parameters<typeof revokeBrowserHostPin>[0],
  code: BrowserHostPinError["code"],
): Promise<void> {
  const before = JSON.stringify(await rawRecords(factory));
  let deleteCalls = 0;
  let caught: unknown;
  try {
    await revokeBrowserHostPin(input, options(factory, 2_000));
    deleteCalls += 1;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrowserHostPinError);
  expect((caught as BrowserHostPinError).code).toBe(code);
  expect(deleteCalls).toBe(0);
  expect(JSON.stringify(await rawRecords(factory))).toBe(before);
}

function wireFromHex(value: string): string {
  return encodeBase64Url(
    Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16)),
  );
}

describe("browser-local host pins", () => {
  test("first explicit approval persists one strict public-only active pin and reloads it", async () => {
    const factory = new IDBFactory();
    const pin = await approveBrowserHostPin(approvalInput(), options(factory));
    expect(pin).toEqual({
      accountId: ACCOUNT,
      approvedAtMs: 1_000,
      createdAtMs: 1_000,
      hostFingerprint: "SHA256:OfcT0KZEJT8EUpQh",
      hostIds: [],
      hostPublicKey: HOST_KEY,
      origin: ORIGIN,
      revokedAtMs: null,
      state: "active",
      version: BROWSER_HOST_PIN_STORAGE_VERSION,
    });
    expect(await loadBrowserHostPin(approvalInput(), options(factory))).toEqual(pin);

    const raw = await rawRecords(factory);
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0]).sort()).toEqual([
      "accountId",
      "approvedAtMs",
      "createdAtMs",
      "hostFingerprint",
      "hostIds",
      "hostPublicKey",
      "origin",
      "recordId",
      "revokedAtMs",
      "state",
      "version",
    ]);
    expect(JSON.stringify(raw)).not.toMatch(/private|secret|signature|nonce/iu);
  });

  test("concurrent tab-equivalent approval and resolver calls converge without replacement", async () => {
    const factory = new IDBFactory();
    const approved = await Promise.all(
      Array.from({ length: 12 }, () => approveBrowserHostPin(approvalInput(), options(factory))),
    );
    expect(new Set(approved.map((pin) => pin.hostPublicKey))).toEqual(new Set([HOST_KEY]));
    expect(await rawRecords(factory)).toHaveLength(1);

    const resolved = await Promise.all(
      Array.from({ length: 12 }, () =>
        resolveActiveBrowserHostPin(resolveInput(), options(factory)),
      ),
    );
    expect(new Set(resolved)).toEqual(new Set([HOST_KEY]));
    expect((await rawRecords(factory))[0].hostIds).toEqual([HOST_ID]);
  });

  test("isolates exact account and canonical origin scopes", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await approveBrowserHostPin(
      approvalInput({ accountId: OTHER_ACCOUNT, origin: OTHER_ORIGIN }),
      options(factory),
    );
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput({ accountId: OTHER_ACCOUNT }), options(factory)),
      "missing_pin",
    );
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput({ origin: OTHER_ORIGIN }), options(factory)),
      "missing_pin",
    );
    expect(
      await resolveActiveBrowserHostPin(
        resolveInput({ accountId: OTHER_ACCOUNT, origin: OTHER_ORIGIN }),
        options(factory),
      ),
    ).toBe(HOST_KEY);

    for (const origin of [
      "https://SPAWN.example",
      "https://spawn.example/",
      "https://spawn.example:443",
      "https://spawn.example/path",
      "https://spawn.example?query",
      "ftp://spawn.example",
      `https://${"a".repeat(513)}.example`,
    ]) {
      await expectPinError(
        approveBrowserHostPin(approvalInput({ origin }), options(factory)),
        "invalid_origin",
      );
    }
  });

  test("counts active records separately so 256 tombstones never starve live capacity", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    const template = (await rawRecords(factory))[0];
    const database = await requestResult(factory.open(BROWSER_HOST_PIN_DATABASE_NAME));
    const transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readwrite");
    const completion = transactionResult(transaction);
    const store = transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
    for (let index = 0; index < BROWSER_HOST_PIN_MAX_RECORDS; index += 1) {
      const accountId = `00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`;
      store.put({
        ...template,
        accountId,
        recordId: JSON.stringify([accountId, ORIGIN, HOST_KEY]),
        revokedAtMs: 2_000,
        state: "revoked",
      });
    }
    store.delete(template.recordId);
    await completion;
    database.close();

    // A full tombstone budget leaves the entire active budget available.
    const firstActiveAccount = "00000000-0000-4000-8002-000000000000";
    await expect(
      approveBrowserHostPin(approvalInput({ accountId: firstActiveAccount }), options(factory)),
    ).resolves.toMatchObject({ state: "active" });

    const activeTemplate = (await rawRecords(factory)).find(
      (record) => record.accountId === firstActiveAccount,
    )!;
    const activeDatabase = await requestResult(factory.open(BROWSER_HOST_PIN_DATABASE_NAME));
    const activeTransaction = activeDatabase.transaction(BROWSER_HOST_PIN_STORE_NAME, "readwrite");
    const activeCompletion = transactionResult(activeTransaction);
    const activeStore = activeTransaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
    for (let index = 1; index < BROWSER_HOST_PIN_MAX_RECORDS; index += 1) {
      const accountId = `00000000-0000-4000-8003-${index.toString().padStart(12, "0")}`;
      activeStore.put({
        ...activeTemplate,
        accountId,
        recordId: JSON.stringify([accountId, ORIGIN, HOST_KEY]),
      });
    }
    await activeCompletion;
    activeDatabase.close();

    await expectPinError(
      approveBrowserHostPin(
        approvalInput({ accountId: "00000000-0000-4000-8004-000000000000" }),
        options(factory),
      ),
      "capacity_exceeded",
    );
    expect(await rawRecords(factory)).toHaveLength(BROWSER_HOST_PIN_MAX_RECORDS * 2);
  });

  test("fails closed on unknown fields, record version, fingerprint corruption, and identity mismatch", async () => {
    for (const corrupt of [
      (record: RawPin) => {
        record.unknown = true;
      },
      (record: RawPin) => {
        record.version = 2;
      },
      (record: RawPin) => {
        record.hostFingerprint = "SHA256:AAAAAAAAAAAAAAAA";
      },
      (record: RawPin) => {
        record.accountId = OTHER_ACCOUNT;
      },
    ]) {
      const factory = new IDBFactory();
      await approveBrowserHostPin(approvalInput(), options(factory));
      const record = (await rawRecords(factory))[0];
      corrupt(record);
      await putRaw(factory, record);
      await expectPinError(loadBrowserHostPin(approvalInput(), options(factory)), "corrupt_record");
      expect(await rawRecords(factory)).toHaveLength(1);
    }
  });

  test("rejects unknown database versions and object-store schemas", async () => {
    const futureFactory = new IDBFactory();
    const futureOpen = futureFactory.open(
      BROWSER_HOST_PIN_DATABASE_NAME,
      BROWSER_HOST_PIN_STORAGE_VERSION + 1,
    );
    futureOpen.onupgradeneeded = () =>
      futureOpen.result.createObjectStore(BROWSER_HOST_PIN_STORE_NAME, { keyPath: "recordId" });
    (await requestResult(futureOpen)).close();
    await expectPinError(
      approveBrowserHostPin(approvalInput(), options(futureFactory)),
      "corrupt_record",
    );

    const schemaFactory = new IDBFactory();
    const schemaOpen = schemaFactory.open(
      BROWSER_HOST_PIN_DATABASE_NAME,
      BROWSER_HOST_PIN_STORAGE_VERSION,
    );
    schemaOpen.onupgradeneeded = () =>
      schemaOpen.result.createObjectStore(BROWSER_HOST_PIN_STORE_NAME, { keyPath: "wrong" });
    (await requestResult(schemaOpen)).close();
    await expectPinError(
      approveBrowserHostPin(approvalInput(), options(schemaFactory)),
      "corrupt_record",
    );
  });

  test("rejects the complete weak, noncanonical, and off-curve key corpus before persistence", async () => {
    const rejected = [
      ...negativeKeys.weak_public_keys,
      ...negativeKeys.noncanonical_public_key_hex.map((public_key_hex, index) => ({
        id: `noncanonical-${index}`,
        public_key_hex,
      })),
      ...negativeKeys.invalid_encodings,
    ];
    expect(rejected).toHaveLength(49);
    const factory = new IDBFactory();
    for (const vector of rejected) {
      await expectPinError(
        approveBrowserHostPin(
          approvalInput({
            hostPublicKey: wireFromHex(vector.public_key_hex),
            hostFingerprint: "SHA256:AAAAAAAAAAAAAAAA",
          }),
          options(factory),
        ),
        "invalid_key",
      );
    }
    expect(await factory.databases()).toEqual([]);
  });

  test("rejects fingerprint substitution at approval; the resolver takes no fingerprint at all", async () => {
    const factory = new IDBFactory();
    // Approval still takes the ceremony-derived fingerprint and cross-checks
    // it against the key: a mismatched pair is refused before persistence.
    await expectPinError(
      approveBrowserHostPin(
        approvalInput({ hostFingerprint: "SHA256:AAAAAAAAAAAAAAAA" }),
        options(factory),
      ),
      "fingerprint_mismatch",
    );
    expect(await factory.databases()).toEqual([]);

    // The resolver's identity input is the claimed KEY alone (mesh B5): its
    // fingerprint is derived locally, so a foreign key simply fails to match
    // any pin — there is no served fingerprint left to substitute.
    await approveBrowserHostPin(approvalInput(), options(factory));
    await expectPinError(
      resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory),
      ),
      "missing_pin",
    );
  });

  test("resolver fails loudly on missing, null, mismatch, and revoked", async () => {
    const factory = new IDBFactory();
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput(), options(factory)),
      "missing_pin",
    );
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput({ claimedHostPublicKey: null }), options(factory)),
      "null_key",
    );
    await approveBrowserHostPin(approvalInput(), options(factory));
    expect(await resolveActiveBrowserHostPin(resolveInput(), options(factory))).toBe(HOST_KEY);
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput(), options(factory)),
      "revoked_pin",
    );
  });

  test("an ACTIVE binding under a different served key is the substitution signal — hard conflict", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory),
    );
    // Both keys actively pinned, the Host ID bound to the first: a server now
    // serving the second key for that ID must never quietly re-bind it.
    await expectPinError(
      resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory),
      ),
      "host_id_key_conflict",
    );
    const records = await rawRecords(factory);
    expect(records.find((r) => r.hostPublicKey === HOST_KEY)?.hostIds).toEqual([HOST_ID]);
    expect(records.find((r) => r.hostPublicKey === OTHER_HOST_KEY)?.hostIds).toEqual([]);
  });

  test("a REVOKED binding plus a freshly approved key migrates: re-possess clears the conflict (R-b)", async () => {
    // The owner's re-key cycle: possess (old key) → remove the host here →
    // possess again (new key, same Host ID). Before the migration rule this
    // wedged on host_id_key_conflict forever — the tombstone kept the binding
    // and the fresh explicit approval could never claim it.
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));

    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory, 3_000),
    );
    expect(
      await resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory, 3_000),
      ),
    ).toBe(OTHER_HOST_KEY);
    // The binding moved atomically; the tombstone survives (R10) without it.
    const records = await rawRecords(factory);
    const old = records.find((r) => r.hostPublicKey === HOST_KEY);
    const fresh = records.find((r) => r.hostPublicKey === OTHER_HOST_KEY);
    expect(old?.state).toBe("revoked");
    expect(old?.hostIds).toEqual([]);
    expect(fresh?.state).toBe("active");
    expect(fresh?.hostIds).toEqual([HOST_ID]);
    // And it stays resolvable (the gossip consumer's later rows no longer
    // conflict-warn every session).
    expect(
      await resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory, 4_000),
      ),
    ).toBe(OTHER_HOST_KEY);
  });

  test("a REVOKED binding with no active pin for the served key still conflicts", async () => {
    // Tombstoned Host IDs never re-bind on the server's say-so alone: only an
    // explicit fresh approval of the served key earns the migration.
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));
    await expectPinError(
      resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory),
      ),
      "host_id_key_conflict",
    );
  });

  test("device-local forget composes with the re-key exit: the retained tombstone still migrates (R-b × P-C6)", async () => {
    // Forget (P-C6) DELETES active pins but retains targeted-revocation
    // tombstones — including their Host-ID bindings. That retained binding is
    // exactly the state the re-possess migration must clear, so the two
    // semantics are proven together: revoke a re-keyed host, forget the
    // device's other pins, then possess the host again with its new key.
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000)); // targeted removal
    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory, 3_000),
    );

    const { forgotten } = await forgetActiveBrowserHostPins(
      { accountId: ACCOUNT, origin: ORIGIN },
      options(factory, 4_000),
    );
    expect(forgotten).toBe(1); // the active pin died; the tombstone did not
    const afterForget = await rawRecords(factory);
    expect(afterForget).toHaveLength(1);
    expect(afterForget[0]).toMatchObject({
      hostPublicKey: HOST_KEY,
      state: "revoked",
      hostIds: [HOST_ID], // the binding rides the retained tombstone
    });

    // Re-possess with the host's new key: the fresh explicit approval plus
    // the migration clear the conflict — a forget in between changes nothing.
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory, 5_000),
    );
    expect(
      await resolveActiveBrowserHostPin(
        resolveInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
        options(factory, 5_000),
      ),
    ).toBe(OTHER_HOST_KEY);
    const records = await rawRecords(factory);
    expect(records.find((r) => r.hostPublicKey === HOST_KEY)).toMatchObject({
      state: "revoked",
      hostIds: [], // R10: the tombstone survives, just without the binding
    });
    expect(records.find((r) => r.hostPublicKey === OTHER_HOST_KEY)).toMatchObject({
      state: "active",
      hostIds: [HOST_ID],
    });
  });

  test("bounds observed routing Host IDs by evicting, never refusing or replacing the key", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    for (let index = 0; index < 8; index += 1) {
      const hostId = `00000000-0000-4000-9000-${index.toString().padStart(12, "0")}`;
      expect(await resolveActiveBrowserHostPin(resolveInput({ hostId }), options(factory))).toBe(
        HOST_KEY,
      );
    }
    // The 9th binding evicts one existing ID instead of refusing: a refusal
    // surfaces as pin_storage_error, which under signed-RTC enforcement is a
    // hard lockout, while a dropped binding re-binds on its next resolve.
    const ninth = "00000000-0000-4000-9000-000000000008";
    expect(
      await resolveActiveBrowserHostPin(resolveInput({ hostId: ninth }), options(factory)),
    ).toBe(HOST_KEY);
    const record = (await rawRecords(factory))[0];
    expect(record.hostIds).toHaveLength(8);
    expect(record.hostIds).toContain(ninth);
    expect(record.hostPublicKey).toBe(HOST_KEY);
  });

  test("deletion refuses split and unbound identities without mutation or DELETE", async () => {
    const unboundFactory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(unboundFactory));
    await expectRevokeBlockedWithoutDelete(unboundFactory, revokeInput(), "missing_pin");

    const multipleUnboundFactory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(multipleUnboundFactory));
    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(multipleUnboundFactory),
    );
    await expectRevokeBlockedWithoutDelete(
      multipleUnboundFactory,
      revokeInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
      "missing_pin",
    );

    const boundFactory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(boundFactory));
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(boundFactory),
    );
    await resolveActiveBrowserHostPin(resolveInput(), options(boundFactory));
    await expectRevokeBlockedWithoutDelete(
      boundFactory,
      revokeInput({ claimedHostId: OTHER_HOST_ID }),
      "host_id_response_mismatch",
    );
  });

  test("removal tombstones the BOUND record even when the server claims a different key (R-b)", async () => {
    // A re-keyed host serves its new key while the local binding still names
    // the old one. The server cannot veto a local trust withdrawal — blocking
    // here wedged the only safe exit (remove, then possess again). The record
    // that dies is the bound one: the key this device actually approved.
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    const revoked = await revokeBrowserHostPin(
      revokeInput({ claimedHostPublicKey: OTHER_HOST_KEY }),
      options(factory, 2_000),
    );
    expect(revoked.state).toBe("revoked");
    expect(revoked.hostPublicKey).toBe(HOST_KEY);
    expect(revoked.hostIds).toEqual([HOST_ID]);
    // The claimed key is still strictly validated — garbage never drives a
    // deletion flow.
    await expectPinError(
      revokeBrowserHostPin(
        revokeInput({ claimedHostPublicKey: "not-a-key" }),
        options(factory, 3_000),
      ),
      "invalid_key",
    );
  });

  test("deletion tombstone is idempotent, survives disappearance, and blocks reappearance", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    const first = await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));
    const retry = await revokeBrowserHostPin(revokeInput(), options(factory, 3_000));
    expect(first.state).toBe("revoked");
    expect(retry).toEqual(first);
    expect(retry.hostIds).toEqual([HOST_ID]);

    // No local operation represents server disappearance. Reappearance with
    // the same exact row remains revoked and cannot self-reactivate.
    expect((await loadBrowserHostPin(approvalInput(), options(factory)))?.state).toBe("revoked");
    await expectPinError(
      resolveActiveBrowserHostPin(resolveInput(), options(factory)),
      "revoked_pin",
    );
  });

  test("only a fresh exact explicit approval reactivates; active reapproval is idempotent", async () => {
    const factory = new IDBFactory();
    const first = await approveBrowserHostPin(approvalInput(), options(factory, 1_000));
    const idempotent = await approveBrowserHostPin(approvalInput(), options(factory, 9_000));
    expect(idempotent).toEqual(first);

    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));
    const reactivated = await approveBrowserHostPin(approvalInput(), options(factory, 3_000));
    expect(reactivated.state).toBe("active");
    expect(reactivated.createdAtMs).toBe(1_000);
    expect(reactivated.approvedAtMs).toBe(3_000);
    expect(reactivated.revokedAtMs).toBeNull();
    expect(reactivated.hostIds).toEqual([HOST_ID]);
    expect(await resolveActiveBrowserHostPin(resolveInput(), options(factory))).toBe(HOST_KEY);
  });

  test("introduction-driven approvals never resurrect a tombstone (reactivateRevoked: false)", async () => {
    // A peer's standing broadcast row for a key the operator removed HERE
    // must not quietly undo the removal — and, in the re-key cycle, must not
    // re-activate the stale old-key record and re-wedge the binding the
    // re-possess just migrated. Only the explicit ceremony (default) may.
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await resolveActiveBrowserHostPin(resolveInput(), options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory, 2_000));
    await expectPinError(
      approveBrowserHostPin(
        { ...approvalInput(), reactivateRevoked: false },
        options(factory, 3_000),
      ),
      "revoked_pin",
    );
    expect((await rawRecords(factory))[0].state).toBe("revoked");
    // A never-revoked key is unaffected: creation and idempotent re-approval
    // work identically with the flag.
    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    const created = await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory, 4_000),
    );
    expect(created.state).toBe("active");
    const again = await approveBrowserHostPin(
      {
        ...approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
        reactivateRevoked: false,
      },
      options(factory, 5_000),
    );
    expect(again.state).toBe("active");
  });

  test("fails closed when IndexedDB is unavailable", async () => {
    await expectPinError(
      approveBrowserHostPin(approvalInput(), { indexedDBFactory: null }),
      "storage_unavailable",
    );
  });

  test("rejects conflicting duplicate Host-ID bindings as corruption", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    const otherFingerprint = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
    await approveBrowserHostPin(
      approvalInput({ hostPublicKey: OTHER_HOST_KEY, hostFingerprint: otherFingerprint }),
      options(factory),
    );
    const [first, second] = await rawRecords(factory);
    first.hostIds = [OTHER_HOST_ID];
    second.hostIds = [OTHER_HOST_ID];
    await putRaw(factory, first);
    await putRaw(factory, second);
    await expectPinError(
      loadBrowserHostPin(approvalInput(), options(factory)),
      "duplicate_conflict",
    );
  });
});

describe("approveBrowserHostPin Host ID seeding", () => {
  test("seeds Host IDs so the pin is recognised by hostId without a resolve", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin({ ...approvalInput(), hostIds: [HOST_ID] }, options(factory));
    const bound = await loadBrowserHostPinByHostId(
      { accountId: ACCOUNT, origin: ORIGIN, hostId: HOST_ID },
      options(factory),
    );
    expect(bound?.hostPublicKey).toBe(HOST_KEY);
    expect(bound?.hostIds).toEqual([HOST_ID]);
  });

  test("announces a revision when trust changes, so a refused pane can retry", async () => {
    const factory = new IDBFactory();
    const seen: number[] = [];
    const unsubscribe = subscribeToBrowserHostPinChanges((changed) => {
      if (changed) seen.push(getBrowserHostPinRevision());
    });
    try {
      const before = getBrowserHostPinRevision();
      await approveBrowserHostPin({ ...approvalInput(), hostIds: [HOST_ID] }, options(factory));
      expect(seen.length).toBe(1);
      expect(getBrowserHostPinRevision()).toBeGreaterThan(before);

      await revokeBrowserHostPin(revokeInput(), options(factory));
      expect(seen.length).toBe(2);

      // Forgetting nothing changed nothing, so it says nothing.
      await forgetActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, options(factory));
      expect(seen.length).toBe(2);
    } finally {
      unsubscribe();
    }

    // And a listener that has unsubscribed stops hearing.
    const quiet = seen.length;
    await approveBrowserHostPin({ ...approvalInput(), hostIds: [HOST_ID] }, options(factory));
    expect(seen.length).toBe(quiet);
  });

  test("re-approving unions new Host IDs without dropping existing ones", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin({ ...approvalInput(), hostIds: [HOST_ID] }, options(factory));
    await approveBrowserHostPin({ ...approvalInput(), hostIds: [OTHER_HOST_ID] }, options(factory));
    const bound = await loadBrowserHostPinByHostId(
      { accountId: ACCOUNT, origin: ORIGIN, hostId: OTHER_HOST_ID },
      options(factory),
    );
    expect(bound?.hostIds).toEqual([HOST_ID, OTHER_HOST_ID]);
  });

  test("replayed gossip reconfirms trust without changing its revision or age", async () => {
    const factory = new IDBFactory();
    const seen: number[] = [];
    const reconfirmed: number[] = [];
    const unsubscribe = subscribeToBrowserHostPinChanges((changed) => {
      (changed ? seen : reconfirmed).push(getBrowserHostPinRevision());
    });
    try {
      const first = await approveBrowserHostPin(
        { ...approvalInput(), hostIds: [HOST_ID] },
        options(factory),
      );
      // Each workspace remount consumes the same signed introduction again.
      for (let index = 0; index < 3; index++) {
        expect(
          await approveBrowserHostPin(
            { ...approvalInput(), reactivateRevoked: false },
            options(factory, 9_000),
          ),
        ).toEqual(first);
      }
      expect(seen).toHaveLength(1);
      expect(reconfirmed).toEqual([seen[0], seen[0], seen[0]]);
      await approveBrowserHostPin(
        { ...approvalInput(), hostIds: [OTHER_HOST_ID] },
        options(factory),
      );
      expect(seen).toHaveLength(2);
      await revokeBrowserHostPin(revokeInput(), options(factory));
      expect(seen).toHaveLength(3);
      await expect(
        approveBrowserHostPin({ ...approvalInput(), reactivateRevoked: false }, options(factory)),
      ).rejects.toMatchObject({ code: "revoked_pin" });
      expect(seen).toHaveLength(3);
      await approveBrowserHostPin(approvalInput(), options(factory));
      expect(seen).toHaveLength(4);
    } finally {
      unsubscribe();
    }
  });

  test("a new alias at capacity is a real change even though the count stays the same", async () => {
    const factory = new IDBFactory();
    const hostIds = Array.from(
      { length: 8 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    );
    await approveBrowserHostPin({ ...approvalInput(), hostIds }, options(factory));
    const before = getBrowserHostPinRevision();
    const updated = await approveBrowserHostPin(
      { ...approvalInput(), hostIds: [OTHER_HOST_ID] },
      options(factory),
    );
    expect(updated.hostIds).toHaveLength(8);
    expect(updated.hostIds).toContain(OTHER_HOST_ID);
    expect(getBrowserHostPinRevision()).toBe(before + 1);
  });

  test("skips a malformed Host ID rather than failing the whole approval", async () => {
    const factory = new IDBFactory();
    const approved = await approveBrowserHostPin(
      { ...approvalInput(), hostIds: ["not-a-uuid", HOST_ID] },
      options(factory),
    );
    expect(approved.hostIds).toEqual([HOST_ID]);
  });
});

// ---------------------------------------------------------------------------
// Device-local forget: deletion, not tombstoning (review P-C6)
// ---------------------------------------------------------------------------

describe("forgetActiveBrowserHostPins", () => {
  test("deletes every active pin in scope so the host reads as never seen", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await approveBrowserHostPin(
      approvalInput({
        hostPublicKey: OTHER_HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(OTHER_HOST_KEY),
      }),
      options(factory),
    );

    const { forgotten } = await forgetActiveBrowserHostPins(
      { accountId: ACCOUNT, origin: ORIGIN },
      options(factory),
    );
    expect(forgotten).toBe(2);
    // No record at all — not a revoked tombstone. The signed-RTC gate and a
    // later bundle import both see a host this device never met.
    expect(await loadBrowserHostPin(approvalInput(), options(factory))).toBeNull();
    // Re-approval (e.g. a passkey import) recreates trust from scratch.
    const again = await approveBrowserHostPin(approvalInput(), options(factory));
    expect(again.state).toBe("active");
  });

  test("retains an operator's targeted-revocation tombstone untouched", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin({ ...approvalInput(), hostIds: [HOST_ID] }, options(factory));
    await revokeBrowserHostPin(revokeInput(), options(factory));
    await approveBrowserHostPin(
      approvalInput({
        hostPublicKey: OTHER_HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(OTHER_HOST_KEY),
      }),
      options(factory),
    );

    const { forgotten } = await forgetActiveBrowserHostPins(
      { accountId: ACCOUNT, origin: ORIGIN },
      options(factory),
    );
    expect(forgotten).toBe(1);
    // The targeted removal is a statement about the HOST, not this device's
    // memory — a forget must not turn it into an amnesty.
    const tombstone = await loadBrowserHostPin(approvalInput(), options(factory));
    expect(tombstone?.state).toBe("revoked");
  });

  test("is scoped: other accounts and origins keep their pins", async () => {
    const factory = new IDBFactory();
    await approveBrowserHostPin(approvalInput(), options(factory));
    await approveBrowserHostPin(approvalInput({ accountId: OTHER_ACCOUNT }), options(factory));
    const { forgotten } = await forgetActiveBrowserHostPins(
      { accountId: ACCOUNT, origin: ORIGIN },
      options(factory),
    );
    expect(forgotten).toBe(1);
    expect(
      await loadBrowserHostPin(approvalInput({ accountId: OTHER_ACCOUNT }), options(factory)),
    ).not.toBeNull();
  });
});
