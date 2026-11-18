import type { QueryClient } from "@tanstack/react-query";
import { readSupportLog } from "@/data/api/endpoints/support-log";
import { listAccountEndorsements } from "@/data/api/endpoints/trust";
import type { MeResponse } from "@/data/api/schemas/auth";
import type { AccountEndorsementRecord as Edge } from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { activeDeviceIdentityAccount, deviceIdentity } from "@/lib/crypto/identity";
import {
  checkedConsentTime,
  rememberConsentTime,
  type SignedSupportLogConsent,
} from "@/lib/crypto/support-log-consent";
import type { RegisteredPhone } from "./registration";

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

export async function supportLogDevice(accountId: string, local: RegisteredPhone | undefined) {
  if (!local || local.revoked_at || accountId !== activeDeviceIdentityAccount()) return null;
  const key = await deviceIdentity.publicKey();
  if (!key || encodeBase64Url(key) !== local.public_key) return null;

  return async (
    client: QueryClient,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<SignedSupportLogConsent> => {
    const cached =
      client.getQueryData<MeResponse>(qk.me())?.user.id === accountId
        ? client.getQueryState<Edge[]>(qk.trustAccountEndorsements())
        : undefined;
    const edges =
      (!cached?.isInvalidated && cached?.data) || (await listAccountEndorsements().catch(() => []));
    if (signal.aborted) throw new Error("Panel closed");
    const carried_endorsements = carriedApprovals(accountId, local.public_key, edges);
    const fresh = await readSupportLog(accountId, signal);
    if (signal.aborted) throw new Error("Device unavailable");
    const statement = {
      version: 1 as const,
      account_id: accountId,
      signer_device_id: local.id,
      signer_public_key: local.public_key,
      enabled,
      issued_at_ms: checkedConsentTime(fresh.next_issued_at_ms, accountId),
    };
    const signature = encodeBase64Url(await deviceIdentity.signSupportLogConsent(statement));
    rememberConsentTime(accountId, statement.issued_at_ms);
    return { ...statement, signature, carried_endorsements };
  };
}
