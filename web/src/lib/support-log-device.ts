import type { QueryClient } from "@tanstack/react-query";
import { trust } from "./api";
import { loadBrowserDeviceIdentity, signSupportLogConsent } from "./browser-device-identity";
import { readBrowserDeviceRevocationMarker } from "./browser-device-registration";
import { readSupportLog } from "./support-log";
import { checkedConsentTime, type SignedSupportLogConsent } from "./support-log-consent";

type Edge = Awaited<ReturnType<typeof trust.accountEndorsements>>[number];

// Carry the nearest approvals first. Each machine verifies what it is given.
function carriedApprovals(accountId: string, publicKey: string, edges: Edge[]) {
  const carried: SignedSupportLogConsent["carried_endorsements"] = [];
  let frontier = new Set([publicKey]);
  const seen = new Set(frontier);
  for (let depth = 0; depth < 8 && frontier.size; depth++) {
    const next = new Set<string>();
    for (const edge of edges) {
      const { endorsed_public_key, endorser_public_key, endorsed_device_id, signature } = edge;
      if (!frontier.has(endorsed_public_key)) continue;
      carried.push({
        account_id: accountId,
        endorser_public_key,
        endorsed_public_key,
        endorsed_device_id,
        signature,
      });
      if (carried.length === 64) return carried;
      if (!seen.has(endorser_public_key)) {
        seen.add(endorser_public_key);
        next.add(endorser_public_key);
      }
    }
    frontier = next;
  }
  return carried;
}

export async function supportLogDevice(accountId: string, deviceId: string, publicKey: string) {
  if (readBrowserDeviceRevocationMarker(accountId)) return null;
  const identity = await loadBrowserDeviceIdentity(accountId);
  if (!identity || publicKey !== identity.publicKeyWire) return null;

  return async (
    client: QueryClient,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<SignedSupportLogConsent> => {
    const cached = client.getQueryState<Edge[]>(["account-endorsements", accountId]);
    const edges =
      (!cached?.isInvalidated && cached?.data) ||
      (await trust.accountEndorsements().catch(() => []));
    if (signal.aborted) throw new Error("Panel closed");
    const carried_endorsements = carriedApprovals(accountId, publicKey, edges);
    const fresh = await readSupportLog(accountId, signal);
    if (signal.aborted || readBrowserDeviceRevocationMarker(accountId))
      throw new Error("Device unavailable");
    const statement = {
      version: 1 as const,
      account_id: accountId,
      signer_device_id: deviceId,
      signer_public_key: publicKey,
      enabled,
      issued_at_ms: checkedConsentTime(fresh.next_issued_at_ms, accountId),
    };
    const signature = await signSupportLogConsent(identity, statement, signal);
    return { ...statement, signature, carried_endorsements };
  };
}
