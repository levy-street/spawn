import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  adoptBrowserDeviceIdentity,
  BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
  BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS,
  BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
  BROWSER_DEVICE_IDENTITY_STORE_NAME,
  BROWSER_DEVICE_IDENTITY_TOUCH_INTERVAL_MS,
  BrowserDeviceIdentityError,
  createBrowserDeviceRegistrationProof,
  deleteBrowserDeviceIdentity,
  loadBrowserDeviceIdentity,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import { verifyBrowserDeviceRegistrationProof } from "./browser-device-registration-transcript";
import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
  encodeBase64Url,
  type SignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";

interface RawStoredIdentity {
  accountId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyWire: string;
  version: number;
  [key: string]: unknown;
}

const accountUuid = (suffix: number): string =>
  `00000000-0000-0000-0000-${suffix.toString().padStart(12, "0")}`;

function options(factory: IDBFactory) {
  return { indexedDBFactory: factory } as const;
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

async function openExisting(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return requestResult(factory.open(databaseName));
}

async function rawRecord(
  factory: IDBFactory,
  databaseName: string,
  accountId: string,
): Promise<RawStoredIdentity | undefined> {
  const database = await openExisting(factory, databaseName);
  try {
    const transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
    const completion = transactionResult(transaction);
    const value = await requestResult(
      transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME).get(accountId),
    );
    await completion;
    return value as RawStoredIdentity | undefined;
  } finally {
    database.close();
  }
}

async function putRawRecord(
  factory: IDBFactory,
  databaseName: string,
  value: Record<string, unknown>,
): Promise<void> {
  const database = await openExisting(factory, databaseName);
  try {
    const transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readwrite");
    const completion = transactionResult(transaction);
    await requestResult(transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME).put(value));
    await completion;
  } finally {
    database.close();
  }
}

async function precreateDatabaseWithSchema(
  factory: IDBFactory,
  schema: {
    autoIncrement: boolean;
    keyPath: string | readonly string[] | null;
    seedKey?: IDBValidKey;
    seedRecord: Record<string, unknown>;
  },
): Promise<void> {
  const request = factory.open(
    BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
    BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
  );
  request.onupgradeneeded = () => {
    const keyPath: string | string[] | null =
      typeof schema.keyPath === "string" || schema.keyPath === null
        ? schema.keyPath
        : Array.from(schema.keyPath);
    const store = request.result.createObjectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME, {
      autoIncrement: schema.autoIncrement,
      keyPath,
    });
    if (schema.seedKey === undefined) {
      store.add(schema.seedRecord);
    } else {
      store.add(schema.seedRecord, schema.seedKey);
    }
  };
  const database = await requestResult(request);
  database.close();
}

async function rawRecords(factory: IDBFactory): Promise<unknown[]> {
  const database = await openExisting(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
    const completion = transactionResult(transaction);
    const records = await requestResult(
      transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME).getAll(),
    );
    await completion;
    return records;
  } finally {
    database.close();
  }
}

function transcript(publicKeyWire: string): SignedSignalTranscript {
  return {
    signalKind: "offer",
    protocolVersion: 1,
    sessionId: "00000000-0000-4000-8000-000000000003",
    scopeType: "host",
    scopeId: "00000000-0000-4000-8000-000000000004",
    senderRole: "browser",
    intendedPeerPublicKey: decodeBase64Url(publicKeyWire, ED25519_PUBLIC_KEY_BYTES),
    sdp: "v=0\r\ns=browser-identity-unit-test\r\n",
  };
}

async function expectIdentityError(
  promise: Promise<unknown>,
  code: BrowserDeviceIdentityError["code"],
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrowserDeviceIdentityError);
  expect((caught as BrowserDeviceIdentityError).code).toBe(code);
}

describe("browser device identity", () => {
  test("creates only the account-bound registration proof for its opaque private key", async () => {
    const factory = new IDBFactory();
    const accountId = "00000000-0000-4000-8000-000000000001";
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, options(factory));
    const signature = await createBrowserDeviceRegistrationProof(identity, accountId);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        accountId,
        identity.publicKeyWire,
        signature,
        false,
      ),
    ).toBe(true);
    await expect(
      createBrowserDeviceRegistrationProof(identity, "00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow("does not belong");
  });

  test("persists one non-extractable account key and reloads only its public handle", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = accountUuid(10);

    const first = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const reloaded = await loadOrCreateBrowserDeviceIdentity(accountId, storage);

    expect(reloaded.publicKeyWire).toBe(first.publicKeyWire);
    expect(Object.keys(first).sort()).toEqual(["publicKey", "publicKeyWire", "sign"]);
    const value = transcript(first.publicKeyWire);
    const signature = await reloaded.sign(value);
    expect(await verifySignedSignalTranscript(first.publicKey, value, signature)).toBe(true);

    const stored = await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId);
    expect(stored?.version).toBe(BROWSER_DEVICE_IDENTITY_STORAGE_VERSION);
    expect(stored?.privateKey.extractable).toBe(false);
    expect(stored?.privateKey.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("pkcs8", stored!.privateKey)).rejects.toThrow();
  });

  test("serializes concurrent first creation so every tab-equivalent caller sees one winner", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const identities = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateBrowserDeviceIdentity(accountUuid(11), storage)),
    );

    expect(new Set(identities.map((identity) => identity.publicKeyWire)).size).toBe(1);
    expect(
      (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountUuid(11)))
        ?.publicKeyWire,
    ).toBe(identities[0].publicKeyWire);
  });

  test("keeps accounts separate in the same bounded database", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const alpha = await loadOrCreateBrowserDeviceIdentity(accountUuid(12), storage);
    const beta = await loadOrCreateBrowserDeviceIdentity(accountUuid(13), storage);

    expect(alpha.publicKeyWire).not.toBe(beta.publicKeyWire);
    expect((await loadOrCreateBrowserDeviceIdentity(accountUuid(12), storage)).publicKeyWire).toBe(
      alpha.publicKeyWire,
    );
  });

  test("fails closed on corrupt shape and does not replace the record", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = accountUuid(14);
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const stored = (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId))!;
    stored.unexpected = true;
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, stored);

    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity(accountId, storage),
      "corrupt_record",
    );
    expect(
      (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId))?.publicKeyWire,
    ).toBe(identity.publicKeyWire);
  });

  test("rejects a valid public key paired with a different private key", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    await loadOrCreateBrowserDeviceIdentity(accountUuid(15), storage);
    await loadOrCreateBrowserDeviceIdentity(accountUuid(16), storage);
    const first = (await rawRecord(
      factory,
      BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
      accountUuid(15),
    ))!;
    const second = (await rawRecord(
      factory,
      BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
      accountUuid(16),
    ))!;
    first.privateKey = second.privateKey;
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, first);

    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity(accountUuid(15), storage),
      "corrupt_record",
    );
  });

  test("rejects stored keys with altered algorithm or usages", async () => {
    const usageFactory = new IDBFactory();
    const usageStorage = options(usageFactory);
    const usageAccount = accountUuid(17);
    await loadOrCreateBrowserDeviceIdentity(usageAccount, usageStorage);
    const usageRecord = (await rawRecord(
      usageFactory,
      BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
      usageAccount,
    ))!;
    const publicBytes = await crypto.subtle.exportKey("raw", usageRecord.publicKey);
    usageRecord.publicKey = await crypto.subtle.importKey(
      "raw",
      publicBytes,
      { name: "Ed25519" },
      true,
      [],
    );
    await putRawRecord(usageFactory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, usageRecord);
    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity(usageAccount, usageStorage),
      "corrupt_record",
    );

    const algorithmFactory = new IDBFactory();
    const algorithmStorage = options(algorithmFactory);
    const algorithmAccount = accountUuid(18);
    await loadOrCreateBrowserDeviceIdentity(algorithmAccount, algorithmStorage);
    const algorithmRecord = (await rawRecord(
      algorithmFactory,
      BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
      algorithmAccount,
    ))!;
    const replacement = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    algorithmRecord.privateKey = replacement.privateKey;
    await putRawRecord(algorithmFactory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, algorithmRecord);
    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity(algorithmAccount, algorithmStorage),
      "corrupt_record",
    );
  });

  test("fails closed when IndexedDB is unavailable", async () => {
    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity(accountUuid(19), {
        indexedDBFactory: null,
      }),
      "storage_unavailable",
    );
  });

  test("rejects every mismatched version-1 object-store schema without creating a key", async () => {
    const schemas = [
      {
        autoIncrement: false,
        keyPath: "wrongAccountId",
        seedRecord: { marker: "wrong-key-path", wrongAccountId: "seed" },
      },
      {
        autoIncrement: false,
        keyPath: ["tenant", "account"],
        seedRecord: {
          account: "seed",
          marker: "compound-key-path",
          tenant: "test",
        },
      },
      {
        autoIncrement: false,
        keyPath: null,
        seedKey: "seed",
        seedRecord: { marker: "out-of-line-key" },
      },
      {
        autoIncrement: true,
        keyPath: "accountId",
        seedRecord: { accountId: "seed", marker: "auto-increment" },
      },
    ] as const;

    for (const schema of schemas) {
      const factory = new IDBFactory();
      const storage = options(factory);
      await precreateDatabaseWithSchema(factory, schema);
      const before = await rawRecords(factory);

      await expectIdentityError(
        loadOrCreateBrowserDeviceIdentity(accountUuid(20), storage),
        "corrupt_record",
      );
      await expectIdentityError(
        loadOrCreateBrowserDeviceIdentity(accountUuid(20), storage),
        "corrupt_record",
      );

      expect(await rawRecords(factory)).toEqual(before);
    }
  });

  test("deletes only when the expected public key matches", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = accountUuid(21);
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const other = await loadOrCreateBrowserDeviceIdentity(accountUuid(22), storage);

    await expectIdentityError(
      deleteBrowserDeviceIdentity(accountId, other.publicKeyWire, storage),
      "key_mismatch",
    );
    expect((await loadOrCreateBrowserDeviceIdentity(accountId, storage)).publicKeyWire).toBe(
      identity.publicKeyWire,
    );

    expect(await deleteBrowserDeviceIdentity(accountId, identity.publicKeyWire, storage)).toBe(
      true,
    );
    expect(await deleteBrowserDeviceIdentity(accountId, identity.publicKeyWire, storage)).toBe(
      false,
    );
  });

  test("requires canonical account UUIDs and keeps stored account records bounded", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    for (const invalid of [
      "account-arbitrary",
      "00000000000000000000000000000000",
      "{00000000-0000-0000-0000-000000000001}",
      "00000000-0000-0000-0000-000000000001 ",
      "00000000-0000-0000-0000-00000000000A",
    ]) {
      await expectIdentityError(
        loadOrCreateBrowserDeviceIdentity(invalid, storage),
        "invalid_account",
      );
    }

    const inUse = accountUuid(100);
    const inUseIdentity = await loadOrCreateBrowserDeviceIdentity(inUse, storage);
    await fillStoreToCap(factory, 101);
    expect(await storedAccountCount(factory)).toBe(BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS);

    // A full store is not the end of this browser: the account arriving now
    // gets an identity, the cap still holds, and what went was a record with
    // no stamp at all rather than the one this browser is signing with.
    const arrived = await loadOrCreateBrowserDeviceIdentity(accountUuid(200), storage);
    expect(arrived.publicKeyWire).toHaveLength(43);
    expect(await storedAccountCount(factory)).toBe(BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS);
    expect(
      await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountUuid(101)),
    ).toBeUndefined();
    const survivor = await loadBrowserDeviceIdentity(inUse, storage);
    expect(survivor?.publicKeyWire).toBe(inUseIdentity.publicKeyWire);
  });

  test("eviction takes the identity used longest ago", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    await loadOrCreateBrowserDeviceIdentity(accountUuid(400), storage);
    // Stamped fillers, oldest first: 401 was used longest ago, 431 most
    // recently, and all of them before the identity minted a moment ago.
    const base = Date.now() - 10 * 60_000;
    for (let index = 1; index < BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS; index += 1) {
      await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, {
        accountId: accountUuid(400 + index),
        lastUsedAt: base + index,
      });
    }

    await loadOrCreateBrowserDeviceIdentity(accountUuid(500), storage);
    expect(
      await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountUuid(401)),
    ).toBeUndefined();
    for (const kept of [accountUuid(400), accountUuid(402), accountUuid(500)]) {
      expect(await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, kept)).toBeDefined();
    }
  });

  test("a load refreshes a stale eviction stamp and leaves a fresh one alone", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = accountUuid(600);
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const minted = await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId);
    expect(typeof minted?.lastUsedAt).toBe("number");

    // A second load inside the interval is not worth a write.
    await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    expect(
      (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId))?.lastUsedAt,
    ).toBe(minted?.lastUsedAt);

    const stale = Date.now() - 2 * BROWSER_DEVICE_IDENTITY_TOUCH_INTERVAL_MS;
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, {
      ...(minted as Record<string, unknown>),
      lastUsedAt: stale,
    });
    const reloaded = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    expect(reloaded.publicKeyWire).toBe(identity.publicKeyWire);
    const refreshed = await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId);
    expect(refreshed?.lastUsedAt as number).toBeGreaterThan(stale);
    expect(refreshed?.publicKeyWire).toBe(identity.publicKeyWire);
  });

  test("a record written before stamps existed still loads, and sorts oldest", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const legacyAccount = accountUuid(700);
    const identity = await loadOrCreateBrowserDeviceIdentity(legacyAccount, storage);
    const record = await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, legacyAccount);
    const { lastUsedAt: _dropped, ...legacy } = record as Record<string, unknown>;
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, legacy);

    const loaded = await loadBrowserDeviceIdentity(legacyAccount, storage);
    expect(loaded?.publicKeyWire).toBe(identity.publicKeyWire);
  });
});

/** Fill the store to its cap with records nothing in this browser has used. */
async function fillStoreToCap(factory: IDBFactory, firstSuffix: number): Promise<void> {
  const filled = await storedAccountCount(factory);
  for (let index = 0; index < BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS - filled; index += 1) {
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, {
      accountId: accountUuid(firstSuffix + index),
    });
  }
}

async function storedAccountCount(factory: IDBFactory): Promise<number> {
  const database = await openExisting(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
    const completion = transactionResult(transaction);
    const count = await requestResult(
      transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME).count(),
    );
    await completion;
    return count;
  } finally {
    database.close();
  }
}

/** A seed and its public key, the way the desktop app holds them. */
async function carriedIdentity(): Promise<{ seed: Uint8Array; publicKeyWire: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { seed: pkcs8.slice(pkcs8.byteLength - 32), publicKeyWire: encodeBase64Url(raw) };
}

describe("adopting the desktop app's identity", () => {
  test("adopts a carried identity into an empty store, non-extractable, and zeroes the seed", async () => {
    const factory = new IDBFactory();
    const accountId = accountUuid(41);
    const carried = await carriedIdentity();
    const expectedKey = carried.publicKeyWire;
    const adopted = await adoptBrowserDeviceIdentity(accountId, carried, options(factory));
    expect(adopted.replacedPublicKeyWire).toBeNull();
    expect(adopted.identity.publicKeyWire).toBe(expectedKey);
    expect(carried.seed.every((byte) => byte === 0)).toBe(true);

    const stored = await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, accountId);
    expect(stored?.privateKey.extractable).toBe(false);
    expect(stored?.privateKey.usages).toEqual(["sign"]);
    expect(stored?.publicKeyWire).toBe(expectedKey);

    // It signs as that device from now on, and reloads as it.
    const signature = await adopted.identity.sign(transcript(expectedKey));
    expect(
      await verifySignedSignalTranscript(
        adopted.identity.publicKey,
        transcript(expectedKey),
        signature,
      ),
    ).toBe(true);
    const reloaded = await loadBrowserDeviceIdentity(accountId, options(factory));
    expect(reloaded?.publicKeyWire).toBe(expectedKey);
  });

  test("replaces the identity this page minted for itself and names the key that died", async () => {
    const factory = new IDBFactory();
    const accountId = accountUuid(42);
    const minted = await loadOrCreateBrowserDeviceIdentity(accountId, options(factory));
    const carried = await carriedIdentity();
    const expectedKey = carried.publicKeyWire;
    // Only the desktop app still has the seed after an adoption zeroes it;
    // this test keeps a copy the way the app keeps its credential file.
    const seedAgain = carried.seed.slice();
    const adopted = await adoptBrowserDeviceIdentity(accountId, carried, options(factory));
    expect(adopted.replacedPublicKeyWire).toBe(minted.publicKeyWire);
    expect(adopted.identity.publicKeyWire).toBe(expectedKey);
    expect((await rawRecords(factory)).length).toBe(1);
    const reloaded = await loadBrowserDeviceIdentity(accountId, options(factory));
    expect(reloaded?.publicKeyWire).toBe(expectedKey);

    // The same identity offered again — every open of the desktop window —
    // is already here: nothing is replaced and nothing is reported dead.
    const same = await adoptBrowserDeviceIdentity(
      accountId,
      { seed: seedAgain, publicKeyWire: expectedKey },
      options(factory),
    );
    expect(same.replacedPublicKeyWire).toBeNull();
    expect(same.identity.publicKeyWire).toBe(expectedKey);
    expect(seedAgain.every((byte) => byte === 0)).toBe(true);
    expect((await rawRecords(factory)).length).toBe(1);
  });

  test("a seed and a public key that do not correspond are refused and leave the store alone", async () => {
    const factory = new IDBFactory();
    const accountId = accountUuid(43);
    const minted = await loadOrCreateBrowserDeviceIdentity(accountId, options(factory));
    const one = await carriedIdentity();
    const other = await carriedIdentity();
    const mismatched = { seed: one.seed, publicKeyWire: other.publicKeyWire };
    await expectIdentityError(
      adoptBrowserDeviceIdentity(accountId, mismatched, options(factory)),
      "key_mismatch",
    );
    expect(mismatched.seed.every((byte) => byte === 0)).toBe(true);
    const reloaded = await loadBrowserDeviceIdentity(accountId, options(factory));
    expect(reloaded?.publicKeyWire).toBe(minted.publicKeyWire);
    await expectIdentityError(
      adoptBrowserDeviceIdentity(
        accountId,
        { seed: new Uint8Array(31), publicKeyWire: other.publicKeyWire },
        options(factory),
      ),
      "key_mismatch",
    );
  });
});
