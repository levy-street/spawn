import type { AgentDef, Host, Session, Workspace } from "@/data/types/domain";
import type { Tile, WorkspaceTab } from "@/data/types/layout";

export const NOW = "2026-08-22T00:00:00Z";

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "Implement mobile",
    host_id: "host-1",
    host_name: "office-mac",
    cwd: "/Users/spawn/dev/spawn",
    status: "running",
    started_at: NOW,
    exited_at: null,
    exit_code: null,
    last_output_at: NOW,
    last_input_at: null,
    last_activity_at: NOW,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: "codex",
    agent_id: null,
    ...overrides,
  };
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    name: "office-mac",
    os: "darwin",
    arch: "arm64",
    version: "1",
    daemon_tree: null,
    update: null,
    host_key_algorithm: "ed25519",
    host_public_key: "key",
    status: "online",
    last_seen_at: NOW,
    session_count: 1,
    supports_account_chains: false,
    cpu_cores: 8,
    cpu_physical_cores: 8,
    cpu_model: "Apple",
    memory_bytes: 16_000,
    gpu: null,
    cpu_bucket: 1,
    mem_bucket: 2,
    capacity_at: NOW,
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "agent-1",
    owner_user_id: null,
    name: "codex",
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

export function makeTab(id: string, tiles: Tile[] = []): WorkspaceTab {
  return {
    id,
    name: id,
    host_id: null,
    cwd: null,
    layout: { version: 3, tiles },
  };
}

export function makeWorkspace(tabs: WorkspaceTab[] = [makeTab("main")]): Workspace {
  return {
    id: "workspace-1",
    name: "spawn mobile",
    host_id: "host-1",
    cwd: "/Users/spawn/dev/spawn",
    layout: { version: 3, active_tab: tabs[0]?.id ?? null, tabs },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}
