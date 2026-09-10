import { sha256 } from "@noble/hashes/sha2.js";
import type { SQLiteDatabase } from "expo-sqlite";

import { decodeBase64UrlExact, encodeBase64Url, parseCanonicalUuid } from "@/lib/crypto/bytes";
import { assertStrictEd25519PublicKey } from "@/lib/crypto/ed25519";
import { onDeviceIdentityReset } from "@/lib/crypto/identity";

const DATABASE_NAME = "spawn-trust.db";
const MAX_PINS = 256;
const MAX_HOST_IDS = 8;
const MAX_ORIGIN_LENGTH = 512;
const pinListeners = new Set<() => void>();
export function subscribeHostPinChanges(listener: () => void): () => void {
  pinListeners.add(listener);
  return () => pinListeners.delete(listener);
}
function pinsChanged(): void {
  for (const listener of [...pinListeners]) {
    try {
      listener();
    } catch {
      /* A consumer cannot undo a durable trust decision. */
    }
  }
}

export type HostPinState = "active" | "revoked";

export interface HostPin {
  accountId: string;
  serverOrigin: string;
  hostPublicKey: string;
  hostFingerprint: string;
  hostIds: readonly string[];
  state: HostPinState;
  createdAtMs: number;
  approvedAtMs: number;
  revokedAtMs: number | null;
}

export interface HostPinApproval {
  accountId: string;
  serverOrigin: string;
  hostPublicKey: string;
  hostId?: string;
  approvedAtMs?: number;
}

export type HostPinResolution =
  | { status: "match"; pin: HostPin }
  | { status: "missing"; presentedFingerprint: string }
  | { status: "mismatch"; expectedFingerprint: string; presentedFingerprint: string }
  | { status: "revoked"; pin: HostPin }
  | { status: "identity-missing" }
  | { status: "host-identity-withheld" }
  | { status: "storage-unavailable"; reason: string };

export interface HostPinLookup {
  accountId: string;
  serverOrigin: string;
  hostId?: string;
  presentedHostPublicKey: string | null;
  phoneIdentityAvailable: boolean;
}

export interface HostPinPersistence {
  load(accountId: string, serverOrigin: string): Promise<readonly unknown[]>;
  save(pin: HostPin): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;
}

export class PinStoreError extends Error {
  constructor(
    readonly code: "PIN_STORAGE_UNAVAILABLE" | "PIN_CONFLICT" | "PIN_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "PinStoreError";
  }
}

export function formatHostFingerprint(publicKeyWire: string): string {
  const publicKey = decodeBase64UrlExact(publicKeyWire, 32);
  assertStrictEd25519PublicKey(publicKey);
  return `SHA256:${encodeBase64Url(sha256(publicKey).slice(0, 12))}`;
}

export function parseServerOrigin(value: string): string {
  if (value.length < 1 || value.length > MAX_ORIGIN_LENGTH) {
    throw new Error("Server origin has an invalid length");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Server origin must be an absolute URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    throw new Error("Server origin must be an exact HTTP(S) origin");
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parsePin(value: unknown): HostPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Host pin is not an object");
  }
  const record = value as Record<string, unknown>;
  const accountId = parseCanonicalUuid(String(record["accountId"]));
  const serverOrigin = parseServerOrigin(String(record["serverOrigin"]));
  const hostPublicKey = String(record["hostPublicKey"]);
  const hostFingerprint = String(record["hostFingerprint"]);
  const expectedFingerprint = formatHostFingerprint(hostPublicKey);
  if (hostFingerprint !== expectedFingerprint) throw new Error("Host pin fingerprint is corrupt");
  if (!Array.isArray(record["hostIds"]) || record["hostIds"].length > MAX_HOST_IDS) {
    throw new Error("Host pin aliases are invalid");
  }
  const hostIds = record["hostIds"].map((hostId) => parseCanonicalUuid(String(hostId)));
  if (new Set(hostIds).size !== hostIds.length) throw new Error("Host pin aliases are duplicated");
  const state = record["state"];
  if (state !== "active" && state !== "revoked") throw new Error("Host pin state is invalid");
  const createdAtMs = parseTimestamp(record["createdAtMs"], "createdAtMs");
  const approvedAtMs = parseTimestamp(record["approvedAtMs"], "approvedAtMs");
  const revokedAtMs =
    record["revokedAtMs"] === null ? null : parseTimestamp(record["revokedAtMs"], "revokedAtMs");
  if (approvedAtMs < createdAtMs || (state === "active" && revokedAtMs !== null)) {
    throw new Error("Host pin timestamps are inconsistent");
  }
  if (state === "revoked" && (revokedAtMs === null || revokedAtMs < approvedAtMs)) {
    throw new Error("Revoked host pin timestamps are inconsistent");
  }
  return {
    accountId,
    serverOrigin,
    hostPublicKey,
    hostFingerprint,
    hostIds,
    state,
    createdAtMs,
    approvedAtMs,
    revokedAtMs,
  };
}

function copyPin(pin: HostPin): HostPin {
  return { ...pin, hostIds: [...pin.hostIds] };
}

export function hostPinRecordCounts(pins: readonly Pick<HostPin, "state">[]): {
  active: number;
  tombstones: number;
} {
  let active = 0;
  let tombstones = 0;
  for (const pin of pins) {
    if (pin.state === "active") active += 1;
    else tombstones += 1;
  }
  return { active, tombstones };
}

export interface HostPinStore {
  approveExact(input: HostPinApproval): Promise<HostPin>;
  revokeExact(input: Omit<HostPinApproval, "hostId" | "approvedAtMs">): Promise<void>;
  resolve(input: HostPinLookup): Promise<HostPinResolution>;
  list(accountId: string, serverOrigin: string): Promise<readonly HostPin[]>;
  clearAccount(accountId: string): Promise<void>;
}

export function createHostPinStore(persistence: HostPinPersistence): HostPinStore {
  async function load(accountId: string, serverOrigin: string): Promise<HostPin[]> {
    const account = parseCanonicalUuid(accountId);
    const origin = parseServerOrigin(serverOrigin);
    try {
      const pins = (await persistence.load(account, origin)).map(parsePin);
      // Revoked records are permanent local memory. They cannot consume the
      // active allowance or an account with enough history would be unable to
      // approve a new host without weakening that memory.
      if (hostPinRecordCounts(pins).active > MAX_PINS) {
        throw new Error("Active host approval limit was exceeded");
      }
      if (pins.some((pin) => pin.accountId !== account || pin.serverOrigin !== origin)) {
        throw new Error("Host pin scope is corrupt");
      }
      return pins;
    } catch (error) {
      if (error instanceof PinStoreError) throw error;
      throw new PinStoreError("PIN_STORAGE_UNAVAILABLE", "Trust storage is unavailable");
    }
  }

  return {
    async approveExact(input): Promise<HostPin> {
      const accountId = parseCanonicalUuid(input.accountId);
      const serverOrigin = parseServerOrigin(input.serverOrigin);
      const hostFingerprint = formatHostFingerprint(input.hostPublicKey);
      const hostId = input.hostId === undefined ? undefined : parseCanonicalUuid(input.hostId);
      const pins = await load(accountId, serverOrigin);
      const exact = pins.find((pin) => pin.hostPublicKey === input.hostPublicKey);
      const counts = hostPinRecordCounts(pins);
      if (
        hostId !== undefined &&
        pins.some(
          (pin) => pin.hostPublicKey !== input.hostPublicKey && pin.hostIds.includes(hostId),
        )
      ) {
        throw new PinStoreError("PIN_CONFLICT", "Host ID is already bound to another key");
      }
      if (exact?.state !== "active" && counts.active >= MAX_PINS) {
        throw new PinStoreError("PIN_LIMIT", "Host pin capacity has been reached");
      }
      const approvedAtMs = input.approvedAtMs ?? Date.now();
      const hostIds = new Set(exact?.hostIds ?? []);
      if (hostId !== undefined) hostIds.add(hostId);
      if (hostIds.size > MAX_HOST_IDS) {
        throw new PinStoreError("PIN_LIMIT", "A host pin cannot have more than eight aliases");
      }
      const pin: HostPin = {
        accountId,
        serverOrigin,
        hostPublicKey: input.hostPublicKey,
        hostFingerprint,
        hostIds: [...hostIds].sort(),
        state: "active",
        createdAtMs: exact?.createdAtMs ?? approvedAtMs,
        approvedAtMs,
        revokedAtMs: null,
      };
      try {
        await persistence.save(pin);
      } catch {
        throw new PinStoreError("PIN_STORAGE_UNAVAILABLE", "Trust storage is unavailable");
      }
      pinsChanged();
      return copyPin(pin);
    },

    async revokeExact(input): Promise<void> {
      const pins = await load(input.accountId, input.serverOrigin);
      const exact = pins.find((pin) => pin.hostPublicKey === input.hostPublicKey);
      if (exact === undefined) throw new PinStoreError("PIN_CONFLICT", "Host pin does not exist");
      try {
        await persistence.save({ ...exact, state: "revoked", revokedAtMs: Date.now() });
        pinsChanged();
      } catch {
        throw new PinStoreError("PIN_STORAGE_UNAVAILABLE", "Trust storage is unavailable");
      }
    },

    async resolve(input): Promise<HostPinResolution> {
      if (!input.phoneIdentityAvailable) return { status: "identity-missing" };
      if (input.presentedHostPublicKey === null) return { status: "host-identity-withheld" };
      let presentedFingerprint: string;
      try {
        presentedFingerprint = formatHostFingerprint(input.presentedHostPublicKey);
        const pins = await load(input.accountId, input.serverOrigin);
        const exact = pins.find((pin) => pin.hostPublicKey === input.presentedHostPublicKey);
        const hostId = input.hostId === undefined ? undefined : parseCanonicalUuid(input.hostId);
        const expected =
          hostId === undefined ? undefined : pins.find((pin) => pin.hostIds.includes(hostId));
        if (expected !== undefined && expected.hostPublicKey !== input.presentedHostPublicKey) {
          return {
            status: "mismatch",
            expectedFingerprint: expected.hostFingerprint,
            presentedFingerprint,
          };
        }
        if (exact !== undefined) {
          return exact.state === "revoked"
            ? { status: "revoked", pin: copyPin(exact) }
            : { status: "match", pin: copyPin(exact) };
        }
        return { status: "missing", presentedFingerprint };
      } catch (error) {
        return {
          status: "storage-unavailable",
          reason: error instanceof Error ? error.message : "Trust storage is unavailable",
        };
      }
    },

    async list(accountId, serverOrigin): Promise<readonly HostPin[]> {
      return (await load(accountId, serverOrigin)).map(copyPin);
    },

    async clearAccount(accountId): Promise<void> {
      try {
        await persistence.deleteAccount(parseCanonicalUuid(accountId));
        pinsChanged();
      } catch {
        throw new PinStoreError("PIN_STORAGE_UNAVAILABLE", "Trust storage is unavailable");
      }
    },
  };
}

interface HostPinRow {
  account_id: string;
  server_origin: string;
  host_public_key: string;
  host_fingerprint: string;
  host_ids_json: string;
  state: string;
  created_at_ms: number;
  approved_at_ms: number;
  revoked_at_ms: number | null;
  record_version: number;
}

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function database(): Promise<SQLiteDatabase> {
  databasePromise ??= import("expo-sqlite").then(async (sqlite) => {
    const db = await sqlite.openDatabaseAsync(DATABASE_NAME);
    await db.execAsync(
      "CREATE TABLE IF NOT EXISTS host_pins (account_id TEXT NOT NULL, server_origin TEXT NOT NULL, host_public_key TEXT NOT NULL, host_fingerprint TEXT NOT NULL, host_ids_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','revoked')), created_at_ms INTEGER NOT NULL, approved_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, record_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (account_id, server_origin, host_public_key));",
    );
    return db;
  });
  return databasePromise;
}

function rowToUnknown(row: HostPinRow): unknown {
  if (row.record_version !== 1) throw new Error("Unsupported host pin record version");
  return {
    accountId: row.account_id,
    serverOrigin: row.server_origin,
    hostPublicKey: row.host_public_key,
    hostFingerprint: row.host_fingerprint,
    hostIds: JSON.parse(row.host_ids_json) as unknown,
    state: row.state,
    createdAtMs: row.created_at_ms,
    approvedAtMs: row.approved_at_ms,
    revokedAtMs: row.revoked_at_ms,
  };
}

const sqlitePersistence: HostPinPersistence = {
  async load(accountId, serverOrigin) {
    const db = await database();
    const rows = await db.getAllAsync<HostPinRow>(
      "SELECT * FROM host_pins WHERE account_id = ? AND server_origin = ?",
      accountId,
      serverOrigin,
    );
    return rows.map(rowToUnknown);
  },

  async save(pin) {
    const db = await database();
    await db.runAsync(
      "INSERT INTO host_pins (account_id,server_origin,host_public_key,host_fingerprint,host_ids_json,state,created_at_ms,approved_at_ms,revoked_at_ms,record_version) VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(account_id,server_origin,host_public_key) DO UPDATE SET host_fingerprint=excluded.host_fingerprint,host_ids_json=excluded.host_ids_json,state=excluded.state,approved_at_ms=excluded.approved_at_ms,revoked_at_ms=excluded.revoked_at_ms,record_version=1",
      pin.accountId,
      pin.serverOrigin,
      pin.hostPublicKey,
      pin.hostFingerprint,
      JSON.stringify(pin.hostIds),
      pin.state,
      pin.createdAtMs,
      pin.approvedAtMs,
      pin.revokedAtMs,
    );
  },

  async deleteAccount(accountId) {
    const db = await database();
    await db.runAsync("DELETE FROM host_pins WHERE account_id = ? AND state = 'active'", accountId);
  },
};

let defaultStore: HostPinStore | null = null;

export async function openHostPinStore(): Promise<HostPinStore> {
  if (defaultStore === null) {
    await database();
    defaultStore = createHostPinStore(sqlitePersistence);
  }
  return defaultStore;
}

onDeviceIdentityReset(async (accountId) => {
  const store = await openHostPinStore();
  await store.clearAccount(accountId);
});
