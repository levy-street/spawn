import type { Host, LegionDay, Session } from "@/lib/api";
import { isShellCommand } from "@/lib/sessions";

/**
 * Pure derivations for the legion — every machine you own and everything
 * running on it. The sidebar strip, the workspace tile, the full page and the
 * profile dialog all read the same rollups from here, so the number in the
 * corner of the sidebar can never disagree with the one on the page it opens.
 *
 * Nothing here fetches. The two queries the sidebar already polls (`hosts`,
 * `sessions`) are the whole input.
 */

/** Meter segments a capacity bar draws. Mirrors the daemon's `MAX_BUCKET`. */
export const METER_SEGMENTS = 5;

/** Host rows the sidebar strip shows before deferring to the full page. */
export const STRIP_HOST_LIMIT = 4;

export type LegionTone = "active" | "idle" | "offline";

/** One host with everything the strip, the tile and the page draw for it. */
export interface LegionHostRow {
  host: Host;
  /** Sessions on this host that have not exited. */
  live: number;
  /** Sessions here that want the operator: waiting on input, or dead. */
  attention: number;
  /** Sessions here producing output right now. */
  busy: number;
  /** What is running, most instances first — `claude ×2`, `cargo`. */
  running: RunningAgent[];
  /** The live sessions themselves, most urgent first — the hover card's list. */
  sessions: Session[];
  /** Presence and urgency folded into one dot tone. */
  tone: LegionTone;
  /** 0..5, or null when this daemon reports no capacity at all. */
  cpuBucket: number | null;
  memBucket: number | null;
}

export interface RunningAgent {
  command: string;
  count: number;
}

export interface LegionSummary {
  hosts: number;
  hostsOnline: number;
  /** Live sessions across every host. */
  sessions: number;
  attention: number;
  busy: number;
  /** Summed only over hosts that report a spec; see `reportsCapacity`. */
  cores: number;
  memoryBytes: number;
  /** True when at least one online host reports capacity. */
  hasCapacity: boolean;
  rows: LegionHostRow[];
}

function isLive(session: Session): boolean {
  return session.status !== "exited" && session.status !== "killed";
}

/**
 * Does this host tell us anything about its capacity? A daemon older than the
 * telemetry fields and one running with `SPAWND_NO_TELEMETRY` are deliberately
 * indistinguishable here, and both mean "draw nothing".
 */
export function reportsCapacity(host: Host): boolean {
  return host.cpu_cores !== null || host.memory_bytes !== null || host.cpu_bucket !== null;
}

/**
 * The dot beside a host: presence and activity, and deliberately nothing else.
 *
 * There is no "needs you" tone here. Attention is a *session* property and the
 * app already has places that raise it — the workspace rows, the alert socket,
 * the session dots inside this panel's hover card. Giving a host row a fourth
 * colour for it meant the same amber stood for two different conditions four
 * pixels apart, which taught nobody anything. A host is offline, working, or
 * quiet.
 */
export function hostTone(host: Host, sessions: Session[]): LegionTone {
  if (host.status !== "online") return "offline";
  if (sessions.some((session) => session.activity_state === "active")) return "active";
  return "idle";
}

/**
 * What is running on a host, collapsed to counts and ordered most-first.
 *
 * Shells are dropped: every session has one, so listing them would make every
 * host look identical and bury the thing you actually want to see. Ties break
 * alphabetically so the row does not reshuffle between polls.
 */
export function runningAgents(sessions: Session[]): RunningAgent[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!isLive(session)) continue;
    const command = session.foreground_command?.trim();
    if (!command || isShellCommand(command)) continue;
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));
}

/**
 * Sessions in the order a person wants to read them: whatever is waiting on
 * them, then whatever is working, then the rest by most recent activity.
 *
 * Unlike the host list, ordering here *is* allowed to move — this list is read
 * inside a hover card that was opened deliberately, not scanned in the
 * periphery, so putting the urgent thing first beats keeping rows still.
 */
export function orderSessions(sessions: Session[]): Session[] {
  const rank = (session: Session): number => {
    if (session.activity_state === "waiting") return 0;
    if (session.activity_state === "active") return 1;
    return 2;
  };
  return [...sessions].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const at = Date.parse(a.last_activity_at ?? a.started_at) || 0;
    const bt = Date.parse(b.last_activity_at ?? b.started_at) || 0;
    return bt - at;
  });
}

/**
 * Everything the legion surfaces draw, from the two lists the app already has.
 *
 * Ordering is deliberately *stable* rather than useful: online before offline,
 * then by name. Busiest-first would be more informative and would also move
 * rows under the cursor every few seconds, which is the wrong trade for
 * something that lives in the periphery and is clicked by muscle memory.
 */
export function summarizeLegion(hosts: Host[], sessions: Session[]): LegionSummary {
  const byHost = new Map<string, Session[]>();
  for (const session of sessions) {
    const existing = byHost.get(session.host_id);
    if (existing) existing.push(session);
    else byHost.set(session.host_id, [session]);
  }

  const rows = [...hosts]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map<LegionHostRow>((host) => {
      const all = byHost.get(host.id) ?? [];
      const live = all.filter(isLive);
      return {
        host,
        live: live.length,
        attention: all.filter(
          (session) =>
            session.activity_state === "waiting" ||
            session.status === "exited" ||
            session.status === "killed",
        ).length,
        busy: live.filter((session) => session.activity_state === "active").length,
        running: runningAgents(live),
        sessions: orderSessions(live),
        tone: hostTone(host, live),
        // An offline host's last reading is a stale reading, and the server
        // already withholds it. Belt and braces, because a live-looking meter
        // on a dead machine is worse than no meter.
        cpuBucket: host.status === "online" ? host.cpu_bucket : null,
        memBucket: host.status === "online" ? host.mem_bucket : null,
      };
    });

  const online = rows.filter((row) => row.host.status === "online");
  return {
    hosts: rows.length,
    hostsOnline: online.length,
    sessions: rows.reduce((total, row) => total + row.live, 0),
    attention: rows.reduce((total, row) => total + row.attention, 0),
    busy: rows.reduce((total, row) => total + row.busy, 0),
    cores: rows.reduce((total, row) => total + (row.host.cpu_cores ?? 0), 0),
    memoryBytes: rows.reduce((total, row) => total + (row.host.memory_bytes ?? 0), 0),
    hasCapacity: online.some((row) => reportsCapacity(row.host)),
    rows,
  };
}

/**
 * What the dot on a host row means, in words — the same three states the
 * colour encodes, so hovering never says something the dot did not.
 */
export function hostToneLabel(row: LegionHostRow): string {
  if (row.host.status !== "online") return `${row.host.name} is offline`;
  if (row.busy > 0) return `${row.busy} ${row.busy === 1 ? "session" : "sessions"} working`;
  if (row.live > 0) return `${row.live} ${row.live === 1 ? "session" : "sessions"}, all quiet`;
  return "Online, nothing running";
}

/**
 * The strip's one-line reading when it is collapsed. Attention first, because
 * it is the only part worth interrupting for; otherwise the shape of the day.
 */
export function summaryLine(summary: LegionSummary): string {
  if (summary.hosts === 0) return "No hosts yet";
  if (summary.attention > 0) return `${summary.attention} need you`;
  if (summary.busy > 0) {
    return `${summary.busy} working`;
  }
  if (summary.sessions > 0) {
    return `${summary.sessions} ${summary.sessions === 1 ? "session" : "sessions"} idle`;
  }
  return summary.hostsOnline > 0 ? "Quiet" : "All hosts offline";
}

/** "3 hosts · 7 sessions", the header's count. */
export function countsLabel(summary: LegionSummary): string {
  return `${summary.hostsOnline} · ${summary.sessions}`;
}

/**
 * Bytes as the shortest honest binary figure — "64 GB", "1.5 TB".
 *
 * One decimal only below 10, because "1.5 TB" carries information and
 * "1.53 TB" is noise in a 40px-wide column.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** "4h 12m", "3d 4h", "48s" — a duration at one useful resolution. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** A host's spec as one line: "12 cores · 64 GB · RTX 4090". */
export function specLine(host: {
  cpu_cores?: number | null;
  memory_bytes?: number | null;
  gpu?: string | null;
}): string | null {
  const parts: string[] = [];
  if (host.cpu_cores) parts.push(`${host.cpu_cores} ${host.cpu_cores === 1 ? "core" : "cores"}`);
  const memory = formatBytes(host.memory_bytes);
  if (memory) parts.push(memory);
  if (host.gpu) parts.push(host.gpu);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A percentage as a meter segment count, mirroring the daemon's own `bucket`.
 *
 * Only ever applied to the exact samples that arrive over `spawn.host.ctl` —
 * the server's readings arrive already bucketed, because a percentage is never
 * sent there. The two must agree, or the same host would draw a different
 * meter depending on whether a direct channel happened to be open.
 */
export function bucketOf(percent: number): number {
  if (!Number.isFinite(percent) || percent < 2.5) return 0;
  const step = Math.ceil(percent / 20);
  if (step < 1) return 1;
  return Math.min(METER_SEGMENTS, step);
}

/**
 * A bucket as a word. "Busy" is clearer than five lit squares and, unlike a
 * percentage derived from a bucket, it does not invent precision the server
 * was deliberately never given.
 */
export function capacityLabel(bucket: number | null): string | null {
  if (bucket === null) return null;
  return (
    ["Idle", "Light", "Working", "Busy", "Heavy", "Pinned"][
      Math.max(0, Math.min(METER_SEGMENTS, Math.round(bucket)))
    ] ?? null
  );
}

/**
 * Where a fill sits on the load ramp — green while a machine has room, amber
 * as it tightens, red once it is out.
 *
 * The colour carries the reading, so a glance down a column of bars finds the
 * machine in trouble without comparing lengths. Amber is unambiguous here now
 * that it no longer doubles as an attention colour on this surface: on a
 * capacity bar it means one thing, "getting full".
 */
export function fillTone(fill: number): "free" | "tight" | "full" {
  if (!Number.isFinite(fill) || fill <= 0.4) return "free";
  if (fill <= 0.8) return "tight";
  return "full";
}

/** A bucket as the fraction `CapacityBar` fills to. */
export function bucketFill(bucket: number | null): number {
  if (bucket === null) return 0;
  return Math.max(0, Math.min(METER_SEGMENTS, bucket)) / METER_SEGMENTS;
}

export interface CalendarDay {
  day: string;
  sessions: number;
  seconds: number;
  /** 0 (nothing) to 4 (a heavy day), for the heatmap's ink. */
  level: number;
}

/**
 * The sparse day list from the server, densified into a contiguous calendar
 * ending on `today`.
 *
 * `today` is the server's UTC day rather than the browser's: the streak
 * counter was computed against it, and a viewer in UTC+13 must not see a
 * calendar whose last square disagrees with the number beside it.
 */
export function calendar(days: LegionDay[], today: string, span: number): CalendarDay[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const end = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(end) || span <= 0) return [];
  const peak = days.reduce((most, day) => Math.max(most, day.sessions_started), 0);
  const out: CalendarDay[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const date = new Date(end - offset * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({
      day: key,
      sessions: row?.sessions_started ?? 0,
      seconds: row?.session_seconds ?? 0,
      level: heatLevel(row?.sessions_started ?? 0, peak),
    });
  }
  return out;
}

/**
 * Ink for one square, 0–4, scaled against the person's own busiest day.
 *
 * Relative rather than absolute on purpose: somebody running three sessions a
 * day should see the same range of colour as somebody running thirty, because
 * the useful question the calendar answers is "was this a big day *for me*".
 */
export function heatLevel(sessions: number, peak: number): number {
  if (sessions <= 0) return 0;
  if (peak <= 1) return 1;
  const share = sessions / peak;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}
