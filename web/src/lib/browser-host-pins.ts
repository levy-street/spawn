import { API_URL } from "./api";
import { ed25519PublicKeyFingerprint } from "./signed-signal";

export const BROWSER_HOST_PIN_DATABASE_NAME = "spawn-browser-host-pins";
export const BROWSER_HOST_PIN_STORE_NAME = "host-pins";
export const BROWSER_HOST_PIN_STORAGE_VERSION = 1;
/** Active approvals and permanent removal records have independent budgets:
 * accumulated history can never consume the space needed for a live host. */
export const BROWSER_HOST_PIN_MAX_RECORDS = 256;
export const BROWSER_HOST_PIN_MAX_TOMBSTONES = 256;
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
  | "storage_unavailable";

export class BrowserHostPinError extends Error {
  constructor(
    readonly code: BrowserHostPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserHostPinError";
  }
}

export interface ApproveBrowserHostPinInput {
  readonly accountId: string;
  readonly origin: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
  /**
   * Host IDs already known to map to this key (e.g. carried in a trust bundle).
   * Seeding them means the signed-RTC downgrade check can recognise this host by
   * ID immediately, instead of only after a first successful signed resolve —
   * without which a server can hold a freshly imported host on the raw path by
   * simply never presenting the key. Omit for a pure key approval.
   */
  readonly hostIds?: readonly string[];
  /**
   * Whether this approval may resurrect an exact revoked tombstone (default
   * true — the hand-run possession ceremony's documented power). Introduction-
   * driven callers (ceremony handover, continuous gossip) MUST pass false: a
   * tombstone is the operator's targeted "removed here" statement, and a peer's
   * broadcast row re-vouching the dead key must not quietly undo it — which
   * would also re-wedge the re-key path by re-activating the stale binding.
   */
  readonly reactivateRevoked?: boolean;
}

export interface ResolveBrowserHostPinInput {
  readonly accountId: string;
  readonly origin: string;
  readonly hostId: string;
  /** As claimed by the (untrusted) server Host API. Its fingerprint is always
   * derived locally from this key (mesh B5) — never accepted as input. */
  readonly claimedHostPublicKey: string | null;
}

export interface RevokeBrowserHostPinInput {
  readonly accountId: string;
  /** Canonical Host ID taken only from the route and used by server DELETE. */
  readonly targetHostId: string;
  /** Host ID returned by the Host API response for the route. */
  readonly claimedHostId: string;
  /** As claimed by the (untrusted) server Host API. Its fingerprint is always
   * derived locally from this key (mesh B5) — never accepted as input. */
  readonly claimedHostPublicKey: string | null;
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

/**
 * The identity a server-CLAIMED key resolves to. The fingerprint is always
 * derived locally from the key (mesh B5): the server no longer serves one next
 * to a key, and this module would not accept it as input if it did — a claimed
 * fingerprint could otherwise become the comparison value a substituted key
 * hides behind.
 */
async function claimedIdentity(hostPublicKey: string | null): Promise<StrictIdentity> {
  if (hostPublicKey === null) {
    throw new BrowserHostPinError("null_key", "the Host API did not provide a host public key");
  }
  let derived: string;
  try {
    derived = await ed25519PublicKeyFingerprint(hostPublicKey);
  } catch {
    throw new BrowserHostPinError("invalid_key", "the host public key is not strict Ed25519");
  }
  return { hostFingerprint: derived, hostPublicKey };
}

async function strictIdentity(
  hostPublicKey: string | null,
  hostFingerprint: string | null,
): Promise<StrictIdentity> {
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
  } catch {
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

async function validateStoredRecord(value: unknown): Promise<StoredBrowserHostPinV1> {
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
    identity = await strictIdentity(record.hostPublicKey, record.hostFingerprint);
  } catch {
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

async function readRawRecords(database: IDBDatabase): Promise<unknown[]> {
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readonly");
  } catch {
    throw storageFailure("the local host-pin read transaction could not start");
  }
  const completion = transactionResult(transaction);
  try {
    const store = transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
    const count = await requestResult(store.count());
    const maxStoredRecords = BROWSER_HOST_PIN_MAX_RECORDS + BROWSER_HOST_PIN_MAX_TOMBSTONES;
    if (count > maxStoredRecords) {
      await completion;
      throw new BrowserHostPinError(
        "capacity_exceeded",
        `local host-pin storage exceeds its separate active and tombstone limits`,
      );
    }
    const values = await requestResult(store.getAll());
    await completion;
    return values;
  } catch (error) {
    await completion.catch(() => undefined);
    if (error instanceof BrowserHostPinError) throw error;
    throw storageFailure("the local host-pin read failed");
  }
}

async function readValidatedRecords(database: IDBDatabase): Promise<StoredBrowserHostPinV1[]> {
  const raw = await readRawRecords(database);
  const records = await Promise.all(raw.map(validateStoredRecord));
  if (records.filter((record) => record.state === "active").length > BROWSER_HOST_PIN_MAX_RECORDS) {
    throw new BrowserHostPinError(
      "capacity_exceeded",
      `local host-pin storage exceeds its ${BROWSER_HOST_PIN_MAX_RECORDS}-active-record limit`,
    );
  }
  if (
    records.filter((record) => record.state === "revoked").length > BROWSER_HOST_PIN_MAX_TOMBSTONES
  ) {
    throw new BrowserHostPinError(
      "capacity_exceeded",
      `local host-pin storage exceeds its ${BROWSER_HOST_PIN_MAX_TOMBSTONES}-tombstone limit`,
    );
  }
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
    /** Additional records written in the SAME transaction (e.g. a routing
     * binding migrating between two records must move atomically). */
    readonly nextRecords?: readonly StoredBrowserHostPinV1[];
    /** Records to DELETE outright (device-local forget). Applied before any put. */
    readonly removeRecordIds?: readonly string[];
    readonly result: T;
  },
): Promise<T> {
  for (let attempt = 0; attempt < MAX_COMPARE_WRITE_RETRIES; attempt += 1) {
    // Strict key/fingerprint derivation happens outside the write transaction.
    // The write transaction then compares this validated snapshot byte-for-byte
    // before making one synchronous state transition.
    const validated = await readValidatedRecords(database);
    const expectedSnapshot = snapshot(validated);
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(BROWSER_HOST_PIN_STORE_NAME, "readwrite");
    } catch {
      throw storageFailure("the local host-pin write transaction could not start");
    }
    const completion = transactionResult(transaction);
    try {
      const store = transaction.objectStore(BROWSER_HOST_PIN_STORE_NAME);
      const currentCount = await requestResult(store.count());
      if (currentCount > BROWSER_HOST_PIN_MAX_RECORDS + BROWSER_HOST_PIN_MAX_TOMBSTONES) {
        const error = new BrowserHostPinError(
          "capacity_exceeded",
          "local host-pin storage exceeds its separate active and tombstone limits",
        );
        await abortTransaction(transaction, completion);
        throw error;
      }
      const current = (await requestResult(store.getAll())) as StoredBrowserHostPinV1[];
      if (snapshot(current) !== expectedSnapshot) {
        await abortTransaction(transaction, completion);
        throw RETRY_COMPARE_WRITE;
      }
      const transition = mutate(validated);
      for (const id of transition.removeRecordIds ?? []) {
        await requestResult(store.delete(id));
      }
      if (transition.nextRecord !== undefined) {
        await requestResult(store.put(transition.nextRecord));
      }
      for (const record of transition.nextRecords ?? []) {
        await requestResult(store.put(record));
      }
      await completion;
      return transition.result;
    } catch (error) {
      await completion.catch(() => undefined);
      if (error === RETRY_COMPARE_WRITE) continue;
      if (error instanceof BrowserHostPinError) throw error;
      throw storageFailure("the local host-pin write failed");
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
 * Validate and bound Host IDs seeded onto a pin at approval time. Malformed IDs
 * are skipped rather than fatal, so one bad entry in an imported bundle cannot
 * break an otherwise-valid import; the count is capped to the same limit the
 * store enforces on read.
 */
function normalizeSeedHostIds(hostIds: readonly string[] | undefined): string[] {
  if (hostIds === undefined || hostIds.length === 0) return [];
  const valid = [...new Set(hostIds)]
    .filter((id) => typeof id === "string" && CANONICAL_UUID_PATTERN.test(id))
    .sort();
  return valid.slice(0, BROWSER_HOST_PIN_MAX_HOST_IDS);
}

/** Union seed IDs into an existing set. At capacity an existing binding is
 *  evicted to admit the new one: hostIds are routing metadata that re-binds
 *  on the next successful key-matching resolve, while refusing (or dropping
 *  the newest) turns re-pair churn into a permanent stale set — and, under
 *  signed-RTC enforcement, a hard lockout. */
function mergeHostIds(existing: readonly string[], seed: readonly string[]): string[] {
  const merged = [...existing];
  for (const id of seed) {
    if (merged.includes(id)) continue;
    if (merged.length >= BROWSER_HOST_PIN_MAX_HOST_IDS) merged.shift();
    merged.push(id);
  }
  return merged.sort();
}

/**
 * Persist the exact locally fingerprinted key before any server approval call.
 * This is the only operation allowed to reactivate an exact revoked key, and
 * callers must invoke it only from a fresh explicit user-confirmed ceremony.
 */
/**
 * A monotonic counter that moves whenever this page changes local host trust.
 *
 * Trust lives in IndexedDB, which announces nothing. A surface that refused to
 * connect because no pin matched has no way to learn that the operator has
 * since re-possessed the host — so it stays dead while the copy on screen tells
 * the reader that re-possessing will bring it back. Callers subscribe to this
 * and re-run their trust decision when it moves. Reconfirming an unchanged pin
 * notifies with changed=false so refused roots can recover from device approval
 * without restarting healthy or already-recovering roots.
 *
 * Deliberately page-local: it reports what *this* page did, which is the case
 * the warm terminal pool keeps mounted across navigation. Another tab's
 * approval is not observed here, and reloading still picks it up.
 */
let hostPinRevision = 0;
const hostPinListeners = new Set<(changed: boolean) => void>();

export function getBrowserHostPinRevision(): number {
  return hostPinRevision;
}

export function subscribeToBrowserHostPinChanges(listener: (changed: boolean) => void): () => void {
  hostPinListeners.add(listener);
  return () => {
    hostPinListeners.delete(listener);
  };
}

function announceBrowserHostPinChange(changed = true): void {
  if (changed) hostPinRevision += 1;
  for (const listener of [...hostPinListeners]) {
    try {
      listener(changed);
    } catch {
      // A bad subscriber must not stop the others from hearing about it.
    }
  }
}

export async function approveBrowserHostPin(
  input: ApproveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin> {
  assertScope(input.accountId, input.origin);
  const identity = await strictIdentity(input.hostPublicKey, input.hostFingerprint);
  const seedHostIds = normalizeSeedHostIds(input.hostIds);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const approved = await compareAndWrite(database, (records) => {
      const existing = recordsInScope(records, input.accountId, input.origin).find(
        (record) => record.hostPublicKey === identity.hostPublicKey,
      );
      if (existing?.state === "active") {
        const merged = mergeHostIds(existing.hostIds, seedHostIds);
        if (
          merged.length === existing.hostIds.length &&
          merged.every((id, index) => id === existing.hostIds[index])
        )
          return { result: { pin: publicPin(existing), changed: false } };
        const updated: StoredBrowserHostPinV1 = { ...existing, hostIds: merged };
        return { nextRecord: updated, result: { pin: publicPin(updated), changed: true } };
      }

      const now = checkedNow(options);
      if (existing !== undefined) {
        if (input.reactivateRevoked === false) {
          throw new BrowserHostPinError(
            "revoked_pin",
            "this host key was removed on this device; only a fresh explicit ceremony reactivates it",
          );
        }
        if (
          records.filter((record) => record.state === "active").length >=
          BROWSER_HOST_PIN_MAX_RECORDS
        ) {
          throw new BrowserHostPinError(
            "capacity_exceeded",
            `local host-pin storage is limited to ${BROWSER_HOST_PIN_MAX_RECORDS} active records`,
          );
        }
        const reactivated: StoredBrowserHostPinV1 = {
          ...existing,
          approvedAtMs: Math.max(now, existing.approvedAtMs, existing.revokedAtMs ?? 0),
          hostIds: mergeHostIds(existing.hostIds, seedHostIds),
          revokedAtMs: null,
          state: "active",
        };
        return { nextRecord: reactivated, result: { pin: publicPin(reactivated), changed: true } };
      }
      if (
        records.filter((record) => record.state === "active").length >= BROWSER_HOST_PIN_MAX_RECORDS
      ) {
        throw new BrowserHostPinError(
          "capacity_exceeded",
          `local host-pin storage is limited to ${BROWSER_HOST_PIN_MAX_RECORDS} active records`,
        );
      }
      const created: StoredBrowserHostPinV1 = {
        accountId: input.accountId,
        approvedAtMs: now,
        createdAtMs: now,
        hostFingerprint: identity.hostFingerprint,
        hostIds: seedHostIds,
        hostPublicKey: identity.hostPublicKey,
        origin: input.origin,
        recordId: recordId(input.accountId, input.origin, identity.hostPublicKey),
        revokedAtMs: null,
        state: "active",
        version: BROWSER_HOST_PIN_STORAGE_VERSION,
      };
      return { nextRecord: created, result: { pin: publicPin(created), changed: true } };
    });
    // Reconfirmed trust can unblock a refused connection after device approval,
    // but must not retire healthy connections when workspace gossip repeats.
    announceBrowserHostPinChange(approved.changed);
    return approved.pin;
  } finally {
    database.close();
  }
}

/**
 * Resolve and bind routing metadata only after an exact active local key pin
 * matches. This never creates key trust, never reactivates, and never consults
 * a Host API fingerprint — identity is the claimed key, locally fingerprinted.
 */
export async function resolveActiveBrowserHostPin(
  input: ResolveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<string> {
  assertScope(input.accountId, input.origin);
  assertCanonicalUuid(input.hostId, "hostId");
  const identity = await claimedIdentity(input.claimedHostPublicKey);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    return await compareAndWrite(database, (records) => {
      const scoped = recordsInScope(records, input.accountId, input.origin);
      const bound = scoped.find((record) => record.hostIds.includes(input.hostId));
      if (bound !== undefined && bound.hostPublicKey !== identity.hostPublicKey) {
        // Re-key un-wedge (review R-b): a binding held by a REVOKED record is
        // routing metadata on trust the operator already withdrew here. When
        // the claimed key is separately held as an ACTIVE pin — which only an
        // explicit fresh ceremony or a firsthand-verified introduction can
        // create — the legitimate remove-then-possess-again cycle is exactly
        // what happened, and the binding migrates atomically to the approved
        // key instead of conflicting forever. Deny-only is preserved: an
        // ACTIVE old binding still hard-conflicts (the substitution signal),
        // and a claimed key with no active pin still conflicts (a tombstoned
        // hostId never re-binds on the server's say-so alone).
        const activeExact = scoped.find(
          (record) => record.hostPublicKey === identity.hostPublicKey && record.state === "active",
        );
        if (bound.state === "revoked" && activeExact !== undefined) {
          const unbound: StoredBrowserHostPinV1 = {
            ...bound,
            hostIds: bound.hostIds.filter((id) => id !== input.hostId),
          };
          const rebound: StoredBrowserHostPinV1 = {
            ...activeExact,
            hostIds: mergeHostIds(activeExact.hostIds, [input.hostId]),
          };
          return { nextRecords: [unbound, rebound], result: rebound.hostPublicKey };
        }
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
      if (bound !== undefined) return { result: exact.hostPublicKey };
      const boundExact: StoredBrowserHostPinV1 = {
        ...exact,
        // Same eviction-at-capacity policy as mergeHostIds: a binding is
        // recoverable routing metadata, but refusing here would surface as
        // pin_storage_error — a hard refusal with no raw fallback once
        // signed-RTC enforcement is on.
        hostIds: mergeHostIds(exact.hostIds, [input.hostId]),
      };
      return { nextRecord: boundExact, result: boundExact.hostPublicKey };
    });
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
 *
 * The record revoked is the BOUND one — the local truth for this Host ID —
 * even when the server now claims a different key (review R-b): removal is
 * the explicit user intent to withdraw trust for exactly this host, it is
 * deny-only (a tombstone can grant nothing), and blocking it would wedge the
 * legitimate re-keyed-host cycle at its only safe exit (remove here, possess
 * again from the terminal). The claimed key is still strictly validated, but
 * it decides nothing about WHICH trust dies.
 */
export async function revokeBrowserHostPin(
  input: RevokeBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin> {
  assertScope(input.accountId, input.origin);
  assertCanonicalUuid(input.targetHostId, "hostId");
  assertCanonicalUuid(input.claimedHostId, "hostId");
  if (input.claimedHostId !== input.targetHostId) {
    throw new BrowserHostPinError(
      "host_id_response_mismatch",
      "the Host API response ID does not exactly match the route and DELETE target",
    );
  }
  // The claimed key is still strictly validated (a keyless or malformed Host
  // API response never drives a deletion flow), but its VALUE no longer gates
  // the tombstone — see the docstring.
  await claimedIdentity(input.claimedHostPublicKey);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const revokedPin = await compareAndWrite(database, (records) => {
      const scoped = recordsInScope(records, input.accountId, input.origin);
      const bound = scoped.find((record) => record.hostIds.includes(input.targetHostId));
      if (bound === undefined) {
        throw new BrowserHostPinError(
          "missing_pin",
          "server deletion requires an existing exact local Host-ID-to-key binding",
        );
      }
      // A claimed key differing from the bound one is NOT a block: the server
      // cannot veto a local trust withdrawal, and a re-keyed host would
      // otherwise be unremovable from this browser forever. The bound record
      // (the key this device actually approved for this Host ID) is what dies.
      if (bound.state === "revoked") return { result: publicPin(bound) };
      if (
        records.filter((record) => record.state === "revoked").length >=
        BROWSER_HOST_PIN_MAX_TOMBSTONES
      ) {
        throw new BrowserHostPinError(
          "capacity_exceeded",
          `local host-pin storage is limited to ${BROWSER_HOST_PIN_MAX_TOMBSTONES} tombstones`,
        );
      }
      const now = checkedNow(options);
      const revoked: StoredBrowserHostPinV1 = {
        ...bound,
        revokedAtMs: Math.max(now, bound.approvedAtMs),
        state: "revoked",
      };
      return { nextRecord: revoked, result: publicPin(revoked) };
    });
    announceBrowserHostPinChange();
    return revokedPin;
  } finally {
    database.close();
  }
}

/**
 * Forget every ACTIVE pin in scope by DELETING the records outright — the
 * device-local reset behind "Forget hosts on this device".
 *
 * Deletion (not tombstoning) is deliberate tombstone PROVENANCE (review P-C6):
 * a retained `state: "revoked"` record means an operator's TARGETED host
 * revocation — a statement about the HOST — which a bundle import must never
 * resurrect and the signed-RTC gate must keep refusing. A forget is the
 * opposite statement — "this DEVICE should remember nothing" — so the record
 * disappears entirely and a later passkey import may re-pin the host as if
 * first seen, instead of skipping it forever while the unlock claims the
 * device "already knows" hosts it cannot reach. Targeted-revocation
 * tombstones already in scope are retained untouched: a forget is a reset,
 * not an amnesty for hosts the operator deliberately removed here.
 */
export async function forgetActiveBrowserHostPins(
  input: { readonly accountId: string; readonly origin: string },
  options: BrowserHostPinStorageOptions = {},
): Promise<{ readonly forgotten: number }> {
  assertScope(input.accountId, input.origin);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const outcome = await compareAndWrite(database, (records) => {
      const active = recordsInScope(records, input.accountId, input.origin).filter(
        (record) => record.state === "active",
      );
      return {
        removeRecordIds: active.map((record) => record.recordId),
        result: { forgotten: active.length },
      };
    });
    if (outcome.forgotten > 0) announceBrowserHostPinChange();
    return outcome;
  } finally {
    database.close();
  }
}

/** Read one exact scoped pin for recovery UI without creating or changing trust. */
/**
 * Every active pin in scope, for sealing into the operator's trust bundle.
 *
 * Active only: revocation tombstones must not be carried to a new device, or
 * importing the bundle there would resurrect trust the operator withdrew.
 */
export async function listActiveBrowserHostPins(
  input: { readonly accountId: string; readonly origin: string },
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin[]> {
  assertScope(input.accountId, input.origin);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const records = await readValidatedRecords(database);
    return recordsInScope(records, input.accountId, input.origin)
      .filter((record) => record.state === "active")
      .map(publicPin);
  } finally {
    database.close();
  }
}

export async function loadBrowserHostPin(
  input: ApproveBrowserHostPinInput,
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin | null> {
  assertScope(input.accountId, input.origin);
  const identity = await strictIdentity(input.hostPublicKey, input.hostFingerprint);
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const records = await readValidatedRecords(database);
    const exact = recordsInScope(records, input.accountId, input.origin).find(
      (record) => record.hostPublicKey === identity.hostPublicKey,
    );
    return exact === undefined ? null : publicPin(exact);
  } finally {
    database.close();
  }
}

/**
 * Look up any local pin bound to `hostId`, independent of any key the server
 * claims. The signed-RTC trust gate uses this to detect a downgrade: if a
 * hostId is already locally pinned but the server presents a null or foreign
 * key, the connection must be refused rather than silently reduced to a raw,
 * unauthenticated path. Returns a bound record whether active or revoked; the
 * caller treats any binding as "this hostId is known" and fails closed.
 */
export async function loadBrowserHostPinByHostId(
  input: { readonly accountId: string; readonly origin: string; readonly hostId: string },
  options: BrowserHostPinStorageOptions = {},
): Promise<BrowserHostPin | null> {
  assertScope(input.accountId, input.origin);
  assertCanonicalUuid(input.hostId, "hostId");
  const factory = resolveIndexedDB(options);
  const database = await openDatabase(factory);
  try {
    const records = await readValidatedRecords(database);
    const bound = recordsInScope(records, input.accountId, input.origin).find((record) =>
      record.hostIds.includes(input.hostId),
    );
    return bound === undefined ? null : publicPin(bound);
  } finally {
    database.close();
  }
}
