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

// Corroboration for a claimed root revocation (hardening B2) lives in
// root-revocation.ts so the root-introduction rotation acceptance shares the
// exact rule without an import cycle; re-exported here for its callers.
export { assessSealedRootRevocation } from "./root-revocation";

/**
 * Choose which server roster row (if any) to revoke as "the account root",
 * trusting only the FIRSTHAND `pk_R` read from the sealed bundle (hardening
 * B3). The server's `is_root` labeling is never sufficient on its own: a row
 * must carry the sealed root's exact public key to be revoked. Returns the row
 * to revoke, or null with a human-readable reason when the revoke must be
 * skipped loudly (`reason === null` means there was simply nothing to revoke).
 */
export function selectSealedRootRowForRevocation(
  sealedRootPublicKey: string | null,
  devices: readonly {
    id: string;
    public_key: string;
    revoked_at: string | null;
    is_root: boolean;
  }[],
): {
  row: { id: string; public_key: string } | null;
  reason: string | null;
} {
  const liveRoots = devices.filter((d) => d.is_root && d.revoked_at === null);
  if (sealedRootPublicKey === null) {
    return liveRoots.length === 0
      ? { row: null, reason: null }
      : {
          row: null,
          reason:
            "The server lists an account root, but your passkey bundle holds none — " +
            "that key was not verified here, so it was left untouched.",
        };
  }
  const match = liveRoots.find((d) => d.public_key === sealedRootPublicKey);
  if (match !== undefined) {
    return { row: { id: match.id, public_key: match.public_key }, reason: null };
  }
  return liveRoots.length === 0
    ? { row: null, reason: null }
    : {
        row: null,
        reason:
          "The server's account root does not match the root sealed in your trust bundle, " +
          "so it was not revoked on the server's word.",
      };
}

export interface RefusedHealHost {
  readonly hostId: string;
  readonly reason: string;
}

export interface AccountHealReport {
  readonly rootDeviceId: string;
  /** This device's roster row id, when its key is registered and live. */
  readonly currentDeviceId: string | null;
  /** Devices that received a fresh `R→d` endorsement in this heal. */
  readonly endorsedDeviceIds: readonly string[];
  /** Devices whose `R→d` endorsement FAILED — isolated per statement, so one
   * failure never aborts the rest of the loop or the anchor half. */
  readonly failedEndorsementDeviceIds: readonly string[];
  /** Host ids that accepted a root anchor-upgrade endorsement this heal. */
  readonly upgradedHostIds: readonly string[];
  /** Host ids that refused or failed one, with the reason (e.g. this device
   * is not pinned there — the 409 gate). */
  readonly refusedHosts: readonly RefusedHealHost[];
  /** Whether this device's own `R→d` edge exists AFTER the heal, verified
   * against re-fetched edges with the same signature discipline as
   * `planAccountHeal`. Null when this device has no live roster row to
   * verify. The unlock flow's honesty gate: "approved" may only be claimed
   * when this is true. */
  readonly rootEndorsedSelf: boolean | null;
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
  const registered = await browserDevices.register({
    key_algorithm: "ed25519",
    public_key: root.publicKeyWire,
    signature: await createRootRegistrationProof(root, accountId),
    label: "Account root",
    is_root: true,
  });
  // Verify the row the server answered with is the row that was submitted
  // (hardening B3): a response naming another key or dropping the root mark
  // means the roster does NOT hold pk_R as the root, and healing on top of
  // that would endorse and anchor against a substituted row. Abort loudly.
  if (
    registered.public_key !== root.publicKeyWire ||
    registered.is_root !== true ||
    registered.revoked_at !== null
  ) {
    throw new AccountHealError(
      "root_conflict",
      "the server did not record the account root as submitted",
    );
  }
}

/**
 * The union of the sealed bundle's hosts and this device's ACTIVE local pins,
 * for the heal's anchor-upgrade loop. Both inputs are FIRSTHAND: the bundle
 * was passkey-unsealed (or is the mint-time pin snapshot), and a local pin
 * exists only because THIS device verified the host key out of band. Without
 * the union, a host possessed after the bundle was last sealed never gains
 * the root anchor at a passkey moment on this device — one half of the
 * "root anchored nowhere" field bug.
 */
export function unionHealHosts(
  bundleHosts: readonly TrustBundleHost[],
  localPins: readonly TrustBundleHost[],
): TrustBundleHost[] {
  const byKey = new Map<string, TrustBundleHost>();
  for (const host of [...bundleHosts, ...localPins]) {
    const existing = byKey.get(host.hostPublicKey);
    if (existing === undefined) {
      byKey.set(host.hostPublicKey, host);
      continue;
    }
    const hostIds = [...new Set([...existing.hostIds, ...host.hostIds])].sort();
    byKey.set(host.hostPublicKey, { ...existing, hostIds });
  }
  return [...byKey.values()];
}

/**
 * The heal's I/O seam, so per-statement isolation and the report are directly
 * testable against injected failures. Defaults to the real API.
 */
export interface AccountHealIo {
  listDevices(): Promise<readonly DeviceRow[]>;
  listEdges(): Promise<readonly EdgeRow[]>;
  createAccountEndorsement(body: {
    endorser_device_id: string;
    endorsed_device_id: string;
    signature: string;
  }): Promise<unknown>;
  endorse(body: {
    host_id: string;
    endorser_device_id: string;
    endorsed_device_id: string;
    signature: string;
  }): Promise<unknown>;
}

const defaultHealIo: AccountHealIo = {
  listDevices: () => browserDevices.list(),
  listEdges: () => trust.accountEndorsements(),
  createAccountEndorsement: (body) => trust.createAccountEndorsement(body),
  endorse: (body) => trust.endorse(body),
};

/**
 * Heal the whole account off `R`, then let `root` go out of scope — the caller
 * must not retain it. `identity` is this device's own signer for the per-host
 * anchor upgrades; hosts it is not pinned on simply refuse (reported, not
 * fatal). Device selection trusts nothing the server claims — see
 * `planAccountHeal`.
 *
 * Robustness contract (P-C2): every statement is isolated. One failed `R→d`
 * endorsement neither aborts the remaining endorsements nor skips the anchor
 * half; every outcome lands in the per-id report, and the caller decides what
 * counts as success (the unlock gates on `rootEndorsedSelf`).
 */
export async function healAccount(
  root: AccountRoot,
  accountId: string,
  identity: BrowserDeviceIdentity,
  hosts: readonly TrustBundleHost[],
  io: AccountHealIo = defaultHealIo,
): Promise<AccountHealReport> {
  const [devices, edges] = await Promise.all([io.listDevices(), io.listEdges()]);
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
  const failedEndorsementDeviceIds: string[] = [];
  for (const device of devicesToEndorse) {
    try {
      const signature = await createRootEndorsementProof(
        root,
        accountId,
        device.public_key,
        device.id,
      );
      await io.createAccountEndorsement({
        endorser_device_id: rootDevice.id,
        endorsed_device_id: device.id,
        signature,
      });
      endorsedDeviceIds.push(device.id);
    } catch {
      // Isolated: the next device's endorsement and the anchor loop still run.
      failedEndorsementDeviceIds.push(device.id);
    }
  }

  // Anchor upgrade: this device vouches for pk_R toward each host it is pinned
  // on. Idempotent server-side; a host that does not trust this device answers
  // 409 and is reported — it gains the root at another device's sweep or its
  // own possess/heal moment. This loop ALWAYS runs, whatever the endorsement
  // half did.
  const upgradedHostIds: string[] = [];
  const refusedHosts: RefusedHealHost[] = [];
  for (const host of hosts) {
    for (const hostId of host.hostIds) {
      if (currentDevice === null) {
        refusedHosts.push({
          hostId,
          reason: "this device's key is not registered with the account",
        });
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
        await io.endorse({
          host_id: hostId,
          endorser_device_id: currentDevice.id,
          endorsed_device_id: rootDevice.id,
          signature,
        });
        upgradedHostIds.push(hostId);
      } catch (cause) {
        refusedHosts.push({
          hostId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  // The honesty check: does this device's own R→d edge exist NOW? Verified
  // against a fresh fetch with the same signature discipline as the planner —
  // a server that merely echoed a 200 without storing (or a failed statement
  // above) reads as false here, and the unlock will not claim success on it.
  let rootEndorsedSelf: boolean | null = null;
  if (currentDevice !== null) {
    rootEndorsedSelf = false;
    try {
      const after = await io.listEdges();
      for (const edge of after) {
        if (
          edge.endorser_public_key === root.publicKeyWire &&
          edge.endorsed_public_key === currentDevice.public_key &&
          edge.endorsed_device_id === currentDevice.id &&
          (await verifyEdgeSignature(accountId, edge))
        ) {
          rootEndorsedSelf = true;
          break;
        }
      }
    } catch {
      // Unfetchable edges prove nothing; stay false (the honest default).
    }
  }

  return {
    rootDeviceId: rootDevice.id,
    currentDeviceId: currentDevice?.id ?? null,
    endorsedDeviceIds,
    failedEndorsementDeviceIds,
    upgradedHostIds,
    refusedHosts,
    rootEndorsedSelf,
  };
}
