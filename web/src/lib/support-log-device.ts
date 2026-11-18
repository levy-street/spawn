import type { QueryClient } from "@tanstack/react-query";
import { trust } from "./api";
import { verifyAccountEndorsementSignature } from "./approve-ceremony";
import { loadBrowserDeviceIdentity, signSupportLogConsent } from "./browser-device-identity";
import {
  type BrowserDeviceRegistrationState,
  browserDeviceRegistrationQueryKey,
  readBrowserDeviceRevocationMarker,
} from "./browser-device-registration";
import { browserHostPinServerOrigin } from "./browser-host-pins";
import { listPeerDeviceKeys } from "./peer-device-keys";
import { loadFirsthandRoot } from "./root-knowledge";
import type { SupportLogState } from "./support-log";
import { checkedConsentTime, type SignedSupportLogConsent } from "./support-log-consent";

type Edge = Awaited<ReturnType<typeof trust.accountEndorsements>>[number];
// Same admission limit as the phone and DEFAULT_MAX_CHAIN_EDGES in the daemon.
const MAX_CHAIN_EDGES = 8;

// Remember issued signatures even after a refusal or closing Account.
const lastSigned = new Map<string, number>();

type Step = { key: string; id?: string; path: Edge[] };

async function verifies(accountId: string, trustedKey: string, edge: Edge) {
  return verifyAccountEndorsementSignature({
    accountId,
    endorserPublicKey: trustedKey,
    endorsedPublicKey: edge.endorsed_public_key,
    endorsedDeviceId: edge.endorsed_device_id,
    signature: edge.signature,
  });
}

// Only traverse a link once its signature binds the next key and device ID.
// A breadth-first search carries one whole path, even when it follows unrelated rows.
async function approvalPath(
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
      if (signal.aborted) return null;
      if (edge.endorser_public_key !== step.key || (step.id && edge.endorser_device_id !== step.id))
        continue;
      if (!(await verifies(accountId, step.key, edge))) continue;
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
  const registration = client.getQueryCache().find<BrowserDeviceRegistrationState>({
    queryKey: browserDeviceRegistrationQueryKey(accountId),
  });
  const registered = registration?.state.data ?? (await registration?.promise);
  if (
    registered?.status !== "ready" ||
    readBrowserDeviceRevocationMarker(accountId) ||
    signal.aborted
  )
    return null;
  const local = registered.device;
  const identity = await loadBrowserDeviceIdentity(accountId);
  if (
    !identity ||
    identity.publicKeyWire !== local.public_key ||
    local.revoked_at ||
    local.is_root ||
    signal.aborted
  )
    return null;
  const scope = { accountId, origin: browserHostPinServerOrigin() };
  const [peers, root] = await Promise.all([listPeerDeviceKeys(scope), loadFirsthandRoot(scope)]);
  const anchors: Step[] = peers
    .filter((p) => p.publicKey !== local.public_key)
    .map((p) => ({ key: p.publicKey, id: p.deviceId, path: [] }));
  if (root && root.rootPublicKey !== local.public_key)
    anchors.push({ key: root.rootPublicKey, path: [] });
  if (!anchors.length || signal.aborted) return null;

  const cached = client.getQueryState<Edge[]>(["account-endorsements", accountId]);
  const edges =
    (!cached?.isInvalidated && cached?.data) ||
    (allowFetch ? await trust.accountEndorsements() : undefined);
  if (!edges) return undefined;
  const path = await approvalPath(accountId, local, edges, anchors, signal);
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
    if (signal.aborted || readBrowserDeviceRevocationMarker(accountId))
      throw new Error("Device unavailable");
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
