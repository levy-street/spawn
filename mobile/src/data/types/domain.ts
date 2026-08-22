import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostAgentStatus, HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { SessionAccessOut, SkillOut } from "@/data/api/schemas/skills";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import type { WorkspaceIconSource, WorkspaceOut } from "@/data/api/schemas/workspaces";
import type {
  AgentId,
  HostId,
  PaneId,
  SessionId,
  TabId,
  Tile,
  WorkspaceId,
  WorkspaceLayoutV3,
} from "@/data/types/layout";
import type { TransportState } from "@/terminal/transport/types";

export type Session = SessionOut;
export type Host = HostOut;
export type AgentDef = AgentOut;
export type Skill = SkillOut;
export type SessionAccess = SessionAccessOut;
export type HostAgent = HostAgentStatus;
export type WorkspaceTemplate = WorkspaceTemplateOut;
export type { WorkspaceIconSource };

/** The domain layout retains future fields that strict wire schemas cannot describe yet. */
export type Workspace = Omit<WorkspaceOut, "layout"> & { layout: WorkspaceLayoutV3 };

export type KnownProcessStatus = "starting" | "running" | "exited" | "killed";
export type KnownActivityState =
  | "starting"
  | "active"
  | "quiet"
  | "waiting"
  | "input_sent"
  | "exited"
  | "killed"
  | "unknown";
export type ActivityTone = "active" | "waiting" | "idle" | "offline";
export type Attention = "waiting" | "dead" | null;
export type HostPresence = "online" | "offline" | "unknown";
export type TransportPresentation = "connecting" | "connected" | "offline";

export interface ActivityPresentation {
  state: string;
  label: string;
  last_activity_at: string | null;
}

export interface DisplayStatus {
  process: string;
  activity: string;
  host: HostPresence;
  transport: TransportState;
  transportPresentation: TransportPresentation;
  attention: Attention;
  label: string;
  tone: ActivityTone;
  pulse: boolean;
}

export type AgentLogoKey = "claude-code" | "codex" | "opencode" | "aider" | "shell";

export interface AgentIdentity {
  kind: string;
  displayName: string;
  logoKey: AgentLogoKey | null;
  monogramSeed: string;
}

export interface BasePaneListItem {
  paneId: PaneId;
  workspaceId: WorkspaceId;
  tabId: TabId;
  order: number;
  geometry: Pick<Tile, "x" | "y" | "w" | "h">;
}

export interface TerminalListItem extends BasePaneListItem {
  kind: "terminal";
  sessionId: SessionId;
  title: string;
  detail: string;
  typeLabel: string;
  identity: AgentIdentity;
  statusLabel: string;
  statusTone: ActivityTone;
  statusPulse: boolean;
  attention: Attention;
  running: boolean;
}

export interface FilesListItem extends BasePaneListItem {
  kind: "files";
  hostId: HostId;
  path: string;
  hostOnline: boolean;
}

export interface MissingListItem extends BasePaneListItem {
  kind: "missing";
  statusTone: "offline";
}

export type PaneListItem = TerminalListItem | FilesListItem | MissingListItem;

export interface TabStats {
  tiles: number;
  terminals: number;
  widgets: number;
  running: number;
  waiting: number;
  dead: number;
  attention: number;
  nominalRemaining: number;
  canAdd: boolean;
}

export interface WorkspaceStats {
  tabs: number;
  tiles: number;
  terminals: number;
  widgets: number;
  running: number;
  waiting: number;
  dead: number;
  attention: number;
  remainingTabs: number;
  nominalRemainingPanes: number;
  archived: boolean;
  recency: number;
}

/** Plain selector input assembled from Query data; it is not a second server-state store. */
export interface DomainSnapshot {
  workspacesById: ReadonlyMap<WorkspaceId, Workspace>;
  sessionsById: ReadonlyMap<SessionId, Session>;
  hostsById: ReadonlyMap<HostId, Host>;
  agents: readonly AgentDef[];
}

export interface HostCapacitySummary {
  online: boolean;
  cpuSegments: number | null;
  memorySegments: number | null;
  hasTelemetry: boolean;
  sessionRows: number;
}

export interface FleetRollup {
  hosts: number;
  onlineHosts: number;
  offlineHosts: number;
  sessionRows: number;
  liveSessions: number;
  runningAgents: number;
  attention: number;
}

export type { AgentId, HostId, PaneId, SessionId, TabId, TransportState, WorkspaceId };
