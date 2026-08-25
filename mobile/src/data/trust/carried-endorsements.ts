import { listBrowserDevices } from "@/data/api/endpoints/devices";
import { listAccountEndorsements } from "@/data/api/endpoints/trust";
import { edgesToward } from "@/data/trust/chain-reach";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { activeDeviceIdentityAccount, deviceIdentity } from "@/lib/crypto/identity";

/**
 * One account-scoped endorsement edge as carried on an RTC offer (device mesh
 * §3). The daemon rebuilds the SPAWN-ACCT-ENDORSE-V1 transcript from these
 * fields and verifies the signature against the endorser key, so the server
 * relays them opaquely and nothing here is trusted as served.
 */
export interface CarriedEndorsement {
  account_id: string;
  endorser_public_key: string;
  endorsed_public_key: string;
  endorsed_device_id: string;
  signature: string;
}

export interface CarriedEndorsementApi {
  listBrowserDevices: typeof listBrowserDevices;
  listAccountEndorsements: typeof listAccountEndorsements;
  publicKey: () => Promise<Uint8Array | null>;
  accountId: () => string | null;
}

const defaultApi: CarriedEndorsementApi = {
  listBrowserDevices,
  listAccountEndorsements,
  publicKey: () => deviceIdentity.publicKey(),
  accountId: activeDeviceIdentityAccount,
};

const ENDORSEMENT_CACHE_MS = 30_000;
let defaultCache: { at: number; promise: Promise<CarriedEndorsement[]> } | null = null;

/** Share the offer-side HTTP work across reconnects for a short, bounded window. */
export function loadMemoizedCarriedEndorsements(): Promise<CarriedEndorsement[]> {
  const now = Date.now();
  if (defaultCache && now - defaultCache.at < ENDORSEMENT_CACHE_MS) return defaultCache.promise;
  const promise = loadCarriedEndorsements().catch((error) => {
    defaultCache = null;
    throw error;
  });
  defaultCache = { at: now, promise };
  return promise;
}

/**
 * The account endorsement edges this device presents with an offer, so a host
 * that does not pin it directly can admit it through a chain to one of its
 * anchors. Pruned to the edges upstream of this device: the rest of the graph
 * cannot admit it, and the relay caps what it forwards. Best-effort by
 * contract — callers send the offer either way, and a directly pinned device
 * is admitted exactly as before.
 */
export async function loadCarriedEndorsements(
  overrides?: Partial<CarriedEndorsementApi>,
): Promise<CarriedEndorsement[]> {
  const api = overrides === undefined ? defaultApi : { ...defaultApi, ...overrides };
  const accountId = api.accountId();
  if (accountId === null) return [];
  const publicKeyBytes = await api.publicKey();
  if (publicKeyBytes === null) return [];
  const publicKey = encodeBase64Url(publicKeyBytes);
  publicKeyBytes.fill(0);
  const [devices, edges] = await Promise.all([
    api.listBrowserDevices(),
    api.listAccountEndorsements(),
  ]);
  const thisDevice = devices.find(
    (device) => device.public_key === publicKey && device.revoked_at === null,
  );
  if (thisDevice === undefined) return [];
  return edgesToward(thisDevice.id, devices, edges).map((edge) => ({
    account_id: accountId,
    endorser_public_key: edge.endorser_public_key,
    endorsed_public_key: edge.endorsed_public_key,
    endorsed_device_id: edge.endorsed_device_id,
    signature: edge.signature,
  }));
}
