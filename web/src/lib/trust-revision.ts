/**
 * The per-account rollback floor for the sealed trust bundle.
 *
 * A bundle carries a monotonic revision authenticated inside its ciphertext
 * (trust-bundle.ts). This store records the highest revision this device has
 * ever opened or sealed. Before trusting an opened bundle, the caller refuses
 * any revision below the floor — so an untrusted control plane cannot replay an
 * older *authentic* bundle to resurrect host keys or passkeys the operator has
 * since withdrawn. A brand-new device has floor 0 and cannot detect a rollback
 * it never witnessed; that residual is inherent without a trusted anchor and is
 * documented in docs/TRUST.md.
 */

const DATABASE_NAME = "spawn-trust-bundle-revision";
const STORE_NAME = "revisions";
const DATABASE_VERSION = 1;

export interface TrustRevisionStorageOptions {
  /** Test/isolation override. Pass null to require an unavailable-storage failure. */
  readonly indexedDBFactory?: IDBFactory | null;
}

export class TrustRevisionError extends Error {
  constructor(
    readonly code: "storage_unavailable" | "storage_failure" | "stale_bundle",
    message: string,
  ) {
    super(message);
    this.name = "TrustRevisionError";
  }
}

function resolveIndexedDB(options: TrustRevisionStorageOptions): IDBFactory {
  if (options.indexedDBFactory === null) {
    throw new TrustRevisionError("storage_unavailable", "IndexedDB is unavailable in this context");
  }
  const factory = options.indexedDBFactory ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new TrustRevisionError("storage_unavailable", "IndexedDB is unavailable in this context");
  }
  return factory;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "accountId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new TrustRevisionError("storage_failure", "could not open store"));
  });
}

interface RevisionRecord {
  readonly accountId: string;
  readonly revision: number;
}

/** The highest bundle revision this device has accepted, or 0 if none. */
export async function readHighestSeenRevision(
  accountId: string,
  options: TrustRevisionStorageOptions = {},
): Promise<number> {
  const database = await openDatabase(resolveIndexedDB(options));
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(accountId);
      request.onsuccess = () => {
        const record = request.result as RevisionRecord | undefined;
        resolve(record !== undefined && Number.isInteger(record.revision) ? record.revision : 0);
      };
      request.onerror = () =>
        reject(request.error ?? new TrustRevisionError("storage_failure", "could not read floor"));
    });
  } finally {
    database.close();
  }
}

/**
 * Raise the stored floor to `revision` when it is higher; never lower it, so a
 * stale read can neither roll the floor back nor race it downward.
 */
export async function recordSeenRevision(
  accountId: string,
  revision: number,
  options: TrustRevisionStorageOptions = {},
): Promise<void> {
  if (!Number.isInteger(revision) || revision < 0) return;
  const database = await openDatabase(resolveIndexedDB(options));
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const current = store.get(accountId);
      current.onsuccess = () => {
        const seen = (current.result as RevisionRecord | undefined)?.revision ?? 0;
        if (revision > seen) store.put({ accountId, revision });
      };
      current.onerror = () =>
        reject(current.error ?? new TrustRevisionError("storage_failure", "could not read floor"));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new TrustRevisionError("storage_failure", "write aborted"));
      transaction.onerror = () =>
        reject(transaction.error ?? new TrustRevisionError("storage_failure", "write failed"));
    });
  } finally {
    database.close();
  }
}

/**
 * Refuse a freshly opened bundle if it is older than one already trusted here,
 * then raise the floor to it. Call this immediately after a bundle authenticates
 * and before acting on its contents.
 */
export async function enforceBundleFreshness(
  accountId: string,
  revision: number,
  options: TrustRevisionStorageOptions = {},
): Promise<void> {
  const floor = await readHighestSeenRevision(accountId, options);
  if (revision < floor) {
    throw new TrustRevisionError(
      "stale_bundle",
      `this trust bundle (revision ${revision}) is older than one this device already trusted ` +
        `(revision ${floor}); refusing it as a possible rollback`,
    );
  }
  await recordSeenRevision(accountId, revision, options);
}
