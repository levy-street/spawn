import { describe, expect, test } from "bun:test";

import type { Host, LegionDay, Session } from "@/lib/api";
import type { LegionHostRow } from "./legion";
import {
  bucketFill,
  bucketOf,
  calendar,
  capacityLabel,
  countsLabel,
  fillTone,
  formatBytes,
  formatDuration,
  heatLevel,
  hostTone,
  hostToneLabel,
  orderSessions,
  reportsCapacity,
  runningAgents,
  specLine,
  summarizeLegion,
  summaryLine,
} from "./legion";

const HOST_A = "11111111-2222-4333-8444-555555555551";
const HOST_B = "11111111-2222-4333-8444-555555555552";

function makeHost(id: string, name: string, overrides: Partial<Host> = {}): Host {
  return {
    id,
    name,
    os: "linux",
    arch: "x86_64",
    version: "0.1.0",
    host_key_algorithm: "ed25519",
    host_public_key: null,
    supports_account_chains: false,
    status: "online",
    last_seen_at: "2026-08-21T00:00:00Z",
    session_count: 0,
    cpu_cores: 16,
    cpu_physical_cores: 8,
    cpu_model: "AMD Ryzen 9",
    memory_bytes: 64 * 1024 ** 3,
    gpu: null,
    cpu_bucket: 2,
    mem_bucket: 1,
    capacity_at: "2026-08-21T00:00:00Z",
    ...overrides,
  };
}

function makeSession(id: string, hostId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: null,
    host_id: hostId,
    host_name: "host",
    cwd: "/home/me",
    status: "running",
    started_at: "2026-08-21T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: null,
    ...overrides,
  };
}

describe("runningAgents", () => {
  test("drops shells, because every session has one", () => {
    expect(
      runningAgents([
        makeSession("s1", HOST_A, { foreground_command: "zsh" }),
        makeSession("s2", HOST_A, { foreground_command: "-bash" }),
        makeSession("s3", HOST_A, { foreground_command: "claude" }),
      ]),
    ).toEqual([{ command: "claude", count: 1 }]);
  });

  test("collapses to counts, most first, ties alphabetical", () => {
    expect(
      runningAgents([
        makeSession("s1", HOST_A, { foreground_command: "codex" }),
        makeSession("s2", HOST_A, { foreground_command: "claude" }),
        makeSession("s3", HOST_A, { foreground_command: "claude" }),
        makeSession("s4", HOST_A, { foreground_command: "cargo" }),
      ]),
    ).toEqual([
      { command: "claude", count: 2 },
      { command: "cargo", count: 1 },
      { command: "codex", count: 1 },
    ]);
  });

  test("a dead session is not still running something", () => {
    expect(
      runningAgents([
        makeSession("s1", HOST_A, { status: "exited", foreground_command: "claude" }),
      ]),
    ).toEqual([]);
  });
});

describe("hostTone", () => {
  test("offline outranks anything happening on it", () => {
    const host = makeHost(HOST_A, "dream", { status: "offline" });
    const sessions = [makeSession("s1", HOST_A, { activity_state: "waiting" })];
    expect(hostTone(host, sessions)).toBe("offline");
  });

  test("a blocked session does not colour the host — attention is not a host state", () => {
    const host = makeHost(HOST_A, "dream");
    expect(hostTone(host, [makeSession("s1", HOST_A, { activity_state: "waiting" })])).toBe("idle");
    expect(
      hostTone(host, [
        makeSession("s1", HOST_A, { activity_state: "active" }),
        makeSession("s2", HOST_A, { activity_state: "waiting" }),
      ]),
    ).toBe("active");
  });

  test("a host with nothing on it is idle, not offline", () => {
    expect(hostTone(makeHost(HOST_A, "dream"), [])).toBe("idle");
  });
});

describe("hostToneLabel", () => {
  const rowFor = (sessions: Session[], overrides: Partial<Host> = {}): LegionHostRow => {
    const row = summarizeLegion([makeHost(HOST_A, "dream", overrides)], sessions).rows[0];
    if (!row) throw new Error("expected one host row");
    return row;
  };

  test("never says something the dot did not", () => {
    // Blocked sessions leave the dot green when anything is still producing
    // output, so the sentence has to agree rather than mention them.
    const row = rowFor([
      makeSession("s1", HOST_A, { activity_state: "waiting" }),
      makeSession("s2", HOST_A, { activity_state: "active" }),
    ]);
    expect(hostToneLabel(row)).toBe("1 session working");
  });

  test("falls through working, to quiet, to empty", () => {
    expect(hostToneLabel(rowFor([makeSession("s", HOST_A, { activity_state: "active" })]))).toBe(
      "1 session working",
    );
    expect(hostToneLabel(rowFor([makeSession("s", HOST_A, { activity_state: "quiet" })]))).toBe(
      "1 session, all quiet",
    );
    expect(hostToneLabel(rowFor([]))).toBe("Online, nothing running");
  });

  test("an offline machine says so before anything else", () => {
    const row = rowFor([makeSession("s", HOST_A, { activity_state: "waiting" })], {
      status: "offline",
    });
    expect(hostToneLabel(row)).toBe("dream is offline");
  });
});

describe("summarizeLegion", () => {
  test("rolls hosts and sessions into one reading", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "nightmare"), makeHost(HOST_B, "dream")],
      [
        makeSession("s1", HOST_A, { activity_state: "active", foreground_command: "claude" }),
        makeSession("s2", HOST_A, { activity_state: "quiet", foreground_command: "claude" }),
        makeSession("s3", HOST_B, { activity_state: "waiting", foreground_command: "codex" }),
        makeSession("s4", HOST_B, { status: "exited" }),
      ],
    );
    expect(summary.hosts).toBe(2);
    expect(summary.hostsOnline).toBe(2);
    expect(summary.sessions).toBe(3);
    expect(summary.attention).toBe(2); // one waiting, one dead
    expect(summary.busy).toBe(1);
    expect(summary.cores).toBe(32);
  });

  test("orders online first then by name, never by load", () => {
    const summary = summarizeLegion(
      [
        makeHost(HOST_A, "zeta"),
        makeHost(HOST_B, "alpha", { status: "offline" }),
        makeHost("33333333-2222-4333-8444-555555555553", "beta"),
      ],
      [],
    );
    expect(summary.rows.map((row) => row.host.name)).toEqual(["beta", "zeta", "alpha"]);
  });

  test("an offline host reports no meter, whatever it last said", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream", { status: "offline", cpu_bucket: 5, mem_bucket: 5 })],
      [],
    );
    expect(summary.rows[0]?.cpuBucket).toBeNull();
    expect(summary.rows[0]?.memBucket).toBeNull();
  });

  test("a fleet of silent daemons sums no cores rather than guessing", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream", { cpu_cores: null, memory_bytes: null, cpu_bucket: null })],
      [],
    );
    expect(summary.cores).toBe(0);
    expect(summary.hasCapacity).toBe(false);
  });

  test("each row carries its own live sessions for the hover card", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream")],
      [
        makeSession("live", HOST_A, { activity_state: "waiting" }),
        makeSession("dead", HOST_A, { status: "exited" }),
      ],
    );
    // Exited panes are counted as attention but are not "running here".
    expect(summary.rows[0]?.sessions.map((session) => session.id)).toEqual(["live"]);
  });

  test("sessions on a host that is gone are still counted against it", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream", { status: "offline" })],
      [makeSession("s1", HOST_A)],
    );
    expect(summary.rows[0]?.live).toBe(1);
  });
});

describe("reportsCapacity", () => {
  test("false only when the daemon said nothing at all", () => {
    expect(reportsCapacity(makeHost(HOST_A, "d"))).toBe(true);
    expect(
      reportsCapacity(
        makeHost(HOST_A, "d", { cpu_cores: null, memory_bytes: null, cpu_bucket: null }),
      ),
    ).toBe(false);
    // Buckets alone are enough: a host can report load without a spec.
    expect(reportsCapacity(makeHost(HOST_A, "d", { cpu_cores: null, memory_bytes: null }))).toBe(
      true,
    );
  });
});

describe("summaryLine", () => {
  const base = summarizeLegion([makeHost(HOST_A, "dream")], []);

  test("attention wins over everything else", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream")],
      [
        makeSession("s1", HOST_A, { activity_state: "waiting" }),
        makeSession("s2", HOST_A, { activity_state: "active" }),
      ],
    );
    expect(summaryLine(summary)).toBe("1 need you");
  });

  test("a quiet fleet says so instead of showing a zero", () => {
    expect(summaryLine(base)).toBe("Quiet");
  });

  test("no hosts is a different statement from a quiet one", () => {
    expect(summaryLine(summarizeLegion([], []))).toBe("No hosts yet");
  });

  test("every host down is worth saying out loud", () => {
    expect(summaryLine(summarizeLegion([makeHost(HOST_A, "d", { status: "offline" })], []))).toBe(
      "All hosts offline",
    );
  });

  test("counts label reads online hosts and live sessions", () => {
    const summary = summarizeLegion(
      [makeHost(HOST_A, "dream"), makeHost(HOST_B, "night", { status: "offline" })],
      [makeSession("s1", HOST_A)],
    );
    expect(countsLabel(summary)).toBe("1 · 1");
  });
});

describe("formatBytes", () => {
  test("picks the shortest honest unit", () => {
    expect(formatBytes(64 * 1024 ** 3)).toBe("64 GB");
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB");
    expect(formatBytes(512)).toBe("512 B");
  });

  test("one decimal only where it carries information", () => {
    expect(formatBytes(12.34 * 1024 ** 3)).toBe("12 GB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });

  test("nothing to report reads as nothing, not as zero", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
  });
});

describe("formatDuration", () => {
  test("one useful resolution at each scale", () => {
    expect(formatDuration(48)).toBe("48s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(3600 * 4 + 720)).toBe("4h 12m");
    expect(formatDuration(86_400 * 3 + 3600 * 4)).toBe("3d 4h");
  });

  test("nothing run is 0m, not an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
  });
});

describe("specLine", () => {
  test("reads as the flex it is", () => {
    expect(specLine({ cpu_cores: 64, memory_bytes: 256 * 1024 ** 3, gpu: "2× RTX 4090" })).toBe(
      "64 cores · 256 GB · 2× RTX 4090",
    );
  });

  test("omits what a host did not report rather than padding it", () => {
    expect(specLine({ cpu_cores: 1, memory_bytes: null, gpu: null })).toBe("1 core");
    expect(specLine({ cpu_cores: null, memory_bytes: null, gpu: null })).toBeNull();
  });
});

describe("calendar", () => {
  const days: LegionDay[] = [
    {
      day: "2026-08-19",
      sessions_started: 4,
      session_seconds: 100,
      peak_sessions: 2,
      peak_hosts_online: 1,
    },
    {
      day: "2026-08-21",
      sessions_started: 1,
      session_seconds: 10,
      peak_sessions: 1,
      peak_hosts_online: 1,
    },
  ];

  test("densifies a sparse series and ends on the server's today", () => {
    const grid = calendar(days, "2026-08-21", 4);
    expect(grid.map((cell) => cell.day)).toEqual([
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(grid.map((cell) => cell.sessions)).toEqual([0, 4, 0, 1]);
  });

  test("crosses a month boundary without arithmetic drift", () => {
    const grid = calendar([], "2026-09-02", 4);
    expect(grid.map((cell) => cell.day)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  test("an unreadable today produces no calendar rather than Invalid Date", () => {
    expect(calendar(days, "not-a-day", 7)).toEqual([]);
    expect(calendar(days, "2026-08-21", 0)).toEqual([]);
  });
});

describe("orderSessions", () => {
  test("puts whatever is waiting on you first, then work, then the rest", () => {
    const ordered = orderSessions([
      makeSession("quiet", HOST_A, { activity_state: "quiet" }),
      makeSession("busy", HOST_A, { activity_state: "active" }),
      makeSession("asking", HOST_A, { activity_state: "waiting" }),
    ]);
    expect(ordered.map((session) => session.id)).toEqual(["asking", "busy", "quiet"]);
  });

  test("breaks ties on most recent activity, falling back to start time", () => {
    const ordered = orderSessions([
      makeSession("old", HOST_A, { last_activity_at: "2026-08-21T09:00:00Z" }),
      makeSession("new", HOST_A, { last_activity_at: "2026-08-21T11:00:00Z" }),
      makeSession("never", HOST_A, { started_at: "2026-08-21T10:00:00Z" }),
    ]);
    expect(ordered.map((session) => session.id)).toEqual(["new", "never", "old"]);
  });

  test("does not mutate the list it was given", () => {
    const input = [
      makeSession("a", HOST_A, { activity_state: "quiet" }),
      makeSession("b", HOST_A, { activity_state: "waiting" }),
    ];
    orderSessions(input);
    expect(input.map((session) => session.id)).toEqual(["a", "b"]);
  });
});

describe("bucketOf", () => {
  test("agrees with the daemon's own bucketing, segment for segment", () => {
    // Mirrors daemon/src/host_metrics.rs::bucket — the same host must draw the
    // same meter whether the reading came over the heartbeat or the channel.
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(2.4)).toBe(0);
    expect(bucketOf(2.5)).toBe(1);
    expect(bucketOf(20)).toBe(1);
    expect(bucketOf(20.1)).toBe(2);
    expect(bucketOf(41)).toBe(3);
    expect(bucketOf(61)).toBe(4);
    expect(bucketOf(81)).toBe(5);
    expect(bucketOf(100)).toBe(5);
  });

  test("a nonsense reading never lights the meter", () => {
    expect(bucketOf(Number.NaN)).toBe(0);
    expect(bucketOf(-1)).toBe(0);
    expect(bucketOf(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("capacityLabel", () => {
  test("names every level rather than inventing a percentage", () => {
    // A bucket is five levels. Rendering it as "60%" would be precision the
    // server was deliberately never given.
    expect(capacityLabel(0)).toBe("Idle");
    expect(capacityLabel(1)).toBe("Light");
    expect(capacityLabel(2)).toBe("Working");
    expect(capacityLabel(3)).toBe("Busy");
    expect(capacityLabel(4)).toBe("Heavy");
    expect(capacityLabel(5)).toBe("Pinned");
  });

  test("says nothing about a host that reported nothing", () => {
    expect(capacityLabel(null)).toBeNull();
  });

  test("a bucket outside the meter still names a real level", () => {
    expect(capacityLabel(-3)).toBe("Idle");
    expect(capacityLabel(99)).toBe("Pinned");
  });
});

describe("fillTone", () => {
  test("runs green while there is room, amber as it tightens, red once out", () => {
    expect(fillTone(0)).toBe("free");
    expect(fillTone(0.4)).toBe("free");
    expect(fillTone(0.41)).toBe("tight");
    expect(fillTone(0.8)).toBe("tight");
    expect(fillTone(0.81)).toBe("full");
    expect(fillTone(1)).toBe("full");
  });

  test("maps the five buckets onto the ramp without a gap", () => {
    // Light and Working have room; Busy and Heavy are tightening; Pinned is out.
    expect([1, 2].map((bucket) => fillTone(bucketFill(bucket)))).toEqual(["free", "free"]);
    expect([3, 4].map((bucket) => fillTone(bucketFill(bucket)))).toEqual(["tight", "tight"]);
    expect(fillTone(bucketFill(5))).toBe("full");
  });

  test("a nonsense reading is never drawn as a machine in trouble", () => {
    expect(fillTone(Number.NaN)).toBe("free");
  });
});

describe("bucketFill", () => {
  test("maps the meter onto the fraction a bar fills to", () => {
    expect(bucketFill(0)).toBe(0);
    expect(bucketFill(1)).toBeCloseTo(0.2);
    expect(bucketFill(5)).toBe(1);
  });

  test("an unreported bucket draws an empty track, never a full one", () => {
    expect(bucketFill(null)).toBe(0);
    expect(bucketFill(12)).toBe(1);
    expect(bucketFill(-4)).toBe(0);
  });
});

describe("heatLevel", () => {
  test("scales against the person's own busiest day", () => {
    expect(heatLevel(0, 40)).toBe(0);
    expect(heatLevel(4, 40)).toBe(1);
    expect(heatLevel(16, 40)).toBe(2);
    expect(heatLevel(24, 40)).toBe(3);
    expect(heatLevel(40, 40)).toBe(4);
  });

  test("a single quiet day still reads as a day that happened", () => {
    expect(heatLevel(1, 1)).toBe(1);
  });
});
