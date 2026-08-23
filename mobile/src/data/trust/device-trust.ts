import { listBrowserDevices } from "@/data/api/endpoints/devices";
import { listHostPins } from "@/data/api/endpoints/trust";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity } from "@/lib/crypto/identity";

/**
 * Whether a host will accept a signed RTC offer from this device.
 *
 * A daemon answers only offers signed by a browser key it has pinned locally,
 * and it drops everything else without replying. Without this probe the app
 * has no way to tell that apart from a slow network: the terminal, the file
 * explorer, and the launcher all sit on "Connecting" until the user gives up.
 * "unknown" means the probe itself could not answer — never block on it.
 */
export type DeviceHostTrust = "trusted" | "untrusted" | "unknown";

export const DEVICE_NOT_TRUSTED_CODE = "device_not_trusted";
export const DEVICE_NOT_TRUSTED_MESSAGE =
  "This host has not approved this device yet. Approve it from a device that already works (Settings › Browser devices), or pair the host again from this one.";

const TRUST_TTL_MS = 30_000;

export interface DeviceTrustProbeApi {
  listBrowserDevices: typeof listBrowserDevices;
  listHostPins: typeof listHostPins;
  publicKey: () => Promise<Uint8Array | null>;
  nowMs: () => number;
}

const defaultApi: DeviceTrustProbeApi = {
  listBrowserDevices,
  listHostPins,
  publicKey: () => deviceIdentity.publicKey(),
  nowMs: () => Date.now(),
};

interface CacheEntry {
  status: DeviceHostTrust;
  atMs: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop memoized verdicts so a fresh approval takes effect immediately. */
export function invalidateDeviceHostTrust(hostId?: string): void {
  if (hostId === undefined) cache.clear();
  else cache.delete(hostId);
}

async function resolveTrust(hostId: string, api: DeviceTrustProbeApi): Promise<DeviceHostTrust> {
  const publicKeyBytes = await api.publicKey();
  if (publicKeyBytes === null) return "unknown";
  const publicKey = encodeBase64Url(publicKeyBytes);
  publicKeyBytes.fill(0);
  const [devices, pinnedDeviceIds] = await Promise.all([
    api.listBrowserDevices(),
    api.listHostPins(hostId),
  ]);
  const thisDevice = devices.find(
    (device) => device.public_key === publicKey && device.revoked_at === null,
  );
  // An unregistered identity cannot be pinned, so the host will drop its
  // offers for exactly the same reason a registered-but-unapproved one does.
  if (thisDevice === undefined) return "untrusted";
  return pinnedDeviceIds.includes(thisDevice.id) ? "trusted" : "untrusted";
}

export async function probeDeviceHostTrust(
  hostId: string,
  overrides?: Partial<DeviceTrustProbeApi>,
): Promise<DeviceHostTrust> {
  const api = overrides === undefined ? defaultApi : { ...defaultApi, ...overrides };
  const cached = cache.get(hostId);
  const now = api.nowMs();
  if (cached !== undefined && now - cached.atMs < TRUST_TTL_MS) return cached.status;
  let status: DeviceHostTrust;
  try {
    status = await resolveTrust(hostId, api);
  } catch {
    // A probe failure is not evidence of distrust; let the dial proceed and
    // let the connect watchdog report whatever actually goes wrong.
    status = "unknown";
  }
  if (status !== "unknown") cache.set(hostId, { status, atMs: now });
  return status;
}
