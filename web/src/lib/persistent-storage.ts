/**
 * Ask the browser to keep this origin's storage, where the device key lives.
 *
 * Without it the origin's IndexedDB is "best effort": Chrome deletes it when
 * the disk runs low, cookies excepted. The page then loads signed in but with
 * no key, mints a new one, and the person is asked to approve the same
 * browser again — on 2026-09-30 one MacBook had done so eleven times in a
 * month, the latest after four and a half hours. A persisted origin is exempt.
 *
 * Chrome and Safari grant or refuse without asking, by how much the site is
 * used; Firefox asks once and remembers the answer. Best effort throughout:
 * a refusal or a missing API leaves things exactly as they were.
 */
export async function keepDeviceStorage(
  storage: Pick<StorageManager, "persist" | "persisted"> | undefined = globalThis.navigator
    ?.storage,
): Promise<boolean> {
  if (typeof storage?.persist !== "function") return false;
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
