import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
  BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS,
  BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
  BROWSER_DEVICE_IDENTITY_STORE_NAME,
  BrowserDeviceIdentityError,
  deleteBrowserDeviceIdentity,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
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

function transcript(accountId: string, publicKeyWire: string): SignedSignalTranscript {
  return {
    signalKind: "offer",
    protocolVersion: 1,
    sessionId: "browser-identity-unit-test",
    scopeType: "host",
    scopeId: accountId,
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
  test("persists one non-extractable account key and reloads only its public handle", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = "account-persistence";

    const first = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const reloaded = await loadOrCreateBrowserDeviceIdentity(accountId, storage);

    expect(reloaded.publicKeyWire).toBe(first.publicKeyWire);
    expect(Object.keys(first).sort()).toEqual(["publicKey", "publicKeyWire", "sign"]);
    const value = transcript(accountId, first.publicKeyWire);
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
      Array.from({ length: 12 }, () => loadOrCreateBrowserDeviceIdentity("account-race", storage)),
    );

    expect(new Set(identities.map((identity) => identity.publicKeyWire)).size).toBe(1);
    expect(
      (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, "account-race"))
        ?.publicKeyWire,
    ).toBe(identities[0].publicKeyWire);
  });

  test("keeps accounts separate in the same bounded database", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const alpha = await loadOrCreateBrowserDeviceIdentity("account-alpha", storage);
    const beta = await loadOrCreateBrowserDeviceIdentity("account-beta", storage);

    expect(alpha.publicKeyWire).not.toBe(beta.publicKeyWire);
    expect((await loadOrCreateBrowserDeviceIdentity("account-alpha", storage)).publicKeyWire).toBe(
      alpha.publicKeyWire,
    );
  });

  test("fails closed on corrupt shape and does not replace the record", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = "account-corrupt";
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
    await loadOrCreateBrowserDeviceIdentity("account-one", storage);
    await loadOrCreateBrowserDeviceIdentity("account-two", storage);
    const first = (await rawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, "account-one"))!;
    const second = (await rawRecord(
      factory,
      BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
      "account-two",
    ))!;
    first.privateKey = second.privateKey;
    await putRawRecord(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME, first);

    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity("account-one", storage),
      "corrupt_record",
    );
  });

  test("rejects stored keys with altered algorithm or usages", async () => {
    const usageFactory = new IDBFactory();
    const usageStorage = options(usageFactory);
    const usageAccount = "account-invalid-usage";
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
    const algorithmAccount = "account-invalid-algorithm";
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
      loadOrCreateBrowserDeviceIdentity("account-unavailable", { indexedDBFactory: null }),
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
        seedRecord: { account: "seed", marker: "compound-key-path", tenant: "test" },
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
        loadOrCreateBrowserDeviceIdentity("account-schema-check", storage),
        "corrupt_record",
      );
      await expectIdentityError(
        loadOrCreateBrowserDeviceIdentity("account-schema-check", storage),
        "corrupt_record",
      );

      expect(await rawRecords(factory)).toEqual(before);
    }
  });

  test("deletes only when the expected public key matches", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    const accountId = "account-delete";
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, storage);
    const other = await loadOrCreateBrowserDeviceIdentity("account-other", storage);

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

  test("bounds account identifiers and total stored account records", async () => {
    const factory = new IDBFactory();
    const storage = options(factory);
    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity("x".repeat(257), storage),
      "invalid_account",
    );

    await loadOrCreateBrowserDeviceIdentity("occupied-0", storage);
    const database = await requestResult(factory.open(BROWSER_DEVICE_IDENTITY_DATABASE_NAME));
    const transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readwrite");
    const completion = transactionResult(transaction);
    const store = transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME);
    for (let index = 1; index < BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS; index += 1) {
      store.add({ accountId: `occupied-${index}` });
    }
    await completion;
    database.close();

    await expectIdentityError(
      loadOrCreateBrowserDeviceIdentity("account-over-capacity", storage),
      "capacity_exceeded",
    );
  });
});
