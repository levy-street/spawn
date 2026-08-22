/**
 * Durable FIRSTHAND root-key memory (docs/TRUST_DEVICE_MESH.md §4.1 —
 * the `pk_R` provenance rule).
 *
 * The root anchor sweep is only as sound as this store's provenance rule: a
 * device signs the per-host anchor endorsement of `pk_R` ONLY for a key
 * recorded here, and a key enters here ONLY through a channel the server
 * cannot forge —
 *
 *   1. "mint": this device generated the root during passkey setup;
 *   2. "bundle": this device unsealed it from the passkey trust bundle
 *      (authenticated, rollback-floored);
 *   3. "introduction": a SPAWN-ROOT-INTRO-V1 statement verified against a
 *      ceremony-learned firsthand peer key (root-introduction.ts).
 *
 * NEVER seed this store from the server's `is_root` roster row: anchoring a
 * server-claimed key hands a hostile server a forged-anchor path (P2).
 *
 * Conflict discipline: mint/bundle sources overwrite freely (they carry the
 * passkey's own authority and the bundle's rollback protection). An
 * introduction never overwrites a different key unless the caller proved
 * corroborated rotation and passes `replace` — otherwise the write is refused
 * and the caller must surface the conflict, not resolve it.
 */

import { BrowserHostPinError, type BrowserHostPinStorageOptions } from "./browser-host-pins";
import { decodeEd25519PublicKeyWire } from "./signed-signal";

export const ROOT_KNOWLEDGE_DATABASE_NAME = "spawn-root-knowledge";
export const ROOT_KNOWLEDGE_STORE_NAME = "root-keys";
export const ROOT_KNOWLEDGE_STORAGE_VERSION = 1;

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type FirsthandRootSource = "mint" | "bundle" | "introduction";

export interface FirsthandRootRecord {
  readonly accountId: string;
  readonly origin: string;
  /** Ed25519 public key, wire (43-char base64url) form. */
  readonly rootPublicKey: string;
  readonly source: FirsthandRootSource;
  readonly learnedAtMs: number;
  readonly version: 1;
}

interface StoredFirsthandRootV1 extends FirsthandRootRecord {
  readonly recordId: string;
}

export class RootKnowledgeConflictError extends Error {
  constructor(
    readonly heldRootPublicKey: string,
    readonly offeredRootPublicKey: string,
  ) {
    super(
      "a different root is already recorded firsthand on this device; " +
        "refusing to replace it without corroborated rotation",
    );
    this.name = "RootKnowledgeConflictError";
  }
}

function recordId(accountId: string, origin: string): string {
  return JSON.stringify([accountId, origin]);
}

function assertInputs(accountId: string, origin: string, rootPublicKey?: string): void {
  if (!CANONICAL_UUID_PATTERN.test(accountId)) {
    throw new BrowserHostPinError("invalid_account", "accountId must be a canonical UUID");
  }
  if (typeof origin !== "string" || origin.length === 0 || origin.length > 512) {
    throw new BrowserHostPinError("invalid_origin", "origin must be a canonical HTTP(S) origin");
  }
  if (rootPublicKey !== undefined) {
    decodeEd25519PublicKeyWire(rootPublicKey);
  }
}

function resolveFactory(options: BrowserHostPinStorageOptions): IDBFactory {
  const factory = Object.hasOwn(options, "indexedDBFactory")
    ? options.indexedDBFactory
    : globalThis.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== "function") {
    throw new BrowserHostPinError(
      "storage_unavailable",
      "IndexedDB is unavailable; root knowledge was not changed",
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
      request = factory.open(ROOT_KNOWLEDGE_DATABASE_NAME, ROOT_KNOWLEDGE_STORAGE_VERSION);
    } catch {
      reject(
        new BrowserHostPinError(
          "storage_unavailable",
          "the root-knowledge database could not be opened",
        ),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ROOT_KNOWLEDGE_STORE_NAME)) {
        database.createObjectStore(ROOT_KNOWLEDGE_STORE_NAME, { keyPath: "recordId" });
      }
    };
    request.onerror = () =>
      reject(new BrowserHostPinError("storage_failure", "the root-knowledge database open failed"));
    request.onblocked = () =>
      reject(
        new BrowserHostPinError(
          "storage_unavailable",
          "the root-knowledge database open is blocked by another page",
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
  body: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase(resolveFactory(options));
  try {
    const transaction = database.transaction(ROOT_KNOWLEDGE_STORE_NAME, mode);
    const completion = transactionResult(transaction);
    const result = await body(transaction.objectStore(ROOT_KNOWLEDGE_STORE_NAME));
    await completion;
    return result;
  } finally {
    database.close();
  }
}

/**
 * Record the firsthand-known root key. Mint/bundle sources overwrite freely;
 * an introduction refuses to replace a DIFFERENT held key unless `replace`
 * (corroborated rotation, proven by the caller) is set — the refusal throws
 * `RootKnowledgeConflictError` so the caller surfaces it loudly.
 */
export async function rememberFirsthandRoot(
  input: {
    accountId: string;
    origin: string;
    rootPublicKey: string;
    source: FirsthandRootSource;
    replace?: boolean;
  },
  storage: BrowserHostPinStorageOptions = {},
): Promise<void> {
  assertInputs(input.accountId, input.origin, input.rootPublicKey);
  const now = (storage.now ?? Date.now)();
  await withStore(storage, "readwrite", async (store) => {
    const id = recordId(input.accountId, input.origin);
    const existing = (await requestResult(store.get(id))) as StoredFirsthandRootV1 | undefined;
    if (
      existing !== undefined &&
      existing.rootPublicKey !== input.rootPublicKey &&
      input.source === "introduction" &&
      input.replace !== true
    ) {
      throw new RootKnowledgeConflictError(existing.rootPublicKey, input.rootPublicKey);
    }
    const record: StoredFirsthandRootV1 = {
      recordId: id,
      accountId: input.accountId,
      origin: input.origin,
      rootPublicKey: input.rootPublicKey,
      source: input.source,
      learnedAtMs: existing?.rootPublicKey === input.rootPublicKey ? existing.learnedAtMs : now,
      version: 1,
    };
    await requestResult(store.put(record));
  });
}

/** The firsthand root record for this account+origin, if any. */
export async function loadFirsthandRoot(
  input: { accountId: string; origin: string },
  storage: BrowserHostPinStorageOptions = {},
): Promise<FirsthandRootRecord | null> {
  assertInputs(input.accountId, input.origin);
  return withStore(storage, "readonly", async (store) => {
    const row = (await requestResult(store.get(recordId(input.accountId, input.origin)))) as
      | StoredFirsthandRootV1
      | undefined;
    if (
      row === undefined ||
      row.version !== 1 ||
      row.accountId !== input.accountId ||
      row.origin !== input.origin ||
      typeof row.rootPublicKey !== "string"
    ) {
      return null;
    }
    const { recordId: _recordId, ...record } = row;
    return record;
  });
}

/** Local hygiene (e.g. account teardown in tests). */
export async function forgetFirsthandRoot(
  input: { accountId: string; origin: string },
  storage: BrowserHostPinStorageOptions = {},
): Promise<void> {
  assertInputs(input.accountId, input.origin);
  await withStore(storage, "readwrite", async (store) => {
    await requestResult(store.delete(recordId(input.accountId, input.origin)));
  });
}
