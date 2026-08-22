/**
 * Durable FIRSTHAND peer-device-key memory (continuous gossip, mesh R7).
 *
 * The continuous host-key gossip is only as sound as this store's provenance
 * rule: a broadcast introduction is honored ONLY when its publisher key is
 * recorded here, and a key enters here ONLY through a channel the server
 * cannot forge —
 *
 *   1. add-device ceremony completion: each side persists the peer key its
 *      committed SAS pinned (the exact bytes the human's number covered);
 *   2. a device introduction carried INSIDE a ceremony, signed by the
 *      ceremony-pinned approver key and verified against it.
 *
 * NEVER seed this store from server-claimed metadata (endorsement-edge
 * `endorser_public_key`, roster rows, and the like): a self-signed edge naming
 * an attacker key verifies under its own claim, so trusting it would let the
 * server mint a fake peer and then fake host introductions — a full MITM.
 * Removal is local hygiene for revoked devices; the host pins a peer already
 * delivered stay (they are this device's own verified state).
 */

import { BrowserHostPinError, type BrowserHostPinStorageOptions } from "./browser-host-pins";
import { decodeEd25519PublicKeyWire } from "./signed-signal";

export const PEER_DEVICE_KEY_DATABASE_NAME = "spawn-peer-device-keys";
export const PEER_DEVICE_KEY_STORE_NAME = "peer-keys";
export const PEER_DEVICE_KEY_STORAGE_VERSION = 1;
export const PEER_DEVICE_KEY_MAX_RECORDS = 256;

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type PeerDeviceKeySource = "ceremony" | "ceremony-introduction";

export interface PeerDeviceKey {
  readonly accountId: string;
  readonly origin: string;
  /** Ed25519 public key, wire (43-char base64url) form — the record identity. */
  readonly publicKey: string;
  /** Server-assigned device id at learn time. Display/correlation only. */
  readonly deviceId: string;
  readonly source: PeerDeviceKeySource;
  readonly learnedAtMs: number;
  readonly version: 1;
}

interface StoredPeerDeviceKeyV1 extends PeerDeviceKey {
  readonly recordId: string;
}

function recordId(accountId: string, origin: string, publicKey: string): string {
  return JSON.stringify([accountId, origin, publicKey]);
}

function assertInputs(accountId: string, origin: string, publicKey?: string): void {
  if (!CANONICAL_UUID_PATTERN.test(accountId)) {
    throw new BrowserHostPinError("invalid_account", "accountId must be a canonical UUID");
  }
  if (typeof origin !== "string" || origin.length === 0 || origin.length > 512) {
    throw new BrowserHostPinError("invalid_origin", "origin must be a canonical HTTP(S) origin");
  }
  if (publicKey !== undefined) {
    decodeEd25519PublicKeyWire(publicKey);
  }
}

function resolveFactory(options: BrowserHostPinStorageOptions): IDBFactory {
  const factory = Object.hasOwn(options, "indexedDBFactory")
    ? options.indexedDBFactory
    : globalThis.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== "function") {
    throw new BrowserHostPinError(
      "storage_unavailable",
      "IndexedDB is unavailable; peer device keys were not changed",
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
      // The abort event owns rejection.
    };
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(PEER_DEVICE_KEY_DATABASE_NAME, PEER_DEVICE_KEY_STORAGE_VERSION);
    } catch {
      reject(
        new BrowserHostPinError(
          "storage_unavailable",
          "the peer-device-key database could not be opened",
        ),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PEER_DEVICE_KEY_STORE_NAME)) {
        database.createObjectStore(PEER_DEVICE_KEY_STORE_NAME, { keyPath: "recordId" });
      }
    };
    request.onerror = () =>
      reject(
        new BrowserHostPinError("storage_failure", "the peer-device-key database open failed"),
      );
    request.onblocked = () =>
      reject(
        new BrowserHostPinError(
          "storage_unavailable",
          "the peer-device-key database open is blocked by another page",
        ),
      );
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function withStore<T>(
  options: BrowserHostPinStorageOptions,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await openDatabase(resolveFactory(options));
  try {
    const transaction = database.transaction(PEER_DEVICE_KEY_STORE_NAME, mode);
    const completion = transactionResult(transaction);
    const result = await body(transaction.objectStore(PEER_DEVICE_KEY_STORE_NAME), transaction);
    await completion;
    return result;
  } finally {
    database.close();
  }
}

/**
 * Record one firsthand-learned peer device key. Idempotent: the key is the
 * record identity, so re-learning refreshes the advisory fields (device id,
 * source stays the earliest, i.e. strongest, provenance) and never forks.
 */
export async function rememberPeerDeviceKey(
  input: {
    accountId: string;
    origin: string;
    publicKey: string;
    deviceId: string;
    source: PeerDeviceKeySource;
  },
  storage: BrowserHostPinStorageOptions = {},
): Promise<void> {
  assertInputs(input.accountId, input.origin, input.publicKey);
  if (!CANONICAL_UUID_PATTERN.test(input.deviceId)) {
    throw new BrowserHostPinError("invalid_host_id", "deviceId must be a canonical UUID");
  }
  const now = (storage.now ?? Date.now)();
  await withStore(storage, "readwrite", async (store) => {
    const id = recordId(input.accountId, input.origin, input.publicKey);
    const existing = (await requestResult(store.get(id))) as StoredPeerDeviceKeyV1 | undefined;
    const count = await requestResult(store.count());
    if (existing === undefined && count >= PEER_DEVICE_KEY_MAX_RECORDS) {
      throw new BrowserHostPinError("capacity_exceeded", "too many peer device keys");
    }
    const record: StoredPeerDeviceKeyV1 = {
      recordId: id,
      accountId: input.accountId,
      origin: input.origin,
      publicKey: input.publicKey,
      deviceId: input.deviceId,
      source: existing?.source === "ceremony" ? "ceremony" : input.source,
      learnedAtMs: existing?.learnedAtMs ?? now,
      version: 1,
    };
    await requestResult(store.put(record));
  });
}

/** Every firsthand peer key for this account+origin. */
export async function listPeerDeviceKeys(
  input: { accountId: string; origin: string },
  storage: BrowserHostPinStorageOptions = {},
): Promise<PeerDeviceKey[]> {
  assertInputs(input.accountId, input.origin);
  return withStore(storage, "readonly", async (store) => {
    const rows = (await requestResult(store.getAll())) as StoredPeerDeviceKeyV1[];
    return rows
      .filter(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          row.version === 1 &&
          row.accountId === input.accountId &&
          row.origin === input.origin &&
          typeof row.publicKey === "string" &&
          typeof row.deviceId === "string",
      )
      .map(({ recordId: _recordId, ...record }) => record);
  });
}

/** Local hygiene when a peer is revoked: forget its key (its delivered host
 * pins stay — they are this device's own verified state, mesh R10 handles the
 * key itself account-wide). */
export async function forgetPeerDeviceKey(
  input: { accountId: string; origin: string; publicKey: string },
  storage: BrowserHostPinStorageOptions = {},
): Promise<void> {
  assertInputs(input.accountId, input.origin, input.publicKey);
  await withStore(storage, "readwrite", async (store) => {
    await requestResult(store.delete(recordId(input.accountId, input.origin, input.publicKey)));
  });
}
