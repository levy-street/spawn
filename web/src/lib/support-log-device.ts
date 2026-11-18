import type { QueryClient } from "@tanstack/react-query";
import { browserDevices, trust } from "./api";
import { loadBrowserDeviceIdentity, signSupportLogConsent } from "./browser-device-identity";
import {
  type BrowserDeviceRegistrationState,
  browserDeviceRegistrationQueryKey,
  readBrowserDeviceRevocationMarker,
} from "./browser-device-registration";
import type { SignedSupportLogConsent } from "./support-log-consent";
import { chainReachableFrom, computeTrustRoster, hostPinMap } from "./trust-roster";

/** Read only. Opening the setting must never create or register an identity. */
export async function supportLogDevice(client: QueryClient, accountId: string, hostIds: string[]) {
  const registration = client.getQueryCache().find<BrowserDeviceRegistrationState>({
    queryKey: browserDeviceRegistrationQueryKey(accountId),
  });
  const registered = registration?.state.data ?? (await registration?.promise);
  if (registered?.status !== "ready") return null;
  const local = registered.device;
  if (readBrowserDeviceRevocationMarker(accountId)) return null;
  const identity = await loadBrowserDeviceIdentity(accountId);
  if (!identity) return null;
  const [devices, edges, pins] = await Promise.all([
    browserDevices.list(),
    trust.accountEndorsements(),
    Promise.all(hostIds.map(async (id) => [id, (await trust.hostPinStatus(id)).pins] as const)),
  ]);
  const mine = devices.find(
    (d) =>
      d.id === local.id &&
      d.public_key === local.public_key &&
      !d.is_root &&
      d.revoked_at === null &&
      d.public_key === identity.publicKeyWire,
  );
  const roster = computeTrustRoster(devices, edges, hostPinMap(pins).anchorDeviceIds);
  if (!mine || !roster.get(mine.id)?.chainTrusted) return null;

  // Only upstream RTC approvals can help a host verify this device. The account
  // PUT accepts exactly the five wire fields; roster metadata is not carried.
  const upstream = chainReachableFrom(
    [mine.id],
    devices,
    edges.map((edge) => ({
      endorser_device_id: edge.endorsed_device_id,
      endorsed_device_id: edge.endorser_device_id,
    })),
  );
  const carried = edges
    .filter(
      (edge) =>
        roster.get(edge.endorser_device_id)?.chainTrusted &&
        upstream.has(edge.endorsed_device_id) &&
        upstream.has(edge.endorser_device_id),
    )
    .slice(0, 64)
    .map(({ endorser_public_key, endorsed_public_key, endorsed_device_id, signature }) => ({
      account_id: accountId,
      endorser_public_key,
      endorsed_public_key,
      endorsed_device_id,
      signature,
    }));
  return async (enabled: boolean, issued_at_ms: number): Promise<SignedSupportLogConsent> => {
    const statement = {
      version: 1 as const,
      account_id: accountId,
      signer_device_id: mine.id,
      signer_public_key: identity.publicKeyWire,
      enabled,
      issued_at_ms,
    };
    return {
      ...statement,
      signature: await signSupportLogConsent(identity, statement),
      carried_endorsements: carried,
    };
  };
}
