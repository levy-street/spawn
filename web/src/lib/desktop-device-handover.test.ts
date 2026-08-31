import { describe, expect, test } from "bun:test";
import {
  DESKTOP_DEVICE_HANDOVER_KEY,
  DESKTOP_DEVICE_HANDOVER_VERSION,
  takeDesktopDeviceHandover,
} from "./desktop-device-handover";
import { encodeBase64Url } from "./signed-signal";

const ACCOUNT = "f02a4b8e-df36-4fea-a84a-bc7dacf4f679";
const OTHER_ACCOUNT = "0f2a4b8e-df36-4fea-a84a-bc7dacf4f679";
const DEVICE = "f037a638-d9a7-42df-aeca-070600901ba5";
const SHELL_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/26.2 Safari/605.1.15 SpawnDesktop/0.1.2";
const BROWSER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/26.2 Safari/605.1.15";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

async function realIdentity(): Promise<{ seed: Uint8Array; publicKeyWire: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { seed: pkcs8.slice(pkcs8.byteLength - 32), publicKeyWire: encodeBase64Url(raw) };
}

function stored(record: Record<string, unknown>): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(DESKTOP_DEVICE_HANDOVER_KEY, JSON.stringify(record));
  return storage;
}

describe("takeDesktopDeviceHandover", () => {
  test("takes the record only inside the desktop window, and only once", async () => {
    const identity = await realIdentity();
    const record = {
      version: DESKTOP_DEVICE_HANDOVER_VERSION,
      account_id: ACCOUNT,
      device_id: DEVICE,
      public_key: identity.publicKeyWire,
      seed: encodeBase64Url(identity.seed),
    };
    const storage = stored(record);

    // A browser tab never reads it, and never disturbs it.
    expect(takeDesktopDeviceHandover(ACCOUNT, { storage, userAgent: BROWSER_AGENT })).toBeNull();
    expect(storage.getItem(DESKTOP_DEVICE_HANDOVER_KEY)).not.toBeNull();

    const taken = takeDesktopDeviceHandover(ACCOUNT, { storage, userAgent: SHELL_AGENT });
    expect(taken).not.toBeNull();
    expect(taken?.accountId).toBe(ACCOUNT);
    expect(taken?.deviceId).toBe(DEVICE);
    expect(taken?.publicKeyWire).toBe(identity.publicKeyWire);
    expect(taken?.seed).toEqual(identity.seed);
    // Gone the moment it is read: nothing later on this origin sees a seed.
    expect(storage.length).toBe(0);
    expect(takeDesktopDeviceHandover(ACCOUNT, { storage, userAgent: SHELL_AGENT })).toBeNull();
  });

  test("drops a record for another account, and anything malformed, without keeping it", async () => {
    const identity = await realIdentity();
    const good = {
      version: DESKTOP_DEVICE_HANDOVER_VERSION,
      account_id: ACCOUNT,
      device_id: DEVICE,
      public_key: identity.publicKeyWire,
      seed: encodeBase64Url(identity.seed),
    };
    const cases: Record<string, unknown>[] = [
      { ...good, account_id: OTHER_ACCOUNT },
      { ...good, version: 2 },
      { ...good, device_id: "not-a-uuid" },
      { ...good, public_key: "short" },
      { ...good, public_key: encodeBase64Url(new Uint8Array(32)) }, // not a curve point
      { ...good, seed: "AAAA" },
      { ...good, seed: 7 },
    ];
    for (const record of cases) {
      const storage = stored(record);
      expect(takeDesktopDeviceHandover(ACCOUNT, { storage, userAgent: SHELL_AGENT })).toBeNull();
      expect(storage.length).toBe(0);
    }
    const garbage = new MemoryStorage();
    garbage.setItem(DESKTOP_DEVICE_HANDOVER_KEY, "{not json");
    expect(
      takeDesktopDeviceHandover(ACCOUNT, { storage: garbage, userAgent: SHELL_AGENT }),
    ).toBeNull();
    expect(garbage.length).toBe(0);
    // A record for another account is refused whatever the caller's id looks like.
    expect(
      takeDesktopDeviceHandover("nope", { storage: stored(good), userAgent: SHELL_AGENT }),
    ).toBeNull();
  });

  test("storage that is missing or throwing is no handover, not an error", () => {
    expect(
      takeDesktopDeviceHandover(ACCOUNT, { storage: null, userAgent: SHELL_AGENT }),
    ).toBeNull();
    const throwing = new MemoryStorage();
    throwing.getItem = () => {
      throw new Error("SecurityError");
    };
    expect(
      takeDesktopDeviceHandover(ACCOUNT, { storage: throwing, userAgent: SHELL_AGENT }),
    ).toBeNull();
    const empty = new MemoryStorage();
    expect(
      takeDesktopDeviceHandover(ACCOUNT, { storage: empty, userAgent: SHELL_AGENT }),
    ).toBeNull();
  });
});
