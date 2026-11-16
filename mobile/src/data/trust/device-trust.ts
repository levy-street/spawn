import { listBrowserDevices } from "@/data/api/endpoints/devices";
import { getHost } from "@/data/api/endpoints/hosts";
import { getHostPins, listAccountEndorsements } from "@/data/api/endpoints/trust";
import { invalidateCarriedEndorsements } from "@/data/trust/carried-endorsements";
import { chainReachableFrom, pinIdsByStanding } from "@/data/trust/chain-reach";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity } from "@/lib/crypto/identity";

/**
 * Whether the account has approved this device toward a host.
 *
 * A daemon answers offers signed by a browser key it has pinned locally, or —
 * on a host that validates account chains (mesh §3) — by a key that reaches
 * one of its pins through a carried chain of account endorsements. It drops
 * everything else without replying. Without this probe the app has no way to
 * tell that apart from a slow network: the terminal, the file explorer, and
 * the launcher all sit on "Connecting" until the user gives up. "unknown"
 * means the probe itself could not answer — never block on it.
 *
 * "untrusted" means the account's records give this device no way to the
 * host: no pin of its own and no chain from one of the host's pins. It is the
 * one verdict that puts up the approval sheet and knocks. A pin the host has
 * not confirmed still counts (#138, `pinStanding`): approving again would
 * change nothing, so an approved device whose host has not taken the approval
 * in yet is "trusted" with `confirmed` false, connects as usual, and shows the
 * terminal's own connection states; the host's page says "Not delivered". A
 * pin the host REJECTED as unverifiable counts for nothing.
 *
 * Advisory: the daemon decides admission by re-verifying signatures against
 * its own anchors. This mirrors its search over server-claimed rows so the
 * app can say the true thing and reconnect the moment an approval lands.
 */
export type DeviceHostTrust = "trusted" | "untrusted" | "unknown";

export interface DeviceHostTrustResult {
  status: DeviceHostTrust;
  /** True only when the host has confirmed this device's own pin. */
  directlyPinned: boolean;
  /** True when the way to this host runs only through pins the host has
   * confirmed: what it admits today, for per-host questions (which hosts an
   * approval signed on this phone can reach). */
  confirmed: boolean;
}

export const DEVICE_NOT_TRUSTED_CODE = "device_not_trusted";
export const DEVICE_NOT_TRUSTED_MESSAGE =
  "This host has not approved this device yet. Approve it from a device that already works (Settings › Browser devices), or pair the host again from this one.";

const TRUST_TTL_MS = 30_000;

export interface DeviceTrustProbeApi {
  listBrowserDevices: typeof listBrowserDevices;
  getHostPins: typeof getHostPins;
  listAccountEndorsements: typeof listAccountEndorsements;
  getHost: typeof getHost;
  publicKey: () => Promise<Uint8Array | null>;
  nowMs: () => number;
}

const defaultApi: DeviceTrustProbeApi = {
  listBrowserDevices,
  getHostPins,
  listAccountEndorsements,
  getHost,
  publicKey: () => deviceIdentity.publicKey(),
  nowMs: () => Date.now(),
};

interface CacheEntry extends DeviceHostTrustResult {
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
export const SHARED_READ_TTL_MS = 1_000;
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

/**
 * Drop memoized verdicts so a fresh approval takes effect immediately.
 *
 * The edges an offer carries are dropped with them. Every caller here means
 * the same thing — an approval may have just landed — and a verdict refreshed
 * against edges still cached from before it is a device that is told it is
 * trusted while it goes on offering the proof that was already refused.
 */
export function invalidateDeviceHostTrust(hostId?: string): void {
  if (hostId === undefined) cache.clear();
  else cache.delete(hostId);
  invalidateCarriedEndorsements();
}

async function resolveTrust(
  hostId: string,
  api: DeviceTrustProbeApi,
  nowMs: number,
): Promise<DeviceHostTrustResult> {
  const untrusted: DeviceHostTrustResult = {
    status: "untrusted",
    directlyPinned: false,
    confirmed: false,
  };
  const publicKeyBytes = await api.publicKey();
  if (publicKeyBytes === null) return { ...untrusted, status: "unknown" };
  const publicKey = encodeBase64Url(publicKeyBytes);
  publicKeyBytes.fill(0);
  const [devices, hostPins, host] = await Promise.all([
    sharedRead(api.listBrowserDevices, nowMs),
    api.getHostPins(hostId),
    api.getHost(hostId),
  ]);
  const thisDevice = devices.find(
    (device) => device.public_key === publicKey && device.revoked_at === null,
  );
  // An unregistered identity cannot be pinned, so the host will drop its
  // offers for exactly the same reason a registered-but-unapproved one does.
  if (thisDevice === undefined) return untrusted;
  // What the account recorded (every pin the host did not reject) and what
  // the host has confirmed taking in, kept apart.
  const { recorded, confirmed: confirmedPins } = pinIdsByStanding(hostPins.pins);
  if (confirmedPins.includes(thisDevice.id)) {
    return { status: "trusted", directlyPinned: true, confirmed: true };
  }
  // The chain path only exists on a host whose daemon validates it; toward an
  // older one a carried chain is ignored and the pin is the whole story.
  if (!host.supports_account_chains) {
    return recorded.includes(thisDevice.id)
      ? { status: "trusted", directlyPinned: false, confirmed: false }
      : untrusted;
  }
  const edges = await sharedRead(api.listAccountEndorsements, nowMs);
  // This device's own recorded pin seeds the walk too, so it reaches itself.
  if (!chainReachableFrom(recorded, devices, edges).has(thisDevice.id)) return untrusted;
  return {
    status: "trusted",
    directlyPinned: false,
    confirmed: chainReachableFrom(confirmedPins, devices, edges).has(thisDevice.id),
  };
}

export async function probeDeviceHostTrustResult(
  hostId: string,
  overrides?: Partial<DeviceTrustProbeApi>,
): Promise<DeviceHostTrustResult> {
  const api = overrides === undefined ? defaultApi : { ...defaultApi, ...overrides };
  const cached = cache.get(hostId);
  const now = api.nowMs();
  if (cached !== undefined && now - cached.atMs < TRUST_TTL_MS) {
    return {
      status: cached.status,
      directlyPinned: cached.directlyPinned,
      confirmed: cached.confirmed,
    };
  }
  let result: DeviceHostTrustResult;
  try {
    result = await resolveTrust(hostId, api, now);
  } catch {
    // A probe failure is not evidence of distrust; let the dial proceed and
    // let the connect watchdog report whatever actually goes wrong.
    result = { status: "unknown", directlyPinned: false, confirmed: false };
  }
  if (result.status !== "unknown") cache.set(hostId, { ...result, atMs: now });
  return result;
}

export async function probeDeviceHostTrust(
  hostId: string,
  overrides?: Partial<DeviceTrustProbeApi>,
): Promise<DeviceHostTrust> {
  return (await probeDeviceHostTrustResult(hostId, overrides)).status;
}
