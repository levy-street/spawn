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
 * (approved, possessed, approved by your passkey), so nothing below this module
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
const STALE_DEVICE_MS = 60 * 24 * HOUR;

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

/** Live roster order from the Phase D contract: most recently seen first.
 * Missing/invalid timestamps are honest unknowns and sort last; creation time
 * only breaks ties, it never pretends the device was seen. */
export function sortLiveDevicesByLastSeen(devices: readonly AccessDevice[]): AccessDevice[] {
  return liveNonRoot([...devices]).sort((a, b) => {
    const aSeen = a.last_seen_at === null ? 0 : parse(a.last_seen_at);
    const bSeen = b.last_seen_at === null ? 0 : parse(b.last_seen_at);
    return bSeen - aSeen || parse(b.created_at) - parse(a.created_at) || a.id.localeCompare(b.id);
  });
}

/** Exact stale-device badge copy, beyond (not at) the 60-day boundary. */
export function staleDeviceLabel(lastSeenAt: string | null, now: Date): string | null {
  if (lastSeenAt === null) return null;
  const seenAt = Date.parse(lastSeenAt);
  if (Number.isNaN(seenAt) || now.getTime() - seenAt <= STALE_DEVICE_MS) return null;
  return `Not seen since ${shortDate(lastSeenAt, now)}`;
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

/**
 * id → display name, with the naming-layer defense (docs/TRUST_UX.md, small
 * rules): when two or more live devices share a name, every one after the
 * first — by first sign-in, so a device already in the roster always keeps
 * its bare name — gets a numbered suffix ("MacBook Pro (2)"), and no two
 * roster or history rows can read identically. Display-only, deliberately:
 * a rogue sign-in that copies an existing device's name is what this defends
 * against (R4), and creation order decides who wears the suffix, so the
 * newcomer can never push the suffix onto the device it imitates.
 */
export function deviceDisplayNames(devices: AccessDevice[]): Map<string, string> {
  const names = new Map(devices.map((d) => [d.id, deviceDisplayName(d)]));
  const groups = new Map<string, AccessDevice[]>();
  for (const d of liveNonRoot(devices)) {
    const base = deviceDisplayName(d);
    const group = groups.get(base);
    if (group === undefined) groups.set(base, [d]);
    else group.push(d);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byCreation = [...group].sort(
      (a, b) => parse(a.created_at) - parse(b.created_at) || (a.id < b.id ? -1 : 1),
    );
    for (const [i, d] of byCreation.entries()) {
      if (i > 0) names.set(d.id, `${deviceDisplayName(d)} (${i + 1})`);
    }
  }
  return names;
}

export function deriveDeviceVMs(input: AccessViewInput, now: Date): DeviceVM[] {
  const roots = rootIds(input.devices);
  const nameOf = deviceDisplayNames(input.devices);
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

  return sortLiveDevicesByLastSeen(input.devices).map((d): DeviceVM => {
    const name = nameOf.get(d.id) ?? deviceDisplayName(d);
    const edge = inbound.get(d.id);
    let provenance: string;
    let waiting = false;
    if (d.id === firstId) {
      provenance = "First device";
    } else if (edge !== undefined) {
      // A root-endorsed device says "approved by your passkey", never "signed
      // in with passkey" (R4 honesty): the R→d edge proves the passkey's
      // protection covered the device — minted either by an actual passkey
      // sign-in here or by the account-wide re-approval another device's
      // passkey use performs — and the view cannot tell those apart. Claiming
      // a sign-in the operator may never have made would teach them to
      // shrug at exactly the line a rogue passkey enrollment would produce.
      provenance = roots.has(edge.endorser_device_id)
        ? `Approved by your passkey · ${shortDate(edge.created_at, now)}`
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
      staleLabel: staleDeviceLabel(d.last_seen_at, now) ?? undefined,
      waiting: waiting || undefined,
    };
  });
}

export function deriveHostVMs(input: AccessViewInput, now: Date): HostVM[] {
  const nameOf = deviceDisplayNames(input.devices);
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
  const nameOf = deviceDisplayNames(input.devices);
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
        ? // Same honesty rule as the roster provenance above: an R→d edge is
          // the passkey's approval of the device, not evidence the device
          // itself performed a passkey sign-in.
          {
            id: `passkey-approved:${e.endorsed_device_id}:${e.created_at}`,
            text: `Your passkey approved ${named(e.endorsed_device_id)}`,
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
      text: `${named(d.id)} removed${by}`,
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
