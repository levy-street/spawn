import type { QueryClient } from "@tanstack/react-query";
import { readSupportLogTrust } from "@/data/api/endpoints/support-log";
import { qk } from "@/data/queryKeys";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { activeDeviceIdentityAccount, deviceIdentity } from "@/lib/crypto/identity";
import type { SignedSupportLogConsent } from "@/lib/crypto/support-log-consent";
import { chainReachableFrom, edgesToward, pinIdsByStanding } from "./chain-reach";
import type { RegisteredPhone } from "./registration";

/** Match the phone's existing key to a live roster row. Never register here. */
export async function supportLogDevice(client: QueryClient, accountId: string, hostIds: string[]) {
  const registration = client
    .getQueryCache()
    .find<RegisteredPhone>({ queryKey: qk.browserDeviceRegistration(accountId) });
  const local = registration?.state.data ?? (await registration?.promise);
  if (!local) return null;
  if (accountId !== activeDeviceIdentityAccount()) return null;
  const key = await deviceIdentity.publicKey();
  if (!key) return null;
  const publicKey = encodeBase64Url(key);
  const [devices, edges, pins] = await readSupportLogTrust(hostIds);
  const mine = devices.find(
    (d) =>
      d.id === local.id &&
      d.public_key === local.public_key &&
      !d.is_root &&
      d.revoked_at === null &&
      d.public_key === publicKey,
  );
  const anchors = [
    ...devices.filter((d) => d.is_root).map((d) => d.id),
    ...pins.flatMap((p) => pinIdsByStanding(p.pins).recorded),
  ];
  const approved = chainReachableFrom(anchors, devices, edges);
  if (!mine || !approved.has(mine.id)) return null;
  // Same upstream approvals and wire projection as a connection offer.
  const carried = edgesToward(mine.id, devices, edges)
    .filter((edge) => approved.has(edge.endorser_device_id))
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
      signer_public_key: publicKey,
      enabled,
      issued_at_ms,
    };
    return {
      ...statement,
      signature: encodeBase64Url(await deviceIdentity.signSupportLogConsent(statement)),
      carried_endorsements: carried,
    };
  };
}
