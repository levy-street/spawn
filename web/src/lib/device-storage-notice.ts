import type { DeviceStoragePersistence } from "./persistent-storage";

/**
 * The one notice a browser that can lose its approval gets (#121).
 *
 * A browser's device key lives in its IndexedDB, which Chrome clears under
 * disk pressure unless the origin is persisted — and Chrome refuses that by
 * heuristic. The page then mints a new key and the same browser has to be
 * approved again. With a passkey on the account that costs one touch on the
 * waiting card; without one it costs another device. So when the browser has
 * refused to keep its storage and the account has no passkey, say so once.
 *
 * Browser only: the phone's key sits in the Keychain/Keystore, which the OS
 * does not clear to free disk, and the desktop app's webview storage is a
 * separate question (#121 option D) — "this browser" would be the wrong word
 * there, so it never shows inside the desktop shell.
 */
export const DEVICE_STORAGE_NOTICE = {
  title: "This browser may forget its approval",
  body:
    "Your browser can clear the key that marks it as approved. Add a passkey and it can get " +
    "back in on its own, without another device.",
  addPasskey: "Add passkey",
  notNow: "Not now",
} as const;

/**
 * The waiting card's one added line on an account with no passkey: the moment
 * someone is stuck waiting is the moment the way out of next time makes sense.
 */
export const NO_PASSKEY_WAITING_HINT =
  "Once you're in, add a passkey in Account. Next time this device can get back in without another one.";

/** Per browser, per account: the condition is about this account's passkey. */
export function deviceStorageNoticeDismissedKey(accountId: string): string {
  return `spawn:access:storage-notice:${accountId}`;
}

export interface DeviceStorageNoticeFacts {
  /** What the browser said when asked to keep its storage; null before asking. */
  persistence: DeviceStoragePersistence | null;
  /**
   * Whether the account holds a passkey that can bring this browser back —
   * the sealed trust bundle the waiting card's "Use passkey" opens. Null
   * while that is still loading.
   */
  hasPasskey: boolean | null;
  /**
   * Hosts this browser itself holds trust for. A browser that holds none has
   * no approval to lose yet (a brand-new one is still on the waiting card,
   * which says the same thing in its own place). Null while unknown.
   */
  localHostCount: number | null;
  /** "Not now", or the notice's X, earlier in this browser. */
  dismissed: boolean;
  /** Inside the desktop app rather than a browser tab. */
  desktopShell: boolean;
}

/**
 * Whether to show the notice. Every unknown is a no: the notice is advice, and
 * showing it on a guess — before the passkey list has loaded, say — would tell
 * someone who has a passkey to go and add one.
 */
export function deviceStorageNoticeWanted(facts: DeviceStorageNoticeFacts): boolean {
  return (
    facts.persistence === "refused" &&
    facts.hasPasskey === false &&
    facts.localHostCount !== null &&
    facts.localHostCount > 0 &&
    !facts.dismissed &&
    !facts.desktopShell
  );
}
