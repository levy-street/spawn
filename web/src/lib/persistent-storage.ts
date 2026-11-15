import { useSyncExternalStore } from "react";

/**
 * What the browser said when asked to keep this origin's storage.
 *
 * - `granted` — the origin is persisted; the browser will not clear it to free
 *   disk, so the device key survives.
 * - `refused` — the browser said no (or the request failed). Its storage stays
 *   "best effort", and the key can vanish on a day the disk runs low.
 * - `unsupported` — no StorageManager to ask (an insecure context, an old
 *   browser). Nothing is known either way.
 */
export type DeviceStoragePersistence = "granted" | "refused" | "unsupported";

type PersistApi = Pick<StorageManager, "persist" | "persisted">;

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
 * used; Firefox asks once and remembers the answer. A refusal or a missing
 * API leaves things exactly as they were — but the answer is the one thing
 * that says whether this browser can lose its approval, so it is returned
 * rather than swallowed (#121: the first version threw it away, and nobody
 * learned that the browser kept saying no).
 */
export async function keepDeviceStorage(
  storage: PersistApi | undefined = globalThis.navigator?.storage,
): Promise<DeviceStoragePersistence> {
  if (typeof storage?.persist !== "function") return "unsupported";
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return "granted";
    return (await storage.persist()) ? "granted" : "refused";
  } catch {
    return "refused";
  }
}

// The latest answer, for the page's lifetime. Null until the page has asked
// (registration asks once its device is ready).
let answer: DeviceStoragePersistence | null = null;
const listeners = new Set<() => void>();

/**
 * Ask, and keep the answer where the UI can read it
 * (`useDeviceStoragePersistence`).
 *
 * Called when this browser's device is registered, and again at the moments
 * a new answer becomes possible: Chrome grants persistence to sites that may
 * send notifications (and to installed apps), so a person who has just
 * allowed notifications can turn a refusal into a grant without knowing it.
 */
export async function askToKeepDeviceStorage(
  storage?: PersistApi,
): Promise<DeviceStoragePersistence> {
  // Undefined falls through to keepDeviceStorage's default, the real one.
  const next = await keepDeviceStorage(storage);
  if (next !== answer) {
    answer = next;
    for (const listener of listeners) listener();
  }
  return next;
}

/** The answer this page last got, or null before it has asked. */
export function deviceStoragePersistence(): DeviceStoragePersistence | null {
  return answer;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceStoragePersistence(): DeviceStoragePersistence | null {
  return useSyncExternalStore(subscribe, deviceStoragePersistence, () => null);
}

/** Test seam: forget the recorded answer. */
export function resetDeviceStoragePersistenceForTest(): void {
  answer = null;
  for (const listener of listeners) listener();
}
