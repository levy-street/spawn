import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut, WorkspaceTab } from "@/data/api/schemas/workspaces";

const NOW = "2026-08-22T00:00:00.000Z";

export function makeAgent(overrides: Partial<AgentOut> = {}): AgentOut {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    owner_user_id: null,
    name: "codex",
    kind: "codex",
    command: "codex",
    env: {},
    install: "curl install-codex",
    yolo_args: "--dangerously-bypass-approvals-and-sandbox",
    yolo_env: {},
    yolo: false,
    ...overrides,
  };
}

export function makeHost(overrides: Partial<HostOut> = {}): HostOut {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Ada's Mac",
    os: "darwin",
    arch: "arm64",
    version: "1",
    host_key_algorithm: "ed25519",
    host_public_key: "host-key",
    status: "online",
    last_seen_at: NOW,
    session_count: 0,
    cpu_cores: 10,
    cpu_physical_cores: 10,
    cpu_model: "Apple",
    memory_bytes: 16_000_000_000,
    gpu: null,
    cpu_bucket: 1,
    mem_bucket: 1,
    capacity_at: NOW,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionOut> = {}): SessionOut {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    name: null,
    host_id: "20000000-0000-4000-8000-000000000001",
    host_name: "Ada's Mac",
    cwd: "/Users/ada/spawn",
    status: "running",
    started_at: NOW,
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: NOW,
    activity_state: "active",
    activity_label: "Active",
    foreground_command: null,
    ...overrides,
  };
}

export function makeTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "Tab 1",
    host_id: null,
    cwd: null,
    layout: { version: 3, tiles: [] },
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<WorkspaceOut> = {}): WorkspaceOut {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    name: "spawn",
    host_id: null,
    cwd: null,
    layout: { version: 3, active_tab: "tab-1", tabs: [makeTab()] },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function fullTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return makeTab({
    ...overrides,
    layout: {
      version: 3,
      tiles: Array.from({ length: 16 }, (_, index) => ({
        session_id: `pane-${index}`,
        x: (index % 4) * 6,
        y: Math.floor(index / 4) * 6,
        w: 6,
        h: 6,
      })),
    },
  });
}
