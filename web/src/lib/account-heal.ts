/**
 * Full-account heal off the root `R` (docs/TRUST_DEVICE_MESH.md §4, stage 5c).
 *
 * Runs at the two passkey moments — minting (passkey creation) and unlock — the
 * only times `sk_R` is legitimately in memory. It is a benign refresh, never an
 * admission: it re-roots trust the operator ALREADY established directly at `R`
 * so chains shrink to length 1 and revoking any single device leaves every
 * other device connected (P3′). "Already established" is ENFORCED, not assumed
 * (C1), against a fully malicious server: a device is endorsed off `R` only if
 * its KEY is reachable from a firsthand anchor — the sealed root, or this very
 * device (whose passkey gesture is the operator's check — TRUST_UX "additional
 * device, passkey" / recovery) — over SIGNATURE-VERIFIED live endorsement
 * edges, the client-side mirror of the daemon's `find_valid_chain`. Nothing
 * server-claimed can create reachability: a fabricated device row, a waiting
 * sign-in, a forged edge (bad signature, or a valid signature under a key
 * outside the verified graph), or a claimed pin membership all stay outside.
 * Such a device still needs its number-check ceremony (P4) — or its own
 * passkey moment — and the server never opens a door (P2). Siblings that hold
 * only host pins (no edges yet) heal themselves at their own passkey unlock.
 *
 * Two kinds of statement are produced:
 *
 * 1. `R→d` account endorsements for live devices that lack one — signed with
 *    `sk_R`, giving each device a length-1 chain to the root anchor.
 * 2. Per-host endorsements OF the root device — signed by THIS device's own
 *    identity (which the host already pins), telling each host to pin `pk_R`
 *    as an anchor. This reuses the existing pin-adoption statement
 *    (`SPAWN-BROWSER-ENDORSE-V1`): the daemon verifies the signature against a
 *    key it already trusts, so the server relays but can never forge it (P2).
 *    Host public keys come from the sealed bundle, never from the server.
 *
 * The caller supplies `pk_R` from a FIRSTHAND source — the mint it just
 * performed or the bundle it just unsealed — never from the server's device
 * list. The server's `is_root` row is cross-checked against it and a mismatch
 * aborts loudly: a substituted root must never be endorsed or anchored.
 */

import {
  type AccountRoot,
  createRootEndorsementProof,
  createRootRegistrationProof,
} from "./account-root";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { browserDevices, trust } from "./api";
import {
  type BrowserDeviceIdentity,
  createBrowserEndorsementProof,
} from "./browser-device-identity";
import {
  decodeBase64Url,
  ED25519_SIGNATURE_BYTES,
  importEd25519PublicKeyWire,
} from "./signed-signal";
import type { TrustBundleHost } from "./trust-bundle";

export class AccountHealError extends Error {
  constructor(
    readonly code: "root_conflict" | "root_unregistered",
    message: string,
  ) {
    super(message);
    this.name = "AccountHealError";
  }
}

/**
 * Corroborate a server claim that the SEALED root's key was revoked, before
 * anything destructive (rotation) acts on it (hardening B2).
 *
 * The mutable roster row alone is not evidence: a fabricated `revoked_at`
 * would trigger a rotation. So the claim must ALSO appear in the account's
 * permanent, add-only key tombstone table (`revoked_browser_keys`) — the
 * server can still lie, but only by committing the lie into permanent
 * deny-list state that irreversibly bans the key everywhere, a visible and
 * self-defeating commitment rather than a free roster edit. Any half-claim is
 * `uncorroborated`: the caller must NOT rotate, and should say so out loud.
 */
export function assessSealedRootRevocation(
  sealedRootPublicKey: string,
  devices: readonly { public_key: string; revoked_at: string | null }[],
  tombstonedKeys: readonly string[],
): "live" | "revoked" | "uncorroborated" {
  const rosterClaimsRevoked = devices.some(
    (d) => d.public_key === sealedRootPublicKey && d.revoked_at !== null,
  );
  const tombstoned = tombstonedKeys.includes(sealedRootPublicKey);
  if (rosterClaimsRevoked && tombstoned) return "revoked";
  if (!rosterClaimsRevoked && !tombstoned) return "live";
  return "uncorroborated";
}

export interface AccountHealReport {
  readonly rootDeviceId: string;
  /** Devices that received a fresh `R→d` endorsement in this heal. */
  readonly endorsedDeviceIds: readonly string[];
  /** Host rows that accepted a root anchor-upgrade endorsement. */
  readonly hostsUpgraded: number;
  /** Host rows that refused one (e.g. this device is not pinned there). */
  readonly hostsSkipped: number;
}

interface DeviceRow {
  readonly id: string;
  readonly public_key: string;
  readonly revoked_at: string | null;
  readonly is_root: boolean;
}

interface EdgeRow {
  readonly endorser_device_id: string;
  readonly endorser_public_key: string;
  readonly endorsed_device_id: string;
  readonly endorsed_public_key: string;
  readonly signature: string;
}

/**
 * Verify one server-claimed endorsement edge under its CLAIMED endorser key —
 * the same transcript both `createAccountEndorsementProof` (ceremony edges) and
 * `createRootEndorsementProof` (`R→d` edges) sign, mirroring
 * `verifyAccountEndorsementSignature` in approve-ceremony.ts (kept local: this
 * module must stay hook-free). Passing proves only that the HOLDER of
 * `endorser_public_key` signed it; whether that key is trusted is decided by
 * the key walk in `planAccountHeal`, never here. Any malformed field —
 * including a self-endorsement, which the transcript encoder refuses — fails
 * closed to `false`.
 */
async function verifyEdgeSignature(accountId: string, edge: EdgeRow): Promise<boolean> {
  try {
    const transcript = encodeAcctEndorsementTranscript(
      accountId,
      edge.endorser_public_key,
      edge.endorsed_public_key,
      edge.endorsed_device_id,
    );
    const ownedTranscript = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(ownedTranscript).set(transcript);
    const signature = decodeBase64Url(edge.signature, ED25519_SIGNATURE_BYTES);
    const ownedSignature = new ArrayBuffer(signature.byteLength);
    new Uint8Array(ownedSignature).set(signature);
    const key = await importEd25519PublicKeyWire(edge.endorser_public_key);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, ownedSignature, ownedTranscript);
  } catch {
    return false;
  }
}

/**
 * The pure planning half, separated so it is directly testable (async only for
 * WebCrypto signature verification — no I/O).
 *
 * `rootPublicKeyWire` and `selfPublicKeyWire` are the ONLY trust inputs taken
 * at face value, because both are FIRSTHAND: the root from the mint just
 * performed or the bundle just unsealed, self from this device's own keystore.
 * Everything else — device rows, edge rows — is server-claimed and must earn
 * its way in cryptographically:
 *
 * 1. Every edge is signature-verified under its claimed endorser key (the
 *    daemon's own admission transcript). A forged edge verifies false.
 * 2. Reachability walks KEYS, not device ids: an edge extends trust only when
 *    its endorser KEY is already trusted. An attacker edge that carries a
 *    valid signature under the attacker's own key while name-dropping a real
 *    device's id never fires, because the attacker's key is not in the graph.
 * 3. A key enters the walk only while it has a live (unrevoked) device row —
 *    the client-side mirror of the daemon's `RevocationSet` subtraction.
 *
 * Server pin-membership claims are deliberately NOT an anchor: they are not
 * firsthand-verifiable, and every legitimately-trusted device is covered
 * without them — root-children by their `R→d` edge, ceremony-admitted devices
 * by their verified chain, and pin-only siblings by their own passkey unlock.
 */
export async function planAccountHeal(
  accountId: string,
  rootPublicKeyWire: string,
  selfPublicKeyWire: string | null,
  devices: readonly DeviceRow[],
  edges: readonly EdgeRow[],
): Promise<{
  rootDevice: DeviceRow | null;
  currentDevice: DeviceRow | null;
  devicesToEndorse: DeviceRow[];
}> {
  // Cross-check EVERY live `is_root` row against the sealed `pk_R` (§4.1
  // provenance rule). One matching row is not enough: any OTHER live root row
  // would be an authority the operator never minted, so a substituted or
  // additional root must abort the heal loudly, never be endorsed or anchored.
  const liveRoots = devices.filter((d) => d.is_root && d.revoked_at === null);
  if (liveRoots.some((d) => d.public_key !== rootPublicKeyWire)) {
    throw new AccountHealError(
      "root_conflict",
      "the server's account root does not match the root sealed in your trust bundle",
    );
  }
  const liveRoot = liveRoots[0] ?? null;
  const currentDevice =
    selfPublicKeyWire === null
      ? null
      : (devices.find((d) => d.public_key === selfPublicKeyWire && d.revoked_at === null) ?? null);
  if (liveRoot === null) {
    return { rootDevice: null, currentDevice, devicesToEndorse: [] };
  }

  const verifiedEdges: EdgeRow[] = [];
  for (const edge of edges) {
    if (await verifyEdgeSignature(accountId, edge)) {
      verifiedEdges.push(edge);
    }
  }

  // Key walk from the firsthand anchors over verified edges. Endorsed keys are
  // admitted to the walk only while backed by a live non-root device row; a
  // revoked device's key never enters, so its edges never fire.
  const liveNonRootKeys = new Set(
    devices.filter((d) => !d.is_root && d.revoked_at === null).map((d) => d.public_key),
  );
  const edgesByEndorserKey = new Map<string, EdgeRow[]>();
  for (const edge of verifiedEdges) {
    const bucket = edgesByEndorserKey.get(edge.endorser_public_key) ?? [];
    bucket.push(edge);
    edgesByEndorserKey.set(edge.endorser_public_key, bucket);
  }
  const trustedKeys = new Set<string>([rootPublicKeyWire]);
  if (currentDevice !== null) {
    trustedKeys.add(currentDevice.public_key);
  }
  const queue = [...trustedKeys];
  while (queue.length > 0) {
    const fromKey = queue.shift() as string;
    for (const edge of edgesByEndorserKey.get(fromKey) ?? []) {
      const toKey = edge.endorsed_public_key;
      if (trustedKeys.has(toKey) || !liveNonRootKeys.has(toKey)) continue;
      trustedKeys.add(toKey);
      queue.push(toKey);
    }
  }

  // Skip devices the root already covers — judged only by VERIFIED root edges,
  // so a forged "R→d" row cannot suppress a legitimate re-endorsement. The
  // match binds both the row's key and id, exactly what a fresh proof signs.
  const alreadyEndorsed = new Set(
    verifiedEdges
      .filter((edge) => edge.endorser_public_key === rootPublicKeyWire)
      .map((edge) => `${edge.endorsed_device_id}\n${edge.endorsed_public_key}`),
  );
  const devicesToEndorse = devices.filter(
    (d) =>
      !d.is_root &&
      d.revoked_at === null &&
      // A non-root row wearing the root's own key is server mischief; the root
      // never endorses itself (the transcript encoder would refuse anyway).
      d.public_key !== rootPublicKeyWire &&
      trustedKeys.has(d.public_key) &&
      !alreadyEndorsed.has(`${d.id}\n${d.public_key}`),
  );
  return { rootDevice: liveRoot, currentDevice, devicesToEndorse };
}

/**
 * Register the root as this account's `is_root` browser device if it is not
 * registered yet. Idempotent by key: re-registering the same `pk_R` returns the
 * existing row. A DIFFERENT live root already present is a trust conflict —
 * surfaced, never papered over.
 */
export async function ensureRootRegistered(root: AccountRoot, accountId: string): Promise<void> {
  const devices = await browserDevices.list();
  const liveRoot = devices.find((d) => d.is_root && d.revoked_at === null);
  if (liveRoot !== undefined) {
    if (liveRoot.public_key !== root.publicKeyWire) {
      throw new AccountHealError(
        "root_conflict",
        "the server's account root does not match the root sealed in your trust bundle",
      );
    }
    return;
  }
  await browserDevices.register({
    key_algorithm: "ed25519",
    public_key: root.publicKeyWire,
    signature: await createRootRegistrationProof(root, accountId),
    label: "Account root",
    is_root: true,
  });
}

/**
 * Heal the whole account off `R`, then let `root` go out of scope — the caller
 * must not retain it. `identity` is this device's own signer for the per-host
 * anchor upgrades; hosts it is not pinned on simply refuse (counted, not fatal).
 * Device selection trusts nothing the server claims — see `planAccountHeal`.
 */
export async function healAccount(
  root: AccountRoot,
  accountId: string,
  identity: BrowserDeviceIdentity,
  bundleHosts: readonly TrustBundleHost[],
): Promise<AccountHealReport> {
  const [devices, edges] = await Promise.all([browserDevices.list(), trust.accountEndorsements()]);
  const { rootDevice, currentDevice, devicesToEndorse } = await planAccountHeal(
    accountId,
    root.publicKeyWire,
    identity.publicKeyWire,
    devices,
    edges,
  );
  if (rootDevice === null) {
    throw new AccountHealError(
      "root_unregistered",
      "the account root is not registered; run ensureRootRegistered first",
    );
  }

  const endorsedDeviceIds: string[] = [];
  for (const device of devicesToEndorse) {
    const signature = await createRootEndorsementProof(
      root,
      accountId,
      device.public_key,
      device.id,
    );
    await trust.createAccountEndorsement({
      endorser_device_id: rootDevice.id,
      endorsed_device_id: device.id,
      signature,
    });
    endorsedDeviceIds.push(device.id);
  }

  // Anchor upgrade: this device vouches for pk_R toward each host it is pinned
  // on. Idempotent server-side; a host that does not trust this device answers
  // 409 and is skipped — it gains the root at its own possess/heal moment.
  let hostsUpgraded = 0;
  let hostsSkipped = 0;
  for (const host of bundleHosts) {
    for (const hostId of host.hostIds) {
      if (currentDevice === null) {
        hostsSkipped += 1;
        continue;
      }
      try {
        const signature = await createBrowserEndorsementProof(
          identity,
          accountId,
          host.hostPublicKey,
          rootDevice.public_key,
          rootDevice.id,
        );
        await trust.endorse({
          host_id: hostId,
          endorser_device_id: currentDevice.id,
          endorsed_device_id: rootDevice.id,
          signature,
        });
        hostsUpgraded += 1;
      } catch {
        hostsSkipped += 1;
      }
    }
  }

  return { rootDeviceId: rootDevice.id, endorsedDeviceIds, hostsUpgraded, hostsSkipped };
}
