/**
 * Advisory reachability over the account's endorsement graph (device mesh §3).
 *
 * A chain-capable host admits a device that is not directly pinned when the
 * device carries a chain of account endorsements from one of the host's
 * anchors (its live pins) down to its own key. This is the client-side mirror
 * of that search, computed from server-claimed rows: it decides what the app
 * shows and whether an offer is worth sending, never what a host admits — the
 * daemon re-verifies every signature against its own anchors. Same rules as
 * the web's trust roster: only edges whose endpoints are both live count, and
 * the walk is bounded like the daemon's chain length cap.
 */

/** Matches `DEFAULT_MAX_CHAIN_EDGES` in daemon/src/endorsement_chain.rs. */
export const MAX_CHAIN_EDGES = 8;

export interface ChainDevice {
  readonly id: string;
  readonly revoked_at: string | null;
}

export interface ChainEdge {
  readonly endorser_device_id: string;
  readonly endorsed_device_id: string;
}

function liveEdges<E extends ChainEdge>(devices: readonly ChainDevice[], edges: readonly E[]): E[] {
  const live = new Set(devices.filter((d) => d.revoked_at === null).map((d) => d.id));
  return edges.filter((e) => live.has(e.endorser_device_id) && live.has(e.endorsed_device_id));
}

/** Device ids reachable from `anchorIds` over live edges, within the length cap. */
export function chainReachableFrom(
  anchorIds: Iterable<string>,
  devices: readonly ChainDevice[],
  edges: readonly ChainEdge[],
  maxEdges = MAX_CHAIN_EDGES,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of liveEdges(devices, edges)) {
    outgoing.set(edge.endorser_device_id, [
      ...(outgoing.get(edge.endorser_device_id) ?? []),
      edge.endorsed_device_id,
    ]);
  }
  const reachable = new Set<string>(anchorIds);
  let frontier = [...reachable];
  for (let depth = 0; depth < maxEdges && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of outgoing.get(from) ?? []) {
        if (!reachable.has(to)) {
          reachable.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return reachable;
}

/**
 * The edges that can sit on some chain ending at `deviceId`: everything
 * upstream of it over live edges. What a device carries on an offer — the
 * rest of the account's graph can never help admit it, and the relay caps the
 * carried set, so pruning keeps a busy account under that cap without
 * dropping a usable path.
 */
export function edgesToward<E extends ChainEdge>(
  deviceId: string,
  devices: readonly ChainDevice[],
  edges: readonly E[],
  maxEdges = MAX_CHAIN_EDGES,
): E[] {
  const live = liveEdges(devices, edges);
  const incoming = new Map<string, E[]>();
  for (const edge of live) {
    incoming.set(edge.endorsed_device_id, [...(incoming.get(edge.endorsed_device_id) ?? []), edge]);
  }
  const kept = new Set<E>();
  const visited = new Set<string>([deviceId]);
  let frontier = [deviceId];
  for (let depth = 0; depth < maxEdges && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const to of frontier) {
      for (const edge of incoming.get(to) ?? []) {
        kept.add(edge);
        if (!visited.has(edge.endorser_device_id)) {
          visited.add(edge.endorser_device_id);
          next.push(edge.endorser_device_id);
        }
      }
    }
    frontier = next;
  }
  return live.filter((edge) => kept.has(edge));
}
