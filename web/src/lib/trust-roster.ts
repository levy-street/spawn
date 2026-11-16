/**
 * The device/endorsement roster (docs/TRUST_DEVICE_MESH.md R4).
 *
 * A compromised trusted device is a mesh-wide rogue CA; the realistic defense
 * is DETECTION — a visible, audited roster of who vouched for whom — plus fast
 * revocation. These helpers compute what the roster shows from server-claimed
 * data, so everything here is ADVISORY: badges and warnings, never admission
 * (the daemon decides admission by re-verifying signatures against its own
 * anchors). A hostile server can lie here to make a device LOOK trusted, but
 * that lie changes nothing at any door.
 */

import type { HostPinUndeliveredReason } from "./api";

/**
 * Where one host stands on one recorded approval (a pin). This is a property
 * of the HOST, kept apart from whether the account approved the device at all
 * (#138): a host that has not taken an approval in is a host with a problem,
 * shown where that host is shown ("Not delivered" on its page), never a reason
 * to ask the device to be approved again.
 *
 * - `confirmed` — the host acknowledged the pin, or has not answered yet (the
 *   server reports a pin no host has nacked as delivered).
 * - `unconfirmed` — the host nacked it for a reason that says nothing against
 *   the approval itself. `other`: a local failure on the host — a reconcile
 *   that could not run nacks every pin it was sent, including ones the host
 *   already holds and still admits — or the same key already held under
 *   another id. `pin_limit`: the host verified the approval and had no room
 *   (its page and the toast name the fix: remove old devices).
 * - `rejected` — `invalid_chain`: the host checked the approval and could not
 *   verify it (bad signature, an endorser it does not trust, a malformed
 *   record). Such a record proves nothing, so it counts as absent.
 */
export type PinStanding = "confirmed" | "unconfirmed" | "rejected";

export interface PinDeliveryRecord {
  readonly browser_device_id: string;
  readonly delivered: boolean;
  readonly undelivered_reason: HostPinUndeliveredReason | null;
}

export function pinStanding(pin: Omit<PinDeliveryRecord, "browser_device_id">): PinStanding {
  // Every reason the server can record, each decided on its own; a new one
  // fails to compile here rather than falling into either bucket by default.
  switch (pin.undelivered_reason) {
    case "invalid_chain":
      return "rejected";
    case "pin_limit":
    case "other":
      return "unconfirmed";
    case null:
      return pin.delivered ? "confirmed" : "unconfirmed";
  }
}

export interface HostPinMap {
  /** Per host, the devices whose pin it has confirmed: what it admits today. */
  readonly byHost: Map<string, string[]>;
  /** Per device, the hosts that have confirmed its pin. */
  readonly byDevice: Map<string, string[]>;
  /** Devices whose pin on some host stands as the account's approval —
   * confirmed by that host or not yet. The roster's anchors. */
  readonly anchorDeviceIds: Set<string>;
}

/**
 * Splits the pins every host reports into the two questions they answer:
 * which devices a given host admits today (confirmed pins only), and which
 * devices the account has approved (every pin that is not rejected).
 */
export function hostPinMap(
  entries: readonly (readonly [string, readonly PinDeliveryRecord[]])[],
): HostPinMap {
  const byHost = new Map<string, string[]>();
  const byDevice = new Map<string, string[]>();
  const anchorDeviceIds = new Set<string>();
  for (const [hostId, pins] of entries) {
    const confirmed: string[] = [];
    for (const pin of pins) {
      const standing = pinStanding(pin);
      if (standing === "rejected") continue;
      anchorDeviceIds.add(pin.browser_device_id);
      if (standing !== "confirmed") continue;
      confirmed.push(pin.browser_device_id);
      byDevice.set(pin.browser_device_id, [...(byDevice.get(pin.browser_device_id) ?? []), hostId]);
    }
    byHost.set(hostId, confirmed);
  }
  return { byHost, byDevice, anchorDeviceIds };
}

export interface RosterDevice {
  readonly id: string;
  readonly revoked_at: string | null;
  readonly is_root: boolean;
}

export interface RosterEdge {
  readonly endorser_device_id: string;
  readonly endorsed_device_id: string;
}

export interface DeviceTrustSummary {
  /** Live devices holding a live endorsement edge to this device. */
  readonly vouchedForBy: readonly string[];
  /** Reachable from an anchor over live edges (advisory chain coverage). */
  readonly chainTrusted: boolean;
  /** Directly endorsed by the live account root (a length-1 chain). */
  readonly rootChild: boolean;
}

/**
 * Device ids reachable from `anchorIds` over live→live edges — the client-side
 * mirror of the daemon's chain search from one host's pins (mesh §3), so a
 * surface can tell whether a device would be admitted through a chain. Only
 * live anchors seed the walk: a revoked pin grants nothing.
 */
export function chainReachableFrom(
  anchorIds: Iterable<string>,
  devices: readonly Pick<RosterDevice, "id" | "revoked_at">[],
  edges: readonly RosterEdge[],
): Set<string> {
  const live = new Set(devices.filter((d) => d.revoked_at === null).map((d) => d.id));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!live.has(edge.endorser_device_id) || !live.has(edge.endorsed_device_id)) continue;
    outgoing.set(edge.endorser_device_id, [
      ...(outgoing.get(edge.endorser_device_id) ?? []),
      edge.endorsed_device_id,
    ]);
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const id of anchorIds) {
    if (live.has(id) && !reachable.has(id)) {
      reachable.add(id);
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const from = queue.shift() as string;
    for (const to of outgoing.get(from) ?? []) {
      if (!reachable.has(to)) {
        reachable.add(to);
        queue.push(to);
      }
    }
  }
  return reachable;
}

/**
 * The hosts that would admit `deviceId` today, and therefore the hosts an
 * endorsement signed by it can cover: every host that pins it directly, plus —
 * on hosts whose daemons validate account chains (mesh §3) — every host one of
 * whose pins reaches it through live account endorsements. Advisory like the
 * rest of this file; the daemon decides at the door.
 */
export function hostsTrustingDevice<H extends { id: string; supports_account_chains?: boolean }>(
  deviceId: string,
  hostList: readonly H[],
  pinsByHost: ReadonlyMap<string, readonly string[]>,
  devices: readonly Pick<RosterDevice, "id" | "revoked_at">[],
  edges: readonly RosterEdge[],
): H[] {
  return hostList.filter((host) => {
    const pins = pinsByHost.get(host.id) ?? [];
    if (pins.includes(deviceId)) return true;
    if (host.supports_account_chains !== true) return false;
    return chainReachableFrom(pins, devices, edges).has(deviceId);
  });
}

/**
 * Per-device trust summaries from the endorsement graph: has the ACCOUNT
 * approved this device? (The session gate's and the Access roster's question.)
 *
 * Anchors are what the account has recorded: the live root plus every live
 * device whose pin on some host stands as an approval (`hostPinMap`'s
 * `anchorDeviceIds` — confirmed by that host or not yet, never rejected).
 * Whether one particular host has taken the approval in is that host's state,
 * not the device's. Reachability walks live→live edges only — an edge from a
 * revoked device grants nothing, exactly like the daemon's `RevocationSet`
 * subtraction, and a revoked anchor seeds nothing.
 */
export function computeTrustRoster(
  devices: readonly RosterDevice[],
  edges: readonly RosterEdge[],
  anchorDeviceIds: ReadonlySet<string>,
): Map<string, DeviceTrustSummary> {
  const live = new Map(devices.filter((d) => d.revoked_at === null).map((d) => [d.id, d]));
  const liveRoot = devices.find((d) => d.is_root && d.revoked_at === null) ?? null;

  const vouchers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!live.has(edge.endorser_device_id) || !live.has(edge.endorsed_device_id)) continue;
    const set = vouchers.get(edge.endorsed_device_id) ?? new Set<string>();
    set.add(edge.endorser_device_id);
    vouchers.set(edge.endorsed_device_id, set);
  }

  const reachable = chainReachableFrom(
    [...live.values()].filter((d) => d.is_root || anchorDeviceIds.has(d.id)).map((d) => d.id),
    devices,
    edges,
  );

  const summaries = new Map<string, DeviceTrustSummary>();
  for (const device of devices) {
    const vouchedForBy = [...(vouchers.get(device.id) ?? [])];
    summaries.set(device.id, {
      vouchedForBy,
      chainTrusted: reachable.has(device.id),
      rootChild: liveRoot !== null && vouchedForBy.includes(liveRoot.id),
    });
  }
  return summaries;
}

/**
 * Hosts whose entire live pin set is this one device (mesh R5): revoking it
 * orphans them — every chain must pass the revoked anchor — until the host is
 * re-paired or healed onto the root. Surfaced as a warning before revocation.
 */
export function hostsSolelyTrustedBy(
  deviceId: string,
  pinsByHost: ReadonlyMap<string, readonly string[]>,
): string[] {
  const orphaned: string[] = [];
  for (const [hostId, deviceIds] of pinsByHost) {
    if (deviceIds.length === 1 && deviceIds[0] === deviceId) orphaned.push(hostId);
  }
  return orphaned;
}

/**
 * The fail-closed gate on the remove dialog's "stays reachable" promise
 * (P-C7 / the field bug): after the pre-removal passkey step, an at-risk host
 * counts as protected ONLY if the heal verifiably upgraded it this run
 * (`upgradedHostIds` — this device signed the statement and the server
 * accepted it) or its REFRESHED, liveness-filtered pin list already shows the
 * root anchor. Everything else stays at risk, and the caller must withdraw
 * the promise rather than proceed on it. A null report (the heal never ran)
 * protects nothing.
 *
 * Both inputs are advisory server data used in the DENY direction only: a
 * lying server can make this gate refuse the promise (the honest dialog
 * appears; removal stays possible as "Remove anyway"), never manufacture it —
 * the promise additionally requires ids the heal itself reported.
 */
export function unprotectedOrphanHostIds(
  atRiskHostIds: readonly string[],
  report: { upgradedHostIds: readonly string[] } | null,
  refreshedPinsByHost: ReadonlyMap<string, readonly string[]>,
  rootDeviceId: string | null,
): string[] {
  const upgraded = new Set(report?.upgradedHostIds ?? []);
  return atRiskHostIds.filter((hostId) => {
    if (upgraded.has(hostId)) return false;
    if (rootDeviceId === null) return true;
    const pins = refreshedPinsByHost.get(hostId);
    return pins === undefined || !pins.includes(rootDeviceId);
  });
}
