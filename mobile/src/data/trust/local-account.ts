import type { SQLiteDatabase } from "expo-sqlite";
import { openHostPinStore } from "@/data/trust/host-pins";
import { parseCanonicalUuid } from "@/lib/crypto/bytes";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";

const DATABASE_NAME = "spawn-trust.db";

export interface LocalTrustAccountPersistence {
  deleteActiveHostApprovals(accountId: string): Promise<void>;
  deletePeerDeviceKeys(accountId: string): Promise<void>;
  deleteRootKnowledge(accountId: string): Promise<void>;
}

export interface LocalTrustAccountDependencies {
  persistence: LocalTrustAccountPersistence;
  resetIdentity(accountId: string): Promise<void>;
}

async function tableExists(db: SQLiteDatabase, table: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  return row !== null;
}

async function deleteIfPresent(
  db: SQLiteDatabase,
  table: "peer_device_keys" | "root_knowledge",
  accountId: string,
): Promise<void> {
  if (await tableExists(db, table)) {
    await db.runAsync(`DELETE FROM ${table} WHERE account_id = ?`, accountId);
  }
}

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function database(): Promise<SQLiteDatabase> {
  databasePromise ??= import("expo-sqlite").then((sqlite) =>
    sqlite.openDatabaseAsync(DATABASE_NAME),
  );
  return databasePromise;
}

const sqlitePersistence: LocalTrustAccountPersistence = {
  async deleteActiveHostApprovals(accountId) {
    await (await openHostPinStore()).clearAccount(accountId);
  },
  async deletePeerDeviceKeys(accountId) {
    await deleteIfPresent(await database(), "peer_device_keys", accountId);
  },
  async deleteRootKnowledge(accountId) {
    await deleteIfPresent(await database(), "root_knowledge", accountId);
  },
};

const defaultDependencies: LocalTrustAccountDependencies = {
  persistence: sqlitePersistence,
  async resetIdentity(accountId) {
    setDeviceIdentityAccount(accountId);
    await deviceIdentity.reset();
  },
};

/**
 * Removes one account's active local trust material. Revoked host records and
 * the trust_revision table are intentionally untouched: both are downgrade
 * memory, not disposable account cache.
 */
export async function removeLocalTrustAccount(
  accountId: string,
  dependencies: LocalTrustAccountDependencies = defaultDependencies,
): Promise<void> {
  const canonicalAccountId = parseCanonicalUuid(accountId);
  await dependencies.persistence.deleteActiveHostApprovals(canonicalAccountId);
  await dependencies.persistence.deletePeerDeviceKeys(canonicalAccountId);
  await dependencies.persistence.deleteRootKnowledge(canonicalAccountId);
  await dependencies.resetIdentity(canonicalAccountId);
}
