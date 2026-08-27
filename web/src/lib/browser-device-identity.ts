import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { encodeBrowserDeviceRegistrationTranscript } from "./browser-device-registration-transcript";
import { encodeBrowserEndorsementTranscript } from "./browser-endorsement-transcript";
import {
  encodeDeviceIntroductionTranscript,
  encodeHostIntroductionBroadcastTranscript,
  encodeHostIntroductionTranscript,
} from "./host-introduction";
import { encodeHostPairApprovalTranscript } from "./host-pair-approval-transcript";
import { encodeRootIntroductionTranscript } from "./root-introduction";
import {
  ED25519_PUBLIC_KEY_WIRE_CHARS,
  ED25519_SIGNATURE_BYTES,
  encodeBase64Url,
  exportEd25519PublicKey,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  importEd25519PrivateKeySeed,
  importEd25519PublicKeyWire,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";

export const BROWSER_DEVICE_IDENTITY_STORAGE_VERSION = 1;
export const BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS = 32;
export const BROWSER_DEVICE_IDENTITY_STORE_NAME = "device-identities";
export const BROWSER_DEVICE_IDENTITY_DATABASE_NAME = "spawn-browser-device-identity";

const CANONICAL_ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SELF_CHECK_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SELF_CHECK_SCOPE_ID = "00000000-0000-4000-8000-000000000002";
const SELF_CHECK_SDP = "v=0\r\ns=spawn-browser-device-identity-self-check\r\n";
const RECORD_KEYS = ["accountId", "privateKey", "publicKey", "publicKeyWire", "version"] as const;
const privateIdentityRecords = new WeakMap<BrowserDeviceIdentity, StoredDeviceIdentityV1>();

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

/** An identity minted elsewhere on this machine, offered to this page. */
export interface CarriedBrowserDeviceIdentity {
  /** The raw 32-byte Ed25519 seed. Zeroed once looked at, whatever the outcome. */
  readonly seed: Uint8Array;
  readonly publicKeyWire: string;
}

export interface AdoptedBrowserDeviceIdentity {
  readonly identity: BrowserDeviceIdentity;
  /** The key this account's record held before, when that was a different one. */
  readonly replacedPublicKeyWire: string | null;
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

function assertAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !CANONICAL_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new BrowserDeviceIdentityError(
      "invalid_account",
      "accountId must be an exact lowercase-hyphenated canonical UUID",
    );
  }
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
      database.createObjectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME, {
        keyPath: "accountId",
      });
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

function selfCheckTranscript(publicKey: Uint8Array): SignedSignalTranscript {
  return {
    signalKind: "offer",
    protocolVersion: 1,
    sessionId: SELF_CHECK_SESSION_ID,
    scopeType: "host",
    scopeId: SELF_CHECK_SCOPE_ID,
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
    const transcript = selfCheckTranscript(exported);
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

/**
 * Write the record for this account whatever it holds now, and say what it
 * held. One readwrite transaction, so the read and the write cannot straddle
 * another tab's first creation.
 */
async function replaceRecord(
  database: IDBDatabase,
  accountId: string,
  candidate: StoredDeviceIdentityV1,
): Promise<unknown | undefined> {
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(BROWSER_DEVICE_IDENTITY_STORE_NAME, "readwrite");
  } catch {
    throw storageFailure("browser device identity write transaction could not start");
  }
  const completion = transactionResult(transaction);
  try {
    const store = transaction.objectStore(BROWSER_DEVICE_IDENTITY_STORE_NAME);
    const previous = await requestResult(store.get(accountId));
    if (previous === undefined) {
      const count = await requestResult(store.count());
      if (count >= BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS) {
        const error = new BrowserDeviceIdentityError(
          "capacity_exceeded",
          `browser device identity storage is limited to ${BROWSER_DEVICE_IDENTITY_MAX_ACCOUNTS} accounts`,
        );
        await abortTransaction(transaction, completion);
        throw error;
      }
    }
    await requestResult(store.put(candidate));
    await completion;
    return previous;
  } catch (error) {
    await completion.catch(() => undefined);
    if (error instanceof BrowserDeviceIdentityError) throw error;
    throw storageFailure("browser device identity write failed");
  }
}

/** The public key a stored record claims, whatever else is wrong with it. */
function claimedPublicKeyWire(stored: unknown): string | null {
  if (typeof stored !== "object" || stored === null) return null;
  const value = (stored as { publicKeyWire?: unknown }).publicKeyWire;
  return typeof value === "string" && value.length === ED25519_PUBLIC_KEY_WIRE_CHARS ? value : null;
}

function publicIdentity(record: StoredDeviceIdentityV1): BrowserDeviceIdentity {
  const identity: BrowserDeviceIdentity = {
    publicKey: record.publicKey,
    publicKeyWire: record.publicKeyWire,
    sign: (transcript) => signSignedSignalTranscript(record.privateKey, transcript),
  };
  privateIdentityRecords.set(identity, record);
  return Object.freeze(identity);
}

/**
 * Produce the one bounded account-registration proof without exposing a raw
 * private-key handle or a generic byte-signing primitive to callers.
 */
export async function createBrowserDeviceRegistrationProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  // An ordinary browser device, never the account root: this signer attests
  // is_root=false inside the V2 transcript, so the server cannot promote this
  // key to root authority by flipping the request flag.
  const transcript = encodeBrowserDeviceRegistrationTranscript(
    accountId,
    record.publicKeyWire,
    false,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "browser registration signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/** Sign only the bounded host-pair approval contract with this opaque identity. */
export async function createHostPairApprovalProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  approvalNonce: string,
  hostPublicKey: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeHostPairApprovalTranscript(
    accountId,
    approvalNonce,
    hostPublicKey,
    record.publicKeyWire,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "host-pair approval signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign an endorsement admitting another browser device to a host.
 *
 * Only a device the daemon already pins can produce one it will accept, so this
 * is the operator's own trusted browser exercising authority the server does
 * not have. The endorsed key is supplied by the caller and must be the one the
 * operator confirmed out of band -- signing does not establish where it came
 * from, only that this device vouched for it.
 */
export async function createBrowserEndorsementProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  hostPublicKey: string,
  endorsedPublicKey: string,
  endorsedDeviceId: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeBrowserEndorsementTranscript(
    accountId,
    hostPublicKey,
    record.publicKeyWire,
    endorsedPublicKey,
    endorsedDeviceId,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "browser endorsement signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign an ACCOUNT-scoped endorsement of another device's key (device mesh §3).
 *
 * Unlike {@link createBrowserEndorsementProof} there is no host: the same signed
 * edge is valid toward every host of the account, carried by the endorsed device
 * and presented on connect. The endorsed key must be the one the operator
 * confirmed via the SAS number-match; signing does not establish where it came
 * from, only that this device vouched for it account-wide.
 */
export async function createAccountEndorsementProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  endorsedPublicKey: string,
  endorsedDeviceId: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeAcctEndorsementTranscript(
    accountId,
    record.publicKeyWire,
    endorsedPublicKey,
    endorsedDeviceId,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "account endorsement signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign a host-key introduction toward one specific joiner (device mesh R7).
 *
 * The statement is scoped: THIS device (which verified `hostPublicKey` out of
 * band, or it must not sign) vouches that key to exactly `joinerPublicKey` —
 * the key the SAS ceremony authenticated. Domain-separated from every
 * endorsement transcript; the daemon never sees or accepts it.
 */
export async function createHostIntroductionProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  hostPublicKey: string,
  joinerPublicKey: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeHostIntroductionTranscript(
    accountId,
    record.publicKeyWire,
    hostPublicKey,
    joinerPublicKey,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "host introduction signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign the DURABLE broadcast form of a host introduction (continuous gossip):
 * this device vouches `hostPublicKey` — a key it verified out of band, or it
 * must not sign — to the whole account, unscoped to any recipient. Recipients
 * only honor it if they hold THIS device's key firsthand.
 */
export async function createHostIntroductionBroadcastProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  hostPublicKey: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeHostIntroductionBroadcastTranscript(
    accountId,
    record.publicKeyWire,
    hostPublicKey,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "host introduction signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign a root-key introduction (SPAWN-ROOT-INTRO-V1): this device vouches
 * `rootPublicKey` — a key it holds FIRSTHAND (minted it, or unsealed it from
 * the passkey bundle), or it must not sign — to the whole account. Recipients
 * only honor it if they hold THIS device's key firsthand; it is what lets a
 * pinned device anchor the root without ever trusting the server's `is_root`
 * claim (§4.1 provenance rule).
 */
export async function createRootIntroductionProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  rootPublicKey: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeRootIntroductionTranscript(
    accountId,
    record.publicKeyWire,
    rootPublicKey,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "root introduction signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Sign a device-key introduction toward one specific joiner: this device hands
 * over a peer device key it learned FIRSTHAND, so the joiner can later verify
 * that peer's broadcast host introductions without having met it.
 */
export async function createDeviceIntroductionProof(
  identity: BrowserDeviceIdentity,
  accountId: string,
  peerPublicKey: string,
  peerDeviceId: string,
  joinerPublicKey: string,
): Promise<string> {
  assertAccountId(accountId);
  const record = privateIdentityRecords.get(identity);
  if (record === undefined || record.accountId !== accountId) {
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "browser device identity does not belong to the authenticated account",
    );
  }
  const transcript = encodeDeviceIntroductionTranscript(
    accountId,
    record.publicKeyWire,
    peerPublicKey,
    peerDeviceId,
    joinerPublicKey,
  );
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, record.privateKey, ownedTranscript),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new BrowserDeviceIdentityError(
      "corrupt_record",
      "device introduction signer returned an invalid signature length",
    );
  }
  return encodeBase64Url(signature);
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
 * Take on an identity minted elsewhere on this same machine: the desktop
 * app's, handed to the page it hosts (desktop-device-handover.ts). One
 * computer is one device, so the page runs as the device that possessed it
 * rather than as a stranger the account has to be asked about.
 *
 * The seed goes in non-extractable and the pair is proven to correspond
 * before anything is written; the seed bytes are zeroed on every path. A
 * record already holding this key is left exactly as it is. A record holding
 * another key is replaced — the page was a device of its own until now, and
 * is that device no longer — and the caller is told which key died, so the
 * roster row it registered can be retired.
 */
export async function adoptBrowserDeviceIdentity(
  accountId: string,
  carried: CarriedBrowserDeviceIdentity,
  options: BrowserDeviceIdentityStorageOptions = {},
): Promise<AdoptedBrowserDeviceIdentity> {
  assertAccountId(accountId);
  let candidate: StoredDeviceIdentityV1;
  try {
    const privateKey = await importEd25519PrivateKeySeed(carried.seed);
    const publicKey = await importEd25519PublicKeyWire(carried.publicKeyWire);
    candidate = await validateStoredRecord(
      {
        accountId,
        privateKey,
        publicKey,
        publicKeyWire: carried.publicKeyWire,
        version: BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
      },
      accountId,
    );
  } catch (error) {
    if (error instanceof BrowserDeviceIdentityError && error.code !== "corrupt_record") {
      throw error;
    }
    throw new BrowserDeviceIdentityError(
      "key_mismatch",
      "the carried device identity is not a corresponding Ed25519 pair",
    );
  } finally {
    carried.seed.fill(0);
  }

  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const stored = await getStoredRecord(database, accountId);
    if (stored !== undefined) {
      const existing = await validateStoredRecord(stored, accountId).catch(() => null);
      if (existing !== null && existing.publicKeyWire === candidate.publicKeyWire) {
        return { identity: publicIdentity(existing), replacedPublicKeyWire: null };
      }
    }
    const previous = await replaceRecord(database, accountId, candidate);
    const replaced = claimedPublicKeyWire(previous);
    return {
      identity: publicIdentity(candidate),
      replacedPublicKeyWire: replaced === candidate.publicKeyWire ? null : replaced,
    };
  } finally {
    database.close();
  }
}

/** Load and validate an existing identity without ever generating a replacement. */
export async function loadBrowserDeviceIdentity(
  accountId: string,
  options: BrowserDeviceIdentityStorageOptions = {},
): Promise<BrowserDeviceIdentity | null> {
  assertAccountId(accountId);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory, BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
  try {
    const stored = await getStoredRecord(database, accountId);
    return stored === undefined
      ? null
      : publicIdentity(await validateStoredRecord(stored, accountId));
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
