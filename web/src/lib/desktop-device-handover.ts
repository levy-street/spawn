/**
 * The desktop app's device identity, handed to the page it hosts.
 *
 * SPAWN D's desktop app is one device — "SPAWN D on Mac" — and it is the
 * device that possessed this computer: the daemon pins its key, and its
 * signed host introductions are how the account learns that host. The web
 * app it then loads into its window would otherwise mint a device of its own,
 * a stranger the account has to be asked about and one the host will never
 * admit. So on the way into the product the app leaves its identity in this
 * origin's `sessionStorage` (`desktop/src-tauri/src/window.rs`), and the page
 * takes it before it registers as anything.
 *
 * Taking is one-shot: the record is removed the moment it is read, well- or
 * ill-formed, and it is only ever read inside the desktop window (the user
 * agent says so — `platform.ts`). A record for another account is dropped on
 * the floor rather than kept for later; the app writes a fresh one on every
 * open.
 */

import { isDesktopShell } from "./platform";
import {
  decodeBase64Url,
  decodeEd25519PublicKeyWire,
  ED25519_PRIVATE_KEY_SEED_BYTES,
  ED25519_PUBLIC_KEY_WIRE_CHARS,
} from "./signed-signal";

export const DESKTOP_DEVICE_HANDOVER_KEY = "spawn.desktop-device.v1";
export const DESKTOP_DEVICE_HANDOVER_VERSION = 1;

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface DesktopDeviceHandover {
  readonly accountId: string;
  /** The server's id for the device, as the app registered it. */
  readonly deviceId: string;
  readonly publicKeyWire: string;
  /** The raw 32-byte seed. Whoever imports it zeroes it. */
  readonly seed: Uint8Array;
}

export interface DesktopDeviceHandoverOptions {
  /** Test override. `null` stands for storage that throws on access. */
  readonly storage?: Storage | null;
  readonly userAgent?: string;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function parseHandover(raw: string, accountId: string): DesktopDeviceHandover | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { version, account_id, device_id, public_key, seed } = record;
  if (
    version !== DESKTOP_DEVICE_HANDOVER_VERSION ||
    account_id !== accountId ||
    typeof device_id !== "string" ||
    !CANONICAL_UUID_PATTERN.test(device_id) ||
    typeof public_key !== "string" ||
    public_key.length !== ED25519_PUBLIC_KEY_WIRE_CHARS ||
    typeof seed !== "string"
  ) {
    return null;
  }
  try {
    decodeEd25519PublicKeyWire(public_key);
    return {
      accountId,
      deviceId: device_id,
      publicKeyWire: public_key,
      seed: decodeBase64Url(seed, ED25519_PRIVATE_KEY_SEED_BYTES),
    };
  } catch {
    return null;
  }
}

/**
 * The identity the desktop app left for this page, if it left one — and never
 * the same one twice.
 */
export function takeDesktopDeviceHandover(
  accountId: string,
  options: DesktopDeviceHandoverOptions = {},
): DesktopDeviceHandover | null {
  const userAgent = options.userAgent ?? globalThis.navigator?.userAgent ?? "";
  if (!isDesktopShell(userAgent)) return null;
  const storage = Object.hasOwn(options, "storage") ? options.storage : sessionStorageOrNull();
  if (storage === null || storage === undefined) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DESKTOP_DEVICE_HANDOVER_KEY);
    if (raw !== null) storage.removeItem(DESKTOP_DEVICE_HANDOVER_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (!CANONICAL_UUID_PATTERN.test(accountId)) return null;
  return parseHandover(raw, accountId);
}
