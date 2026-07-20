/**
 * Does this browser actually persist what the trust model requires?
 *
 * The browser device identity is stored as live non-extractable `CryptoKey`
 * objects in IndexedDB. That relies on structured-cloning them, which is not
 * uniformly supported: WebKit has stored ECDSA keys for years but Ed25519 in
 * WebCrypto is far newer, and a browser that silently fails to persist the
 * record mints a fresh identity on every page load. Such a device can never be
 * pinned by anything, so signed signaling can never work there -- and the
 * failure is invisible without a check like this.
 *
 * Diagnostic only. Nothing here changes stored state beyond its own scratch
 * database, which it deletes.
 */

const PROBE_DATABASE = "spawn-storage-probe";
const PROBE_STORE = "probe";

export interface StoragePersistenceReport {
  /** IndexedDB exists and a plain value survives a fresh transaction. */
  readonly plainValuePersists: boolean;
  /** A non-extractable Ed25519 private key survives a round-trip. */
  readonly ed25519KeyPersists: boolean;
  /** An ECDSA P-256 key survives -- the fallback algorithm's viability. */
  readonly ecdsaKeyPersists: boolean;
  /** Whichever step failed first, verbatim, for reporting. */
  readonly failure: string | null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openProbe(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(PROBE_DATABASE, 1);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(PROBE_STORE)) {
        database.createObjectStore(PROBE_STORE);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
  });
}

async function roundTrips(database: IDBDatabase, key: string, value: unknown): Promise<boolean> {
  // Separate transactions on purpose: a value that only survives inside the
  // writing transaction has not actually persisted.
  const write = database.transaction(PROBE_STORE, "readwrite");
  await request(write.objectStore(PROBE_STORE).put(value as never, key));
  await new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve();
    write.onerror = () => reject(write.error ?? new Error("write transaction failed"));
    write.onabort = () => reject(write.error ?? new Error("write transaction aborted"));
  });

  const read = database.transaction(PROBE_STORE, "readonly");
  const stored = await request(read.objectStore(PROBE_STORE).get(key));
  return stored !== undefined && stored !== null;
}

export async function probeStoragePersistence(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<StoragePersistenceReport> {
  let plainValuePersists = false;
  let ed25519KeyPersists = false;
  let ecdsaKeyPersists = false;
  let failure: string | null = null;

  if (factory === undefined || typeof factory.open !== "function") {
    return {
      plainValuePersists,
      ed25519KeyPersists,
      ecdsaKeyPersists,
      failure: "IndexedDB is unavailable in this context",
    };
  }

  let database: IDBDatabase | null = null;
  try {
    database = await openProbe(factory);
    plainValuePersists = await roundTrips(database, "plain", { ok: true });

    try {
      const ed = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      ed25519KeyPersists = await roundTrips(database, "ed25519", ed.privateKey);
    } catch (error) {
      failure ??= `Ed25519 key did not persist: ${String(error)}`;
    }

    try {
      const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]);
      ecdsaKeyPersists = await roundTrips(database, "ecdsa", ec.privateKey);
    } catch (error) {
      failure ??= `ECDSA key did not persist: ${String(error)}`;
    }
  } catch (error) {
    failure ??= String(error);
  } finally {
    database?.close();
    try {
      factory.deleteDatabase(PROBE_DATABASE);
    } catch {
      // Leaving a scratch database behind is not worth failing a diagnostic for.
    }
  }

  return { plainValuePersists, ed25519KeyPersists, ecdsaKeyPersists, failure };
}
