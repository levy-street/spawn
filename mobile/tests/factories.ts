import type { AgentDef, Host, Session, Workspace } from "@/data/types/domain";
import type { WorkspaceTab } from "@/data/types/layout";

export const FIXTURE_NOW = "2026-08-22T00:00:00.000Z";

export const FIXTURE_IDS = {
  agent: "10000000-0000-4000-8000-000000000001",
  host: "20000000-0000-4000-8000-000000000001",
  session: "30000000-0000-4000-8000-000000000001",
  workspace: "40000000-0000-4000-8000-000000000001",
  tab: "tab-1",
} as const;

export function makeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: FIXTURE_IDS.agent,
    owner_user_id: null,
    name: "Codex",
    kind: "codex",
    command: "codex",
    env: {},
    install: null,
    yolo_args: null,
    yolo_env: {},
    yolo: false,
    ...overrides,
  };
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: FIXTURE_IDS.host,
    name: "Ada's Mac",
    os: "darwin",
    arch: "arm64",
    version: "1.0.0",
    host_key_algorithm: "ed25519",
    host_public_key: "host-public-key",
    status: "online",
    last_seen_at: FIXTURE_NOW,
    session_count: 1,
    cpu_cores: 10,
    cpu_physical_cores: 10,
    cpu_model: "Apple Silicon",
    memory_bytes: 16_000_000_000,
    gpu: null,
    cpu_bucket: 1,
    mem_bucket: 1,
    capacity_at: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: FIXTURE_IDS.session,
    name: "Native app",
    host_id: FIXTURE_IDS.host,
    host_name: "Ada's Mac",
    cwd: "/Users/ada/spawn",
    status: "running",
    started_at: FIXTURE_NOW,
    exited_at: null,
    exit_code: null,
    last_output_at: FIXTURE_NOW,
    last_input_at: null,
    last_activity_at: FIXTURE_NOW,
    activity_state: "active",
    activity_label: "Active",
    foreground_command: "codex",
    ...overrides,
  };
}

export function makeTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: FIXTURE_IDS.tab,
    name: "Main",
    host_id: FIXTURE_IDS.host,
    cwd: "/Users/ada/spawn",
    layout: { version: 3, tiles: [] },
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const tab = makeTab();
  return {
    id: FIXTURE_IDS.workspace,
    name: "spawn",
    host_id: FIXTURE_IDS.host,
    cwd: "/Users/ada/spawn",
    layout: { version: 3, active_tab: tab.id, tabs: [tab] },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
    ...overrides,
  };
}
