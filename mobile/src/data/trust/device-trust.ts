import { listBrowserDevices } from "@/data/api/endpoints/devices";
import { getHost } from "@/data/api/endpoints/hosts";
import { listAccountEndorsements, listHostPins } from "@/data/api/endpoints/trust";
import { chainReachableFrom } from "@/data/trust/chain-reach";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity } from "@/lib/crypto/identity";

/**
 * Whether a host will accept a signed RTC offer from this device.
 *
 * A daemon answers offers signed by a browser key it has pinned locally, or —
 * on a host that validates account chains (mesh §3) — by a key that reaches
 * one of its pins through a carried chain of account endorsements. It drops
 * everything else without replying. Without this probe the app has no way to
 * tell that apart from a slow network: the terminal, the file explorer, and
 * the launcher all sit on "Connecting" until the user gives up. "unknown"
 * means the probe itself could not answer — never block on it.
 *
 * Advisory: the daemon decides admission by re-verifying signatures against
 * its own anchors. This mirrors its search over server-claimed rows so the
 * app can say the true thing and reconnect the moment an approval lands.
 */
export type DeviceHostTrust = "trusted" | "untrusted" | "unknown";

export const DEVICE_NOT_TRUSTED_CODE = "device_not_trusted";
export const DEVICE_NOT_TRUSTED_MESSAGE =
  "This host has not approved this device yet. Approve it from a device that already works (Settings › Browser devices), or pair the host again from this one.";

const TRUST_TTL_MS = 30_000;

export interface DeviceTrustProbeApi {
  listBrowserDevices: typeof listBrowserDevices;
  listHostPins: typeof listHostPins;
  listAccountEndorsements: typeof listAccountEndorsements;
  getHost: typeof getHost;
  publicKey: () => Promise<Uint8Array | null>;
  nowMs: () => number;
}

const defaultApi: DeviceTrustProbeApi = {
  listBrowserDevices,
  listHostPins,
  listAccountEndorsements,
  getHost,
  publicKey: () => deviceIdentity.publicKey(),
  nowMs: () => Date.now(),
};

interface CacheEntry {
  status: DeviceHostTrust;
  atMs: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * The account-wide reads (devices, endorsement edges) are the same for every
 * host, and the approval watch probes every host in one burst every few
 * seconds — share one in-flight read across the burst instead of repeating it
 * per host. Keyed on the loader function so a test's injected loaders never
 * see another test's result.
 */
const SHARED_READ_TTL_MS = 1_000;
const sharedReads = new WeakMap<
  () => Promise<unknown>,
  { atMs: number; promise: Promise<unknown> }
>();

function sharedRead<T>(load: () => Promise<T>, nowMs: number): Promise<T> {
  const hit = sharedReads.get(load);
  if (hit !== undefined && nowMs - hit.atMs < SHARED_READ_TTL_MS) return hit.promise as Promise<T>;
  const promise = load();
  sharedReads.set(load, { atMs: nowMs, promise });
  return promise;
}

/** Drop memoized verdicts so a fresh approval takes effect immediately. */
export function invalidateDeviceHostTrust(hostId?: string): void {
  if (hostId === undefined) cache.clear();
  else cache.delete(hostId);
}

async function resolveTrust(
  hostId: string,
  api: DeviceTrustProbeApi,
  nowMs: number,
): Promise<DeviceHostTrust> {
  const publicKeyBytes = await api.publicKey();
  if (publicKeyBytes === null) return "unknown";
  const publicKey = encodeBase64Url(publicKeyBytes);
  publicKeyBytes.fill(0);
  const [devices, pinnedDeviceIds, host] = await Promise.all([
    sharedRead(api.listBrowserDevices, nowMs),
    api.listHostPins(hostId),
    api.getHost(hostId),
  ]);
  const thisDevice = devices.find(
    (device) => device.public_key === publicKey && device.revoked_at === null,
  );
  // An unregistered identity cannot be pinned, so the host will drop its
  // offers for exactly the same reason a registered-but-unapproved one does.
  if (thisDevice === undefined) return "untrusted";
  if (pinnedDeviceIds.includes(thisDevice.id)) return "trusted";
  // The chain path only exists on a host whose daemon validates it; toward an
  // older one a carried chain is ignored and the pin is the whole story.
  if (!host.supports_account_chains) return "untrusted";
  const edges = await sharedRead(api.listAccountEndorsements, nowMs);
  return chainReachableFrom(pinnedDeviceIds, devices, edges).has(thisDevice.id)
    ? "trusted"
    : "untrusted";
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
    status = await resolveTrust(hostId, api, now);
  } catch {
    // A probe failure is not evidence of distrust; let the dial proceed and
    // let the connect watchdog report whatever actually goes wrong.
    status = "unknown";
  }
  if (status !== "unknown") cache.set(hostId, { status, atMs: now });
  return status;
}
