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
 * Per-device trust summaries from the endorsement graph.
 *
 * Anchors approximate the daemon's view: the live root plus every live device
 * that holds at least one per-host pin. Reachability walks live→live edges
 * only — an edge from a revoked device grants nothing, exactly like the
 * daemon's `RevocationSet` subtraction.
 */
export function computeTrustRoster(
  devices: readonly RosterDevice[],
  edges: readonly RosterEdge[],
  pinnedDeviceIds: ReadonlySet<string>,
): Map<string, DeviceTrustSummary> {
  const live = new Map(devices.filter((d) => d.revoked_at === null).map((d) => [d.id, d]));
  const liveRoot = devices.find((d) => d.is_root && d.revoked_at === null) ?? null;

  const liveEdges = edges.filter(
    (e) => live.has(e.endorser_device_id) && live.has(e.endorsed_device_id),
  );
  const outgoing = new Map<string, string[]>();
  const vouchers = new Map<string, Set<string>>();
  for (const edge of liveEdges) {
    outgoing.set(edge.endorser_device_id, [
      ...(outgoing.get(edge.endorser_device_id) ?? []),
      edge.endorsed_device_id,
    ]);
    const set = vouchers.get(edge.endorsed_device_id) ?? new Set<string>();
    set.add(edge.endorser_device_id);
    vouchers.set(edge.endorsed_device_id, set);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const device of live.values()) {
    if (device.is_root || pinnedDeviceIds.has(device.id)) {
      reachable.add(device.id);
      queue.push(device.id);
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
