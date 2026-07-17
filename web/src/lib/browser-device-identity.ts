import {
  ED25519_PUBLIC_KEY_WIRE_CHARS,
  exportEd25519PublicKey,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  importEd25519PublicKeyWire,
  MAX_SCOPE_ID_BYTES,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";

export const BROWSER_DEVICE_IDENTITY_STORAGE_VERSION = 1;
export const BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS = 32;
export const BROWSER_DEVICE_IDENTITY_STORE_NAME = "device-identities";
export const BROWSER_DEVICE_IDENTITY_DATABASE_NAME = "spawn-browser-device-identity";

const SELF_CHECK_SESSION_ID = "spawn-browser-device-identity-self-check-v1";
const SELF_CHECK_SDP = "v=0\r\ns=spawn-browser-device-identity-self-check\r\n";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const RECORD_KEYS = ["accountId", "privateKey", "publicKey", "publicKeyWire", "version"] as const;

interface StoredDeviceIdentityV1 {
  accountId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyWire: string;
  version: 1;
}

export interface BrowserDeviceIdentity {
  readonly publicKey: CryptoKey;
  readonly publicKeyWire: string;
  sign(transcript: SignedSignalTranscript): Promise<string>;
}

export interface BrowserDeviceIdentityStorageOptions {
  /** Test/isolation override. Pass null to require an unavailable-storage failure. */
  readonly indexedDBFactory?: IDBFactory | null;
}

export type BrowserDeviceIdentityErrorCode =
  | "capacity_exceeded"
  | "corrupt_record"
  | "invalid_account"
  | "key_mismatch"
  | "storage_failure"
  | "storage_unavailable";

export class BrowserDeviceIdentityError extends Error {
  constructor(
    readonly code: BrowserDeviceIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserDeviceIdentityError";
  }
}

function assertBoundedScalarText(value: string, field: string, maxBytes: number): void {
  if (typeof value !== "string") {
    throw new BrowserDeviceIdentityError("invalid_account", `${field} must be a string`);
  }
  const encoded = textEncoder.encode(value);
  if (
    encoded.byteLength < 1 ||
    encoded.byteLength > maxBytes ||
    textDecoder.decode(encoded) !== value
  ) {
    throw new BrowserDeviceIdentityError(
      "invalid_account",
      `${field} must be 1..=${maxBytes} bytes of strict Unicode scalar text`,
    );
  }
}

function assertAccountId(accountId: string): void {
  assertBoundedScalarText(accountId, "accountId", MAX_SCOPE_ID_BYTES);
}

function resolveIndexedDB(options: BrowserDeviceIdentityStorageOptions): IDBFactory {
  const factory = Object.hasOwn(options, "indexedDBFactory")
    ? options.indexedDBFactory
    : globalThis.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== "function") {
    throw new BrowserDeviceIdentityError(
      "storage_unavailable",
      "IndexedDB is unavailable; browser device identity was not created or rotated",
    );
  }
  return factory;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => {
      // The following abort event owns rejection so callers receive the final
      // transaction error and never accidentally continue after a failed write.
    };
  });
}

async function abortTransaction(
  transaction: IDBTransaction,
  completion: Promise<void>,
): Promise<void> {
  try {
    transaction.abort();
  } catch {
    // A transaction that already failed or completed needs no second abort.
  }
  await completion.catch(() => undefined);
}

function storageFailure(message: string): BrowserDeviceIdentityError {
  return new BrowserDeviceIdentityError("storage_failure", message);
}

function hasExpectedObjectStoreSchema(database: IDBDatabase): boolean {
  try {
    const store = database
      .transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly")
      .objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME);
    return store.keyPath === "accountId" && store.autoIncrement === false;
  } catch {
    return false;
  }
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let upgradeError: BrowserDeviceIdentityError | undefined;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, BROWSER_DEVICE_IDENTITY_STORAGE_VERSION);
    } catch {
      reject(
        new BrowserDeviceIdentityError(
          "storage_unavailable",
          "IndexedDB could not be opened; browser device identity was not created or rotated",
        ),
      );
      return;
    }

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (
        event.oldVersion !== 0 ||
        database.objectStoreNames.contains(BROWSER_DEVICE_IDENTITY_STORE_NAME)
      ) {
        upgradeError = new BrowserDeviceIdentityError(
          "corrupt_record",
          "unsupported browser device identity database schema",
        );
        request.transaction?.abort();
        return;
      }
      database.createObjectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME, { keyPath: "accountId" });
    };
    request.onerror = () =>
      fail(upgradeError ?? storageFailure("browser device identity database open failed"));
    request.onblocked = () =>
      fail(
        new BrowserDeviceIdentityError(
          "storage_unavailable",
          "browser device identity database upgrade is blocked",
        ),
      );
    request.onsuccess = () => {
      const database = request.result;
      if (finished) {
        database.close();
        return;
      }
      if (
        !database.objectStoreNames.contains(BROWSER_DEVICE_IDENTITY_STORE_NAME) ||
        !hasExpectedObjectStoreSchema(database)
      ) {
        database.close();
        fail(
          new BrowserDeviceIdentityError(
            "corrupt_record",
            "browser device identity object store schema is invalid",
          ),
        );
        return;
      }
      finished = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function getStoredRecord(
  database: IDBDatabase,
  accountId: string,
): Promise<unknown | undefined> {
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
  } catch {
    throw storageFailure("browser device identity read transaction could not start");
  }
  const completion = transactionResult(transaction);
  try {
    const value = await requestResult(
      transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME).get(accountId),
    );
    await completion;
    return value;
  } catch (error) {
    await completion.catch(() => undefined);
    if (error instanceof BrowserDeviceIdentityError) throw error;
    throw storageFailure("browser device identity read failed");
  }
}

function assertCryptoKeyMetadata(
  value: unknown,
  type: "private" | "public",
  usage: "sign" | "verify",
  extractable: boolean,
): asserts value is CryptoKey {
  if (typeof value !== "object" || value === null) {
    throw new BrowserDeviceIdentityError("corrupt_record", `stored ${type} key is missing`);
  }
  try {
    const key = value as CryptoKey;
    if (
      key.type !== type ||
      key.algorithm?.name !== "Ed25519" ||
      key.extractable !== extractable ||
      key.usages.length !== 1 ||
      key.usages[0] !== usage
    ) {
      throw new BrowserDeviceIdentityError(
        "corrupt_record",
        `stored ${type} key has invalid algorithm, extractability, or usages`,
      );
    }
  } catch (error) {
    if (error instanceof BrowserDeviceIdentityError) throw error;
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      `stored ${type} key metadata is unreadable`,
    );
  }
}

function assertStoredRecordShape(value: unknown, accountId: string): StoredDeviceIdentityV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserDeviceIdentityError("corrupt_record", "stored identity is not a record");
  }
  const record = value as Partial<StoredDeviceIdentityV1>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    RECORD_KEYS.some((key, index) => key !== keys[index]) ||
    record.version !== BROWSER_DEVICE_IDENTITY_STORAGE_VERSION ||
    record.accountId !== accountId ||
    typeof record.publicKeyWire !== "string" ||
    record.publicKeyWire.length !== ED25519_PUBLIC_KEY_WIRE_CHARS
  ) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "stored browser device identity has an invalid shape or version",
    );
  }
  assertCryptoKeyMetadata(record.privateKey, "private", "sign", false);
  assertCryptoKeyMetadata(record.publicKey, "public", "verify", true);
  return record as StoredDeviceIdentityV1;
}

function selfCheckTranscript(accountId: string, publicKey: Uint8Array): SignedSignalTranscript {
  return {
    signalKind: "offer",
    protocolVersion: 1,
    sessionId: SELF_CHECK_SESSION_ID,
    scopeType: "host",
    scopeId: accountId,
    senderRole: "browser",
    intendedPeerPublicKey: publicKey,
    sdp: SELF_CHECK_SDP,
  };
}

async function validateStoredRecord(
  value: unknown,
  accountId: string,
): Promise<StoredDeviceIdentityV1> {
  const record = assertStoredRecordShape(value, accountId);
  try {
    const exported = await exportEd25519PublicKey(record.publicKey);
    const exportedWire = await exportEd25519PublicKeyWire(record.publicKey);
    if (exportedWire !== record.publicKeyWire) {
      throw new BrowserDeviceIdentityError(
        "corrupt_record",
        "stored public key does not match its canonical wire value",
      );
    }
    const transcript = selfCheckTranscript(accountId, exported);
    const signature = await signSignedSignalTranscript(record.privateKey, transcript);
    if (!(await verifySignedSignalTranscript(record.publicKey, transcript, signature))) {
      throw new BrowserDeviceIdentityError(
        "corrupt_record",
        "stored private and public keys do not correspond",
      );
    }
    return record;
  } catch (error) {
    if (error instanceof BrowserDeviceIdentityError) throw error;
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "stored browser device identity failed cryptographic validation",
    );
  }
}

async function createCandidate(accountId: string): Promise<StoredDeviceIdentityV1> {
  const keyPair = await generateEd25519IdentityKeyPair();
  return {
    accountId,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyWire: await exportEd25519PublicKeyWire(keyPair.publicKey),
    version: BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
  };
}

async function addCandidateOrLoadWinner(
  database: IDBDatabase,
  accountId: string,
  candidate: StoredDeviceIdentityV1,
): Promise<unknown> {
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readwrite");
  } catch {
    throw storageFailure("browser device identity write transaction could not start");
  }
  const completion = transactionResult(transaction);
  try {
    const store = transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME);
    const winner = await requestResult(store.get(accountId));
    if (winner !== undefined) {
      await completion;
      return winner;
    }
    const count = await requestResult(store.count());
    if (count >= BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS) {
      const error = new BrowserDeviceIdentityError(
        "capacity_exceeded",
        `browser device identity storage is limited to ${BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS} accounts`,
      );
      await abortTransaction(transaction, completion);
      throw error;
    }
    await requestResult(store.add(candidate));
    await completion;
    return candidate;
  } catch (error) {
    await completion.catch(() => undefined);
    if (error instanceof BrowserDeviceIdentityError) throw error;
    throw storageFailure("browser device identity write failed");
  }
}

function publicIdentity(record: StoredDeviceIdentityV1): BrowserDeviceIdentity {
  const identity: BrowserDeviceIdentity = {
    publicKey: record.publicKey,
    publicKeyWire: record.publicKeyWire,
    sign: (transcript) => signSignedSignalTranscript(record.privateKey, transcript),
  };
  return Object.freeze(identity);
}

/**
 * Load an account-scoped identity, or create it exactly once. The private key
 * remains a non-extractable CryptoKey inside IndexedDB and this closure; it is
 * never returned, serialized as bytes/JWK, or placed in Web Storage.
 */
export async function loadOrCreateBrowserDeviceIdentity(
  accountId: string,
  options: BrowserDeviceIdentityStorageOptions = {},
): Promise<BrowserDeviceIdentity> {
  assertAccountId(accountId);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const stored = await getStoredRecord(database, accountId);
    if (stored !== undefined) {
      return publicIdentity(await validateStoredRecord(stored, accountId));
    }

    // Key generation cannot be awaited inside an IndexedDB transaction: the
    // transaction may auto-commit. Generate outside, then let the serialized
    // readwrite get/add choose one winner across tabs without overwriting it.
    const candidate = await createCandidate(accountId);
    const winner = await addCandidateOrLoadWinner(database, accountId, candidate);
    return publicIdentity(await validateStoredRecord(winner, accountId));
  } finally {
    database.close();
  }
}

/**
 * Delete only the identity whose canonical public key the caller expects.
 * A mismatch is loud and leaves the stored identity untouched.
 */
export async function deleteBrowserDeviceIdentity(
  accountId: string,
  expectedPublicKeyWire: string,
  options: BrowserDeviceIdentityStorageOptions = {},
): Promise<boolean> {
  assertAccountId(accountId);
  try {
    await importEd25519PublicKeyWire(expectedPublicKeyWire);
  } catch {
    throw new BrowserDeviceIdentityError("key_mismatch", "expected public key is invalid");
  }

  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const stored = await getStoredRecord(database, accountId);
    if (stored === undefined) return false;
    const validated = await validateStoredRecord(stored, accountId);
    if (validated.publicKeyWire !== expectedPublicKeyWire) {
      throw new BrowserDeviceIdentityError(
        "key_mismatch",
        "stored browser device identity does not match the expected public key",
      );
    }

    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readwrite");
    } catch {
      throw storageFailure("browser device identity deletion transaction could not start");
    }
    const completion = transactionResult(transaction);
    try {
      const store = transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME);
      const current = await requestResult(store.get(accountId));
      if (current === undefined) {
        await completion;
        return false;
      }
      const currentRecord = assertStoredRecordShape(current, accountId);
      if (currentRecord.publicKeyWire !== expectedPublicKeyWire) {
        const error = new BrowserDeviceIdentityError(
          "key_mismatch",
          "browser device identity changed before deletion",
        );
        await abortTransaction(transaction, completion);
        throw error;
      }
      await requestResult(store.delete(accountId));
      await completion;
      return true;
    } catch (error) {
      await completion.catch(() => undefined);
      if (error instanceof BrowserDeviceIdentityError) throw error;
      throw storageFailure("browser device identity deletion failed");
    }
  } finally {
    database.close();
  }
}
