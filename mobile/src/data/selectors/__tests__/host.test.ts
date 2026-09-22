import {
  fleetRollup,
  hostAvailability,
  hostCapacitySummary,
  hostPresence,
  sessionsForHost,
  sortHosts,
} from "@/data/selectors/host";
import type { AgentDef, Host, Session } from "@/data/types/domain";

function host(id: string, name: string, status: string, overrides: Partial<Host> = {}): Host {
  return {
    id,
    name,
    os: null,
    arch: null,
    version: null,
    host_key_algorithm: null,
    host_public_key: null,
    status,
    last_seen_at: null,
    session_count: 0,
    supports_account_chains: false,
    cpu_cores: null,
    cpu_physical_cores: null,
    cpu_model: null,
    memory_bytes: null,
    gpu: null,
    cpu_bucket: null,
    mem_bucket: null,
    capacity_at: null,
    ...overrides,
    daemon_tree: overrides.daemon_tree ?? null,
    update: overrides.update ?? null,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    host_id: "host-a",
    host_name: "A",
    cwd: "/tmp",
    status: "running",
    started_at: "2026-08-22T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: null,
    agent_id: null,
    agent_session_id: null,
    ...overrides,
  };
}

const CODEX: AgentDef = {
  id: "codex",
  owner_user_id: null,
  name: "codex",
  kind: "codex",
  command: "codex",
  env: {},
  install: null,
  yolo_args: null,
  yolo_env: {},
  yolo: false,
};

describe("host selectors", () => {
  it("derives presence and launch availability without inventing a quota", () => {
    expect(hostPresence(null)).toBe("unknown");
    expect(hostPresence(host("a", "A", "online"))).toBe("online");
    expect(hostAvailability(host("a", "A", "offline"))).toEqual({
      online: false,
      canLaunch: false,
      reason: "offline",
    });
  });

  it("suppresses stale capacity buckets while offline but retains telemetry existence", () => {
    const machine = host("a", "A", "offline", {
      session_count: 9,
      supports_account_chains: false,
      cpu_bucket: 4,
      mem_bucket: 3,
      capacity_at: "2026-08-22T00:00:00Z",
    });
    expect(hostCapacitySummary(machine)).toEqual({
      online: false,
      cpuSegments: null,
      memorySegments: null,
      hasTelemetry: true,
      sessionRows: 9,
    });
    expect(hostCapacitySummary({ ...machine, status: "online" })).toMatchObject({
      cpuSegments: 4,
      memorySegments: 3,
    });
  });

  it("sorts online hosts first and returns copied session order", () => {
    const machines = [
      host("z", "Zulu", "offline"),
      host("b", "beta", "online", { os: "windows", arch: "x86_64" }),
      host("a", "Alpha", "online"),
    ];
    expect(sortHosts(machines).map((item) => item.id)).toEqual(["a", "b", "z"]);
    const sessions = [
      session("old", { started_at: "2026-08-20T00:00:00Z" }),
      session("other", { host_id: "host-b" }),
      session("new", { started_at: "2026-08-22T00:00:00Z" }),
    ];
    expect(sessionsForHost(sessions, "host-a").map((item) => item.id)).toEqual(["new", "old"]);
  });
});

describe("fleet rollup", () => {
  it("rolls up presence, durable rows, live sessions, recognized agents, and attention", () => {
    const hosts = [
      host("host-a", "A", "online", { session_count: 3 }),
      host("host-b", "B", "offline", { session_count: 2 }),
    ];
    const sessions = [
      session("agent", { foreground_command: "codex", activity_state: "waiting" }),
      session("unknown", { foreground_command: "custom-unrecognized" }),
      session("dead", { host_id: "host-b", status: "killed", activity_state: "killed" }),
      session("outside", { host_id: "elsewhere" }),
    ];
    expect(fleetRollup(hosts, sessions, [CODEX])).toEqual({
      hosts: 2,
      onlineHosts: 1,
      offlineHosts: 1,
      sessionRows: 5,
      liveSessions: 2,
      runningAgents: 1,
      attention: 2,
    });
  });

  it("handles an empty fleet", () => {
    expect(fleetRollup([], [], [])).toEqual({
      hosts: 0,
      onlineHosts: 0,
      offlineHosts: 0,
      sessionRows: 0,
      liveSessions: 0,
      runningAgents: 0,
      attention: 0,
    });
  });
});
