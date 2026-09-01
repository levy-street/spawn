import {
  activityTone,
  attentionRank,
  deriveActivity,
  displayStatus,
  durableUnreadCount,
  relativeTime,
  sessionAttention,
  sessionTitle,
  terminalHasNewOutput,
} from "@/data/selectors/session";
import type { Host, Session, TransportState } from "@/data/types/domain";

const NOW = Date.parse("2026-08-22T12:00:10.000Z");

function iso(millisecondsBeforeNow: number): string {
  return new Date(NOW - millisecondsBeforeNow).toISOString();
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-id",
    name: null,
    host_id: "host-id",
    host_name: "Mac",
    cwd: "/Users/me/project",
    status: "running",
    started_at: iso(20_000),
    exited_at: null,
    exit_code: null,
    last_output_at: iso(4_000),
    last_input_at: null,
    last_activity_at: iso(4_000),
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: "codex",
    agent_id: null,
    ...overrides,
  };
}

function host(status: string): Host {
  return {
    id: "host-id",
    name: "Mac",
    os: "darwin",
    arch: "arm64",
    version: "1",
    daemon_tree: null,
    update: null,
    host_key_algorithm: "ed25519",
    host_public_key: null,
    status,
    last_seen_at: iso(1_000),
    session_count: 1,
    supports_account_chains: false,
    cpu_cores: 8,
    cpu_physical_cores: 4,
    cpu_model: null,
    memory_bytes: 16,
    gpu: null,
    cpu_bucket: 2,
    mem_bucket: 3,
    capacity_at: iso(1_000),
  };
}

describe("server activity derivation", () => {
  it.each([
    ["active at exactly 3 seconds", { last_output_at: iso(3_000) }, "active"],
    ["quiet immediately after 3 seconds", { last_output_at: iso(3_001) }, "quiet"],
    ["waiting at exactly 8 seconds", { last_output_at: iso(8_000) }, "waiting"],
    [
      "input sent when input is newer",
      { last_output_at: iso(4_000), last_input_at: iso(2_000) },
      "input_sent",
    ],
    [
      "active output wins over newer input",
      { last_output_at: iso(2_000), last_input_at: iso(1_000) },
      "active",
    ],
    [
      "no output starts before 8 seconds",
      { started_at: iso(7_999), last_output_at: null },
      "starting",
    ],
    ["no output is quiet at 8 seconds", { started_at: iso(8_000), last_output_at: null }, "quiet"],
  ])("returns %s", (_label, overrides, expected) => {
    expect(deriveActivity(session(overrides), NOW).state).toBe(expected);
  });

  it.each([
    ["starting", "starting", "Starting"],
    ["exited", "exited", "Exited"],
    ["killed", "killed", "Killed"],
    ["future_state", "future_state", "Future State"],
  ])("gives process %s precedence", (status, state, label) => {
    expect(deriveActivity(session({ status }), NOW)).toMatchObject({ state, label });
  });
});

describe("attention and five-dimensional display status", () => {
  it("ranks dead above inconsistent waiting state", () => {
    const deadAndWaiting = session({ status: "killed", activity_state: "waiting" });
    expect(sessionAttention(deadAndWaiting)).toBe("dead");
    expect(attentionRank(deadAndWaiting)).toBe(2);
    expect(attentionRank(session({ activity_state: "waiting" }))).toBe(1);
    expect(attentionRank(session())).toBe(0);
  });

  it.each<[string, Partial<Session>, Host | null, TransportState, object]>([
    [
      "active online ready",
      { activity_state: "active", activity_label: "Active" },
      host("online"),
      "ready",
      {
        host: "online",
        transportPresentation: "connected",
        tone: "active",
        pulse: true,
        attention: null,
      },
    ],
    [
      "waiting offline reconnecting",
      { activity_state: "waiting", activity_label: "Awaiting input" },
      host("offline"),
      "reconnecting",
      {
        host: "offline",
        transportPresentation: "connecting",
        tone: "waiting",
        pulse: false,
        attention: "waiting",
      },
    ],
    [
      "dead unknown failed",
      { status: "exited", activity_state: "waiting", activity_label: "Exited" },
      null,
      "failed",
      {
        host: "unknown",
        transportPresentation: "offline",
        tone: "waiting",
        pulse: false,
        attention: "dead",
      },
    ],
  ])("keeps dimensions independent for %s", (_label, overrides, machine, transport, expected) => {
    expect(displayStatus(session(overrides), machine, transport)).toMatchObject(expected);
  });

  it.each([
    ["active", "active"],
    ["waiting", "waiting"],
    ["input_sent", "waiting"],
    ["starting", "waiting"],
    ["quiet", "idle"],
  ])("maps %s to %s tone", (activity_state, tone) => {
    expect(activityTone(session({ activity_state }))).toBe(tone);
  });
});

describe("session display helpers", () => {
  it("uses an explicit name, then cwd and agent identity, then the ID", () => {
    expect(sessionTitle(session({ name: "  Build  " }))).toBe("Build");
    expect(sessionTitle(session())).toBe("project · Codex");
    expect(sessionTitle(session({ cwd: "", foreground_command: null }))).toBe("session- · Shell");
  });

  it("formats compact relative time and local new-output state", () => {
    expect(relativeTime(iso(59_000), NOW)).toBe("59s");
    expect(relativeTime(iso(61_000), NOW)).toBe("1m");
    expect(relativeTime(null, NOW)).toBeNull();
    expect(terminalHasNewOutput(true, false, true)).toBe(true);
    expect(terminalHasNewOutput(true, true, true)).toBe(false);
    expect(durableUnreadCount()).toBe(0);
  });
});
