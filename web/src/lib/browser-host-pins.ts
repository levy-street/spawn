import { API_URL } from "./api";
import { ed25519PublicKeyFingerprint } from "./signed-signal";

export const BROWSER_HOST_PIN_DATABASE_NAME = "spawn-browser-host-pins";
export const BROWSER_HOST_PIN_STORE_NAME = "host-pins";
export const BROWSER_HOST_PIN_STORAGE_VERSION = 1;
export const BROWSER_HOST_PIN_MAX_RECORDS = 256;
export const BROWSER_HOST_PIN_MAX_HOST_IDS = 8;
export const BROWSER_HOST_PIN_MAX_ORIGIN_CHARS = 512;

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RECORD_KEYS = [
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
] as const;
const MAX_COMPARE_WRITE_RETRIES = 8;

export type BrowserHostPinState = "active" | "revoked";

export interface BrowserHostPin {
  readonly accountId: string;
  readonly approvedAtMs: number;
  readonly createdAtMs: number;
  readonly hostFingerprint: string;
  readonly hostIds: readonly string[];
  readonly hostPublicKey: string;
  readonly origin: string;
  readonly revokedAtMs: number | null;
  readonly state: BrowserHostPinState;
  readonly version: 1;
}

interface StoredBrowserHostPinV1 extends BrowserHostPin {
  readonly hostIds: string[];
  readonly recordId: string;
}

export interface BrowserHostPinStorageOptions {
  /** Test/isolation override. Pass null to require an unavailable-storage failure. */
  readonly indexedDBFactory?: IDBFactory | null;
  /** Test-only deterministic clock override. */
  readonly now?: () => number;
  /** Exact browser trust-epoch signal; abort prevents any not-yet-committed mutation. */
  readonly signal?: AbortSignal;
  /** Test-only deterministic boundary hook invoked after a durable transaction commits. */
  readonly testOnlyAfterDurableCommit?: () => void;
}

export type BrowserHostPinErrorCode =
  | "capacity_exceeded"
  | "concurrent_modification"
  | "corrupt_record"
  | "duplicate_conflict"
  | "fingerprint_mismatch"
  | "host_id_key_conflict"
  | "host_id_response_mismatch"
  | "invalid_account"
  | "invalid_host_id"
  | "invalid_key"
  | "invalid_origin"
  | "missing_pin"
  | "null_fingerprint"
  | "null_key"
  | "revoked_pin"
  | "storage_failure"
  | "storage_unavailable"
  | "trust_epoch_ended";

export class BrowserHostPinError extends Error {
  constructor(
    readonly code: BrowserHostPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserHostPinError";
  }
}

export class BrowserHostPinAbortError extends BrowserHostPinError {
  constructor(readonly durableMutation: boolean) {
    super(
      "trust_epoch_ended",
      durableMutation
        ? "browser trust ended after the local host-pin mutation committed"
        : "browser trust ended before the local host-pin mutation committed",
    );
    this.name = "AbortError";
  }
}

function assertNotAborted(signal: AbortSignal | undefined, durableMutation = false): void {
  if (signal?.aborted) throw new BrowserHostPinAbortError(durableMutation);
}

export interface ApproveBrowserHostPinInput {
  readonly accountId: string;
  readonly origin: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
}

export interface ResolveBrowserHostPinInput {
  readonly accountId: string;
  readonly origin: string;
  readonly hostId: string;
  readonly claimedHostPublicKey: string | null;
  readonly claimedHostFingerprint: string | null;
}

export interface RevokeBrowserHostPinInput {
  readonly accountId: string;
  /** Canonical Host ID taken only from the route and used by server DELETE. */
  readonly targetHostId: string;
  /** Host ID returned by the Host API response for the route. */
  readonly claimedHostId: string;
  readonly claimedHostPublicKey: string | null;
  readonly claimedHostFingerprint: string | null;
  readonly origin: string;
}

interface StrictIdentity {
  readonly hostFingerprint: string;
  readonly hostPublicKey: string;
}

function assertCanonicalUuid(value: string, field: "accountId" | "hostId"): void {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new BrowserHostPinError(
      field === "accountId" ? "invalid_account" : "invalid_host_id",
      `${field} must be an exact lowercase-hyphenated canonical UUID`,
    );
  }
}

export function assertCanonicalHostPinOrigin(value: string): void {
  if (typeof value !== "string" || value.length > BROWSER_HOST_PIN_MAX_ORIGIN_CHARS) {
    throw new BrowserHostPinError("invalid_origin", "origin must be a canonical HTTP(S) origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserHostPinError("invalid_origin", "origin must be a canonical HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new BrowserHostPinError(
      "invalid_origin",
      "origin must be its exact canonical HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
}

/** Resolve the REST server's canonical origin without persisting ambient page state. */
export function browserHostPinServerOrigin(): string {
  if (globalThis.location?.origin === undefined) {
    throw new BrowserHostPinError(
      "invalid_origin",
      "the browser/server origin is unavailable outside a browser page",
    );
  }
  let origin: string;
  try {
    origin = API_URL === "" ? globalThis.location.origin : new URL(API_URL, location.origin).origin;
  } catch {
    throw new BrowserHostPinError("invalid_origin", "the configured API origin is invalid");
  }
  assertCanonicalHostPinOrigin(origin);
  return origin;
}

function resolveIndexedDB(options: BrowserHostPinStorageOptions): IDBFactory {
  const factory = Object.hasOwn(options, "indexedDBFactory")
    ? options.indexedDBFactory
    : globalThis.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== "function") {
    throw new BrowserHostPinError(
      "storage_unavailable",
      "IndexedDB is unavailable; local host trust was not changed",
    );
  }
  return factory;
}

function checkedNow(options: BrowserHostPinStorageOptions): number {
  const value = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new BrowserHostPinError("storage_failure", "the local pin clock is invalid");
  }
  return value;
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
      // The abort event owns rejection and carries the final transaction error.
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
    // A transaction that already completed or aborted needs no second abort.
  }
  await completion.catch(() => undefined);
}

function storageFailure(message: string): BrowserHostPinError {
  return new BrowserHostPinError("storage_failure", message);
}

function hasExpectedDatabaseSchema(database: IDBDatabase): boolean {
  try {
    if (
      database.version !== BROWSER_HOST_PIN_STORAGE_VERSION ||
      database.objectStoreNames.length !== 1 ||
      database.objectStoreNames.item(0) !== BROWSER_HOST_PIN_STORE_NAME
    ) {
      return false;
    }
    const store = database
      .transaction(BROWSER_HOST_PIN_STORE_NAME, "readonly")
      .objectStore(BROWSER_HOST_PIN_STORE_NAME);
    return (
      store.keyPath === "recordId" && store.autoIncrement === false && store.indexNames.length === 0
    );
  } catch {
    return false;
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let upgradeError: BrowserHostPinError | undefined;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(BROWSER_HOST_PIN_DATABASE_NAME, BROWSER_HOST_PIN_STORAGE_VERSION);
    } catch {
      reject(
        new BrowserHostPinError(
          "storage_unavailable",
          "the local host-pin database could not be opened",
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
      if (event.oldVersion !== 0 || database.objectStoreNames.length !== 0) {
        upgradeError = new BrowserHostPinError(
          "corrupt_record",
          "unsupported local host-pin database schema or version",
        );
        request.transaction?.abort();
        return;
      }
      database.createObjectStore(BROWSER_HOST_PIN_STORE_NAME, { keyPath: "recordId" });
    };
    request.onerror = () => {
      const error = request.error;
      fail(
        upgradeError ??
          (error?.name === "VersionError"
            ? new BrowserHostPinError(
                "corrupt_record",
                "unsupported local host-pin database version",
              )
            : storageFailure("the local host-pin database open failed")),
      );
    };
    request.onblocked = () =>
      fail(
        new BrowserHostPinError(
          "storage_unavailable",
          "the local host-pin database open is blocked by another page",
        ),
      );
    request.onsuccess = () => {
      const database = request.result;
      if (finished) {
        database.close();
        return;
      }
      if (!hasExpectedDatabaseSchema(database)) {
        database.close();
        fail(
          new BrowserHostPinError(
            "corrupt_record",
            "the local host-pin object-store schema is invalid",
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

function recordId(accountId: string, origin: string, hostPublicKey: string): string {
  return JSON.stringify([accountId, origin, hostPublicKey]);
}

async function strictIdentity(
  hostPublicKey: string | null,
  hostFingerprint: string | null,
  signal?: AbortSignal,
): Promise<StrictIdentity> {
  assertNotAborted(signal);
  if (hostPublicKey === null) {
    throw new BrowserHostPinError("null_key", "the Host API did not provide a host public key");
  }
  if (hostFingerprint === null) {
    throw new BrowserHostPinError(
      "null_fingerprint",
      "the Host API did not provide a host fingerprint",
    );
  }
  let derived: string;
  try {
    derived = await ed25519PublicKeyFingerprint(hostPublicKey);
    assertNotAborted(signal);
  } catch {
    assertNotAborted(signal);
    throw new BrowserHostPinError("invalid_key", "the host public key is not strict Ed25519");
  }
  if (hostFingerprint !== derived) {
    throw new BrowserHostPinError(
      "fingerprint_mismatch",
      "the claimed host fingerprint does not match the locally derived public-key fingerprint",
    );
  }
  return { hostFingerprint: derived, hostPublicKey };
}

function assertTimestamp(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new BrowserHostPinError("corrupt_record", `stored ${field} is invalid`);
  }
}

async function validateStoredRecord(
  value: unknown,
  signal?: AbortSignal,
): Promise<StoredBrowserHostPinV1> {
  assertNotAborted(signal);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserHostPinError("corrupt_record", "stored host pin is not a record");
  }
  const record = value as Partial<StoredBrowserHostPinV1>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    RECORD_KEYS.some((key, index) => key !== keys[index]) ||
    record.version !== BROWSER_HOST_PIN_STORAGE_VERSION ||
    typeof record.accountId !== "string" ||
    typeof record.origin !== "string" ||
    typeof record.hostPublicKey !== "string" ||
    typeof record.hostFingerprint !== "string" ||
    typeof record.recordId !== "string" ||
    !Array.isArray(record.hostIds) ||
    (record.state !== "active" && record.state !== "revoked")
  ) {
    throw new BrowserHostPinError(
      "corrupt_record",
      "stored host pin has an invalid shape, field, state, or version",
    );
  }

  try {
    assertCanonicalUuid(record.accountId, "accountId");
    assertCanonicalHostPinOrigin(record.origin);
  } catch {
    throw new BrowserHostPinError(
      "corrupt_record",
      "stored host pin has a noncanonical account or origin",
    );
  }
  assertTimestamp(record.createdAtMs, "creation time");
  assertTimestamp(record.approvedAtMs, "approval time");
  if (record.approvedAtMs < record.createdAtMs) {
    throw new BrowserHostPinError("corrupt_record", "stored approval predates pin creation");
  }
  if (record.state === "active") {
    if (record.revokedAtMs !== null) {
      throw new BrowserHostPinError("corrupt_record", "active stored host pin is revoked");
    }
  } else {
    assertTimestamp(record.revokedAtMs, "revocation time");
    if (record.revokedAtMs < record.approvedAtMs) {
      throw new BrowserHostPinError("corrupt_record", "stored revocation predates approval");
    }
  }

  if (record.hostIds.length > BROWSER_HOST_PIN_MAX_HOST_IDS) {
    throw new BrowserHostPinError("corrupt_record", "stored host pin has too many Host IDs");
  }
  const sortedHostIds = [...record.hostIds].sort();
  for (let index = 0; index < record.hostIds.length; index += 1) {
    const hostId = record.hostIds[index];
    try {
      assertCanonicalUuid(hostId, "hostId");
    } catch {
      throw new BrowserHostPinError("corrupt_record", "stored host pin has an invalid Host ID");
    }
    if (hostId !== sortedHostIds[index] || (index > 0 && hostId === record.hostIds[index - 1])) {
      throw new BrowserHostPinError(
        "corrupt_record",
        "stored Host IDs must be unique and canonically ordered",
      );
    }
  }
  if (record.recordId !== recordId(record.accountId, record.origin, record.hostPublicKey)) {
    throw new BrowserHostPinError(
      "corrupt_record",
      "stored host pin identity does not match its primary key",
    );
  }
  let identity: StrictIdentity;
  try {
    identity = await strictIdentity(record.hostPublicKey, record.hostFingerprint, signal);
    assertNotAborted(signal);
  } catch {
    assertNotAborted(signal);
    throw new BrowserHostPinError(
      "corrupt_record",
      "stored host pin failed strict key and local fingerprint validation",
    );
  }
  if (
    identity.hostPublicKey !== record.hostPublicKey ||
    identity.hostFingerprint !== record.hostFingerprint
  ) {
    throw new BrowserHostPinError("corrupt_record", "stored host identity is inconsistent");
  }
  return record as StoredBrowserHostPinV1;
}

function assertNoConflicts(records: readonly StoredBrowserHostPinV1[]): void {
  const recordIds = new Set<string>();
  const boundHostIds = new Map<string, string>();
  for (const record of records) {
    if (recordIds.has(record.recordId)) {
      throw new BrowserHostPinError("duplicate_conflict", "duplicate local host-pin identity");
    }
    recordIds.add(record.recordId);
    for (const hostId of record.hostIds) {
      const scopedHostId = JSON.stringify([record.accountId, record.origin, hostId]);
      const existing = boundHostIds.get(scopedHostId);
      if (existing !== undefined && existing !== record.recordId) {
        throw new BrowserHostPinError(
          "duplicate_conflict",
          "one scoped Host ID is bound to conflicting local keys",
        );
      }
      boundHostIds.set(scopedHostId, record.recordId);
    }
  }
}

async function readRawRecords(database: IDBDatabase, signal?: AbortSignal): Promise<unknown[]> {
  assertNotAborted(signal);
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readonly");
  } catch {
    throw storageFailure("the local host-pin read transaction could not start");
  }
  const onAbort = () => {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be complete.
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const completion = transactionResult(transaction);
  try {
    const store = transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
    assertNotAborted(signal);
    const count = await requestResult(store.count());
    assertNotAborted(signal);
    if (count > BROWSER_HOST_PIN_MAX_RECORDS) {
      await completion;
      assertNotAborted(signal);
      throw new BrowserHostPinError(
        "capacity_exceeded",
        `local host-pin storage exceeds its ${BROWSER_HOST_PIN_MAX_RECORDS}-record limit`,
      );
    }
    const values = await requestResult(store.getAll());
    assertNotAborted(signal);
    await completion;
    assertNotAborted(signal);
    return values;
  } catch (error) {
    await completion.catch(() => undefined);
    assertNotAborted(signal);
    if (error instanceof BrowserHostPinError) throw error;
    throw storageFailure("the local host-pin read failed");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readValidatedRecords(
  database: IDBDatabase,
  signal?: AbortSignal,
): Promise<StoredBrowserHostPinV1[]> {
  assertNotAborted(signal);
  const raw = await readRawRecords(database, signal);
  assertNotAborted(signal);
  const records = await Promise.all(raw.map((record) => validateStoredRecord(record, signal)));
  assertNotAborted(signal);
  assertNoConflicts(records);
  return records;
}

function snapshot(records: readonly StoredBrowserHostPinV1[]): string {
  return JSON.stringify(records);
}

const RETRY_COMPARE_WRITE = Symbol("retry-compare-write");

async function compareAndWrite<T>(
  database: IDBDatabase,
  mutate: (records: readonly StoredBrowserHostPinV1[]) => {
    readonly nextRecord?: StoredBrowserHostPinV1;
    readonly result: T;
  },
  options: BrowserHostPinStorageOptions,
): Promise<T> {
  const { signal } = options;
  for (let attempt = 0; attempt < MAX_COMPARE_WRITE_RETRIES; attempt += 1) {
    // Strict key/fingerprint derivation happens outside the write transaction.
    // The write transaction then compares this validated snapshot byte-for-byte
    // before making one synchronous state transition.
    assertNotAborted(signal);
    const validated = await readValidatedRecords(database, signal);
    assertNotAborted(signal);
    const expectedSnapshot = snapshot(validated);
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readwrite");
    } catch {
      throw storageFailure("the local host-pin write transaction could not start");
    }
    const onAbort = () => {
      try {
        transaction.abort();
      } catch {
        // A committed transaction leaves durable state which is reported below.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const completion = transactionResult(transaction);
    let durableMutation = false;
    try {
      const store = transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
      assertNotAborted(signal);
      const currentCount = await requestResult(store.count());
      assertNotAborted(signal);
      if (currentCount > BROWSER_HOST_PIN_MAX_RECORDS) {
        const error = new BrowserHostPinError(
          "capacity_exceeded",
          `local host-pin storage exceeds its ${BROWSER_HOST_PIN_MAX_RECORDS}-record limit`,
        );
        await abortTransaction(transaction, completion);
        throw error;
      }
      const current = (await requestResult(store.getAll())) as StoredBrowserHostPinV1[];
      assertNotAborted(signal);
      if (snapshot(current) !== expectedSnapshot) {
        await abortTransaction(transaction, completion);
        throw RETRY_COMPARE_WRITE;
      }
      assertNotAborted(signal);
      const transition = mutate(validated);
      if (transition.nextRecord !== undefined) {
        // Last reversible boundary: aborting before transaction completion
        // cancels this queued durable write.
        assertNotAborted(signal);
        await requestResult(store.put(transition.nextRecord));
        assertNotAborted(signal);
      }
      await completion;
      durableMutation = transition.nextRecord !== undefined;
      if (durableMutation) options.testOnlyAfterDurableCommit?.();
      assertNotAborted(signal, durableMutation);
      return transition.result;
    } catch (error) {
      await completion.catch(() => undefined);
      assertNotAborted(signal, durableMutation);
      if (error === RETRY_COMPARE_WRITE) continue;
      if (error instanceof BrowserHostPinError) throw error;
      throw storageFailure("the local host-pin write failed");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new BrowserHostPinError(
    "concurrent_modification",
    "local host-pin storage changed repeatedly in another page; retry explicitly",
  );
}

function publicPin(record: StoredBrowserHostPinV1): BrowserHostPin {
  return Object.freeze({
    accountId: record.accountId,
    approvedAtMs: record.approvedAtMs,
    createdAtMs: record.createdAtMs,
    hostFingerprint: record.hostFingerprint,
    hostIds: Object.freeze([...record.hostIds]),
    hostPublicKey: record.hostPublicKey,
    origin: record.origin,
    revokedAtMs: record.revokedAtMs,
    state: record.state,
    version: record.version,
  });
}

function recordsInScope(
  records: readonly StoredBrowserHostPinV1[],
  accountId: string,
  origin: string,
): readonly StoredBrowserHostPinV1[] {
  return records.filter((record) => record.accountId === accountId && record.origin === origin);
}

function assertScope(accountId: string, origin: string): void {
  assertCanonicalUuid(accountId, "accountId");
  assertCanonicalHostPinOrigin(origin);
}

/**
 * Persist the exact locally fingerprinted key before any server approval call.
 * This is the only operation allowed to reactivate an exact revoked key, and
 * callers must invoke it only from a fresh explicit user-confirmed ceremony.
 */
export async function approveBrowserHostPin(
  input: ApproveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin> {
  assertNotAborted(options.signal);
  assertScope(input.accountId, input.origin);
  const identity = await strictIdentity(input.hostPublicKey, input.hostFingerprint, options.signal);
  assertNotAborted(options.signal);
  const factory = resolveIndexedDB(options);
  assertNotAborted(options.signal);
  const database = await openDatabase(factory);
  try {
    assertNotAborted(options.signal);
    const pin = await compareAndWrite(
      database,
      (records) => {
        const existing = recordsInScope(records, input.accountId, input.origin).find(
          (record) => record.hostPublicKey === identity.hostPublicKey,
        );
        if (existing?.state === "active") return { result: publicPin(existing) };

        const now = checkedNow(options);
        if (existing !== undefined) {
          const reactivated: StoredBrowserHostPinV1 = {
            ...existing,
            approvedAtMs: Math.max(now, existing.approvedAtMs, existing.revokedAtMs ?? 0),
            revokedAtMs: null,
            state: "active",
          };
          return { nextRecord: reactivated, result: publicPin(reactivated) };
        }
        if (records.length >= BROWSER_HOST_PIN_MAX_RECORDS) {
          throw new BrowserHostPinError(
            "capacity_exceeded",
            `local host-pin storage is limited to ${BROWSER_HOST_PIN_MAX_RECORDS} records including tombstones`,
          );
        }
        const created: StoredBrowserHostPinV1 = {
          accountId: input.accountId,
          approvedAtMs: now,
          createdAtMs: now,
          hostFingerprint: identity.hostFingerprint,
          hostIds: [],
          hostPublicKey: identity.hostPublicKey,
          origin: input.origin,
          recordId: recordId(input.accountId, input.origin, identity.hostPublicKey),
          revokedAtMs: null,
          state: "active",
          version: BROWSER_HOST_PIN_STORAGE_VERSION,
        };
        return { nextRecord: created, result: publicPin(created) };
      },
      options,
    );
    assertNotAborted(options.signal);
    return pin;
  } finally {
    database.close();
  }
}

/**
 * Resolve and bind routing metadata only after an exact active local key pin
 * matches. This never creates key trust, never reactivates, and never accepts a
 * Host API fingerprint as authority.
 */
export async function resolveActiveBrowserHostPin(
  input: ResolveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<string> {
  return (await resolveActiveBrowserHostPinMaterial(input, options)).hostPublicKey;
}

/** Resolve the complete exact local destination identity for capability construction. */
export async function resolveActiveBrowserHostPinMaterial(
  input: ResolveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin> {
  assertNotAborted(options.signal);
  assertScope(input.accountId, input.origin);
  assertCanonicalUuid(input.hostId, "hostId");
  const identity = await strictIdentity(
    input.claimedHostPublicKey,
    input.claimedHostFingerprint,
    options.signal,
  );
  assertNotAborted(options.signal);
  const factory = resolveIndexedDB(options);
  assertNotAborted(options.signal);
  const database = await openDatabase(factory);
  try {
    assertNotAborted(options.signal);
    const pin = await compareAndWrite(
      database,
      (records) => {
        const scoped = recordsInScope(records, input.accountId, input.origin);
        const bound = scoped.find((record) => record.hostIds.includes(input.hostId));
        if (bound !== undefined && bound.hostPublicKey !== identity.hostPublicKey) {
          throw new BrowserHostPinError(
            "host_id_key_conflict",
            "this Host ID is already bound to a different local key; explicit re-pair/rotation is required",
          );
        }
        const exact = scoped.find((record) => record.hostPublicKey === identity.hostPublicKey);
        if (exact === undefined) {
          throw new BrowserHostPinError(
            "missing_pin",
            "no locally approved host pin matches this Host API identity",
          );
        }
        if (exact.state === "revoked") {
          throw new BrowserHostPinError(
            "revoked_pin",
            "the matching local host pin is revoked; a fresh explicit approval is required",
          );
        }
        if (bound !== undefined) return { result: publicPin(exact) };
        if (exact.hostIds.length >= BROWSER_HOST_PIN_MAX_HOST_IDS) {
          throw new BrowserHostPinError(
            "capacity_exceeded",
            `one local key may observe at most ${BROWSER_HOST_PIN_MAX_HOST_IDS} Host IDs`,
          );
        }
        const boundExact: StoredBrowserHostPinV1 = {
          ...exact,
          hostIds: [...exact.hostIds, input.hostId].sort(),
        };
        return { nextRecord: boundExact, result: publicPin(boundExact) };
      },
      options,
    );
    assertNotAborted(options.signal);
    return pin;
  } finally {
    database.close();
  }
}

/**
 * Write an exact retained local tombstone before attempting server deletion.
 *
 * Deletion is intentionally not a Host-ID discovery/binding flow. The route
 * target, Host response, and a binding established by an earlier explicit
 * resolver call must already agree exactly. A revoked exact binding remains
 * idempotently retryable after a server DELETE failure.
 */
export async function revokeBrowserHostPin(
  input: RevokeBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin> {
  assertNotAborted(options.signal);
  assertScope(input.accountId, input.origin);
  assertCanonicalUuid(input.targetHostId, "hostId");
  assertCanonicalUuid(input.claimedHostId, "hostId");
  if (input.claimedHostId !== input.targetHostId) {
    throw new BrowserHostPinError(
      "host_id_response_mismatch",
      "the Host API response ID does not exactly match the route and DELETE target",
    );
  }
  const identity = await strictIdentity(
    input.claimedHostPublicKey,
    input.claimedHostFingerprint,
    options.signal,
  );
  assertNotAborted(options.signal);
  const factory = resolveIndexedDB(options);
  assertNotAborted(options.signal);
  const database = await openDatabase(factory);
  try {
    assertNotAborted(options.signal);
    const pin = await compareAndWrite(
      database,
      (records) => {
        const scoped = recordsInScope(records, input.accountId, input.origin);
        const bound = scoped.find((record) => record.hostIds.includes(input.targetHostId));
        if (bound === undefined) {
          throw new BrowserHostPinError(
            "missing_pin",
            "server deletion requires an existing exact local Host-ID-to-key binding",
          );
        }
        if (bound.hostPublicKey !== identity.hostPublicKey) {
          throw new BrowserHostPinError(
            "host_id_key_conflict",
            "this Host ID is bound to a different local key; deletion was blocked",
          );
        }
        if (bound.state === "revoked") return { result: publicPin(bound) };
        const now = checkedNow(options);
        const revoked: StoredBrowserHostPinV1 = {
          ...bound,
          revokedAtMs: Math.max(now, bound.approvedAtMs),
          state: "revoked",
        };
        return { nextRecord: revoked, result: publicPin(revoked) };
      },
      options,
    );
    assertNotAborted(options.signal);
    return pin;
  } finally {
    database.close();
  }
}

/** Read one exact scoped pin for recovery UI without creating or changing trust. */
export async function loadBrowserHostPin(
  input: ApproveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin | null> {
  assertNotAborted(options.signal);
  assertScope(input.accountId, input.origin);
  const identity = await strictIdentity(input.hostPublicKey, input.hostFingerprint, options.signal);
  assertNotAborted(options.signal);
  const factory = resolveIndexedDB(options);
  assertNotAborted(options.signal);
  const database = await openDatabase(factory);
  try {
    assertNotAborted(options.signal);
    const records = await readValidatedRecords(database, options.signal);
    assertNotAborted(options.signal);
    const exact = recordsInScope(records, input.accountId, input.origin).find(
      (record) => record.hostPublicKey === identity.hostPublicKey,
    );
    return exact === undefined ? null : publicPin(exact);
  } finally {
    database.close();
  }
}
