/**
 * Access-screen view derivation (docs/TRUST_UX.md).
 *
 * Pure functions from server records (devices, endorsement edges, hosts, pin
 * details, passkeys) to the view models the trust-ux components render. All
 * display, no authorization: every rule here can be wrong without a single
 * trust decision changing, because admission stays daemon-side.
 *
 * Vocabulary discipline lives here too — this is the one place raw mesh
 * concepts (roots, endorsements, pins) are translated into the screen's words
 * (approved, possessed, signed in with passkey), so nothing below this module
 * needs to know the banned list.
 */

import type { DeviceVM, HostVM, TrustEventVM } from "@/trust-ux/types";

// Structural subsets of the api.ts types, so derivation stays testable with
// plain literals and never accidentally depends on transport details.
export interface AccessDevice {
  id: string;
  label: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by_device_id: string | null;
  is_root: boolean;
}

/** One account-scoped endorsement edge (mesh §3). */
export interface AccessEdge {
  endorser_device_id: string;
  endorsed_device_id: string;
  created_at: string;
}

export interface AccessHost {
  id: string;
  name: string;
  status: "online" | "offline";
}

export interface AccessPinDetail {
  device_id: string;
  direct: boolean;
  created_at: string;
}

export interface AccessPasskey {
  id: string;
  created_at: string;
}

export interface AccessViewInput {
  devices: AccessDevice[];
  edges: AccessEdge[];
  hosts: AccessHost[];
  /** host id → its pin records; hosts whose fetch failed may simply be absent. */
  pinDetails: ReadonlyMap<string, AccessPinDetail[]>;
  passkeys: AccessPasskey[];
  /** The signing identity of the browser doing the rendering. */
  currentDeviceId: string | null;
}

export interface AccessView {
  devices: DeviceVM[];
  hosts: HostVM[];
  history: TrustEventVM[];
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

function parse(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** "Jun 3", or "Jun 3, 2025" once the year stops being obvious. */
export function shortDate(iso: string, now: Date): string {
  const d = new Date(parse(iso));
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const base = `${month} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}

/** "Now" | "12m ago" | "3h ago" | "Jun 12" — the roster's Seen column. */
export function seenLabel(iso: string | null, now: Date): string {
  if (iso === null) return "—";
  const age = now.getTime() - parse(iso);
  if (age < 2 * MINUTE) return "Now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < 24 * HOUR) return `${Math.floor(age / HOUR)}h ago`;
  return shortDate(iso, now);
}

/** "Signed in just now" | "Signed in 2 minutes ago" — the waiting row's line. */
function signedInLabel(iso: string, now: Date): string {
  const age = now.getTime() - parse(iso);
  if (age < MINUTE) return "Signed in just now";
  if (age < HOUR) {
    const m = Math.floor(age / MINUTE);
    return `Signed in ${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (age < 24 * HOUR) {
    const h = Math.floor(age / HOUR);
    return `Signed in ${h} hour${h === 1 ? "" : "s"} ago`;
  }
  return `Signed in ${shortDate(iso, now)}`;
}

export function deviceDisplayName(device: Pick<AccessDevice, "label">): string {
  return device.label ?? "Unnamed device";
}

/** Two kinds only; a wrong guess costs an icon, nothing more. */
function deviceKind(name: string): DeviceVM["kind"] {
  return /iphone|ipad|android|pixel|phone|tablet/iu.test(name) ? "phone" : "laptop";
}

function liveNonRoot(devices: AccessDevice[]): AccessDevice[] {
  return devices.filter((d) => d.revoked_at === null && !d.is_root);
}

function rootIds(devices: AccessDevice[]): Set<string> {
  return new Set(devices.filter((d) => d.is_root).map((d) => d.id));
}

/** Earliest-created live device: the account's "First device" row. */
function firstDeviceId(devices: AccessDevice[]): string | null {
  let first: AccessDevice | null = null;
  for (const d of liveNonRoot(devices)) {
    if (first === null || parse(d.created_at) < parse(first.created_at)) first = d;
  }
  return first?.id ?? null;
}

export function deriveDeviceVMs(input: AccessViewInput, now: Date): DeviceVM[] {
  const roots = rootIds(input.devices);
  const nameOf = new Map(input.devices.map((d) => [d.id, deviceDisplayName(d)]));
  const firstId = firstDeviceId(input.devices);

  // Earliest inbound edge per device — the original provenance. Later edges
  // (a retrofit heal, a second approver) never rewrite where a device came from.
  const inbound = new Map<string, AccessEdge>();
  for (const e of input.edges) {
    if (roots.has(e.endorsed_device_id)) continue;
    const prior = inbound.get(e.endorsed_device_id);
    if (prior === undefined || parse(e.created_at) < parse(prior.created_at)) {
      inbound.set(e.endorsed_device_id, e);
    }
  }

  // Earliest pin per device, for pre-mesh devices that were trusted before
  // approvals were recorded as edges.
  const earliestPin = new Map<string, string>();
  for (const pins of input.pinDetails.values()) {
    for (const pin of pins) {
      const prior = earliestPin.get(pin.device_id);
      if (prior === undefined || parse(pin.created_at) < parse(prior)) {
        earliestPin.set(pin.device_id, pin.created_at);
      }
    }
  }

  const vms = liveNonRoot(input.devices).map((d): DeviceVM => {
    const name = deviceDisplayName(d);
    const edge = inbound.get(d.id);
    let provenance: string;
    let waiting = false;
    if (d.id === firstId) {
      provenance = "First device";
    } else if (edge !== undefined) {
      provenance = roots.has(edge.endorser_device_id)
        ? `Signed in with passkey · ${shortDate(edge.created_at, now)}`
        : `Approved by ${nameOf.get(edge.endorser_device_id) ?? "a removed device"} · ${shortDate(edge.created_at, now)}`;
    } else {
      const pinned = earliestPin.get(d.id);
      if (pinned !== undefined) {
        provenance = `Trusted since ${shortDate(pinned, now)}`;
      } else {
        // Signed in, not approved, reaches nothing: the waiting row (R4 made
        // visible — a stranger's sign-in appears here the moment it happens).
        provenance = signedInLabel(d.created_at, now);
        waiting = true;
      }
    }
    return {
      id: d.id,
      name,
      kind: deviceKind(name),
      isThisDevice: d.id === input.currentDeviceId || undefined,
      provenance,
      lastSeen: seenLabel(d.last_seen_at ?? d.created_at, now),
      waiting: waiting || undefined,
    };
  });

  // This device first, then waiting rows (they carry the screen's one call to
  // action), then by recency of first sight.
  return vms.sort((a, b) => {
    if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
    if ((a.waiting ?? false) !== (b.waiting ?? false)) return a.waiting ? -1 : 1;
    return 0;
  });
}

export function deriveHostVMs(input: AccessViewInput, now: Date): HostVM[] {
  const nameOf = new Map(input.devices.map((d) => [d.id, deviceDisplayName(d)]));
  return input.hosts.map((host): HostVM => {
    let possess: AccessPinDetail | null = null;
    for (const pin of input.pinDetails.get(host.id) ?? []) {
      if (!pin.direct) continue;
      if (possess === null || parse(pin.created_at) < parse(possess.created_at)) possess = pin;
    }
    return {
      id: host.id,
      name: host.name,
      provenance:
        possess === null
          ? ""
          : `Possessed by ${nameOf.get(possess.device_id) ?? "a removed device"} · ${shortDate(possess.created_at, now)}`,
      online: host.status === "online",
    };
  });
}

export function deriveTrustEvents(input: AccessViewInput, now: Date): TrustEventVM[] {
  const roots = rootIds(input.devices);
  const nameOf = new Map(input.devices.map((d) => [d.id, deviceDisplayName(d)]));
  const named = (id: string) => nameOf.get(id) ?? "A removed device";
  const events: Array<TrustEventVM & { at: number }> = [];

  // The approve ceremony records a MUTUAL endorsement: the approver's edge
  // first, the new device's reciprocal seconds later. One human action, one
  // history line — the reciprocal (the strictly later reverse edge) is the
  // same event, not a second approval.
  const earliestByPair = new Map<string, number>();
  for (const e of input.edges) {
    const key = `${e.endorser_device_id}→${e.endorsed_device_id}`;
    const at = parse(e.created_at);
    const prior = earliestByPair.get(key);
    if (prior === undefined || at < prior) earliestByPair.set(key, at);
  }
  const isReciprocal = (e: AccessEdge): boolean => {
    const reverse = earliestByPair.get(`${e.endorsed_device_id}→${e.endorser_device_id}`);
    return reverse !== undefined && reverse < parse(e.created_at);
  };

  for (const e of input.edges) {
    if (roots.has(e.endorsed_device_id)) continue;
    if (isReciprocal(e)) continue;
    events.push(
      roots.has(e.endorser_device_id)
        ? {
            id: `passkey-signin:${e.endorsed_device_id}:${e.created_at}`,
            text: `${named(e.endorsed_device_id)} signed in with passkey`,
            when: shortDate(e.created_at, now),
            kind: "passkey",
            at: parse(e.created_at),
          }
        : {
            id: `approved:${e.endorsed_device_id}:${e.created_at}`,
            text: `${named(e.endorser_device_id)} approved ${named(e.endorsed_device_id)}`,
            when: shortDate(e.created_at, now),
            kind: "approved",
            at: parse(e.created_at),
          },
    );
  }

  for (const host of input.hosts) {
    for (const pin of input.pinDetails.get(host.id) ?? []) {
      if (!pin.direct) continue;
      events.push({
        id: `possessed:${host.id}:${pin.device_id}`,
        text: `${named(pin.device_id)} possessed ${host.name}`,
        when: shortDate(pin.created_at, now),
        kind: "approved",
        at: parse(pin.created_at),
      });
    }
  }

  for (const d of input.devices) {
    if (d.revoked_at === null || d.is_root) continue;
    const by = d.revoked_by_device_id === null ? "" : ` by ${named(d.revoked_by_device_id)}`;
    events.push({
      id: `removed:${d.id}`,
      text: `${deviceDisplayName(d)} removed${by}`,
      when: shortDate(d.revoked_at, now),
      kind: "removed",
      at: parse(d.revoked_at),
    });
  }

  for (const p of input.passkeys) {
    events.push({
      id: `passkey-added:${p.id}`,
      text: "Passkey added",
      when: shortDate(p.created_at, now),
      kind: "passkey",
      at: parse(p.created_at),
    });
  }

  events.sort((a, b) => b.at - a.at);
  return events.map(({ at: _at, ...vm }) => vm);
}

export function deriveAccessView(input: AccessViewInput, now: Date): AccessView {
  return {
    devices: deriveDeviceVMs(input, now),
    hosts: deriveHostVMs(input, now),
    history: deriveTrustEvents(input, now),
  };
}
