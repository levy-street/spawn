import type { QueryClient } from "@tanstack/react-query";
import type { SupportLogState } from "@/data/api/endpoints/support-log";
import { listAccountEndorsements } from "@/data/api/endpoints/trust";
import type { MeResponse } from "@/data/api/schemas/auth";
import type { AccountEndorsementRecord as Edge } from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { activeDeviceIdentityAccount, deviceIdentity } from "@/lib/crypto/identity";
import { checkedConsentTime, type SignedSupportLogConsent } from "@/lib/crypto/support-log-consent";
import { verifyAccountEndorsementEdge } from "./ceremony";
import { MAX_CHAIN_EDGES } from "./chain-reach";
import type { RegisteredPhone } from "./registration";

// Remember issued signatures even after a refusal or closing Account.
const lastSigned = new Map<string, number>();

type Step = { key: string; id?: string; path: Edge[] };

function verifies(accountId: string, trustedKey: string, edge: Edge) {
  return verifyAccountEndorsementEdge({
    accountId,
    endorserPublicKey: trustedKey,
    endorsedPublicKey: edge.endorsed_public_key,
    endorsedDeviceId: edge.endorsed_device_id,
    signature: edge.signature,
  });
}

// Only traverse a link once its signature binds the next key and device ID.
// A breadth-first search carries one whole path, even when it follows unrelated rows.
function approvalPath(
  accountId: string,
  self: { id: string; public_key: string },
  edges: Edge[],
  anchors: Step[],
  signal: AbortSignal,
) {
  const queue = [...anchors];
  const visited = new Set<string>();
  for (const step of queue) {
    if (signal.aborted) return null;
    const device = JSON.stringify([step.key, step.id]);
    if (visited.has(device) || step.path.length === MAX_CHAIN_EDGES) continue;
    visited.add(device);
    for (const edge of edges) {
      if (edge.endorser_public_key !== step.key || (step.id && edge.endorser_device_id !== step.id))
        continue;
      if (!verifies(accountId, step.key, edge)) continue;
      const path = [...step.path, edge];
      if (edge.endorsed_public_key === self.public_key) {
        if (edge.endorsed_device_id === self.id) return path;
      } else {
        queue.push({ key: edge.endorsed_public_key, id: edge.endorsed_device_id, path });
      }
    }
  }
  return null;
}

// undefined means the owner can tap to check an approval missing from the cache.
export async function supportLogDevice(
  client: QueryClient,
  accountId: string,
  signal: AbortSignal,
  allowFetch: boolean,
) {
  const registration = client
    .getQueryCache()
    .find<RegisteredPhone>({ queryKey: qk.browserDeviceRegistration(accountId) });
  const local = registration?.state.data ?? (await registration?.promise);
  if (
    !local ||
    local.revoked_at ||
    local.is_root ||
    accountId !== activeDeviceIdentityAccount() ||
    signal.aborted
  )
    return null;
  const key = await deviceIdentity.publicKey();
  if (!key || encodeBase64Url(key) !== local.public_key || signal.aborted) return null;

  // Auth resets these queries on account changes. Use them only for the active owner.
  const cached =
    client.getQueryData<MeResponse>(qk.me())?.user.id === accountId
      ? client.getQueryState<Edge[]>(qk.trustAccountEndorsements())
      : undefined;
  const edges =
    (!cached?.isInvalidated && cached?.data) ||
    (allowFetch ? await listAccountEndorsements() : undefined);
  if (signal.aborted) return null;
  if (!edges) return undefined;
  // The reciprocal half of the number check is durable proof of which peer
  // keys this phone approved. Authenticate it with the phone's OWN key.
  const anchors: Step[] = edges
    .filter(
      (e) =>
        e.endorser_device_id === local.id &&
        e.endorser_public_key === local.public_key &&
        verifies(accountId, local.public_key, e),
    )
    .map((e) => ({ key: e.endorsed_public_key, id: e.endorsed_device_id, path: [] }));
  const path = approvalPath(accountId, local, edges, anchors, signal);
  if (!path || signal.aborted) return null;
  const carried = path.map(
    ({ endorser_public_key, endorsed_public_key, endorsed_device_id, signature }) => ({
      account_id: accountId,
      endorser_public_key,
      endorsed_public_key,
      endorsed_device_id,
      signature,
    }),
  );
  return async (enabled: boolean, fresh: SupportLogState): Promise<SignedSupportLogConsent> => {
    const issued_at_ms = checkedConsentTime(fresh.next_issued_at_ms);
    if (
      issued_at_ms <=
      Math.max(fresh.statement?.issued_at_ms ?? -1, lastSigned.get(local.public_key) ?? -1)
    )
      throw new Error("Consent time did not advance");
    // Reserve before yielding to the device signer.
    lastSigned.set(local.public_key, issued_at_ms);
    const statement = {
      version: 1 as const,
      account_id: accountId,
      signer_device_id: local.id,
      signer_public_key: local.public_key,
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
