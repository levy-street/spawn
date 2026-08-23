import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostAgentStatus, HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { SkillOut } from "@/data/api/schemas/skills";

export const HOST_ID = "11111111-1111-4111-8111-111111111111";
export const AGENT_ID = "22222222-2222-4222-8222-222222222222";

export const onlineHost: HostOut = {
  id: HOST_ID,
  name: "office-mac",
  os: "macOS",
  arch: "arm64",
  version: "1.4.2",
  host_key_algorithm: "ed25519",
  host_public_key: "host-public-key",
  host_key_fingerprint: "SHA256:hostfingerprint",
  status: "online",
  last_seen_at: "2026-08-22T00:00:00Z",
  session_count: 3,
  cpu_cores: 12,
  cpu_physical_cores: 10,
  cpu_model: "Apple M4 Pro",
  memory_bytes: 25_769_803_776,
  gpu: "Apple M4 Pro",
  cpu_bucket: 3,
  mem_bucket: 2,
  capacity_at: "2026-08-22T00:00:00Z",
};

export const offlineHost: HostOut = {
  ...onlineHost,
  id: "33333333-3333-4333-8333-333333333333",
  name: "old-laptop",
  status: "offline",
  cpu_bucket: null,
  mem_bucket: null,
};

export const codexAgent: AgentOut = {
  id: AGENT_ID,
  owner_user_id: null,
  name: "codex",
  kind: "codex",
  command: "codex",
  env: {},
  install: "install codex",
  yolo_args: "--dangerously-bypass-approvals-and-sandbox",
  yolo_env: {},
  yolo: false,
};

export const runningSession: SessionOut = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "native app",
  host_id: HOST_ID,
  host_name: "office-mac",
  cwd: "/Users/spawn/dev/native",
  status: "running",
  started_at: "2026-08-22T00:00:00Z",
  exited_at: null,
  exit_code: null,
  last_output_at: "2026-08-22T00:00:08Z",
  last_input_at: "2026-08-22T00:00:01Z",
  last_activity_at: "2026-08-22T00:00:08Z",
  activity_state: "waiting",
  activity_label: "Awaiting input",
  foreground_command: "codex",
};

export const hostAgent: HostAgentStatus = {
  agent_id: AGENT_ID,
  agent_name: "Codex",
  agent_kind: "codex",
  command: "codex",
  install: "install codex",
  installed: true,
  path: "/usr/local/bin/codex",
  version: "1.2.0",
  latest_version: "1.3.0",
  update_available: true,
  error: null,
  auto_update: false,
  last_checked_at: "2026-08-22T00:00:00Z",
  last_auto_update_at: null,
  last_auto_update_error: null,
};

export const skill: SkillOut = {
  id: "55555555-5555-4555-8555-555555555555",
  owner_user_id: "66666666-6666-4666-8666-666666666666",
  name: "review",
  description: "Review changed code before shipping.",
  content: "Review the diff.",
  enabled_by_default: true,
  created_at: "2026-08-22T00:00:00Z",
};
