import { agentLaunchCommand, newAgentConversationId } from "@/components/launcher/agent-command";
import { autoPlaceWorkspaceTiles } from "@/components/launcher/launcher-selection";
import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionCreate, SessionOut } from "@/data/api/schemas/sessions";
import type {
  WorkspaceCreate,
  WorkspaceCreateResponse,
  WorkspaceLayoutV3,
  WorkspaceOut,
  WorkspaceTile,
} from "@/data/api/schemas/workspaces";

/**
 * Opening a window, in one place.
 *
 * Every way this app makes a window — the launcher's "Add a window", "New
 * window here…" on a host, a template replayed, a workspace or a pane
 * duplicated — comes through `createWindow`. It is where the conversation an
 * agent starts under is named, where the server is asked for the window, and
 * where the agent's command is queued for this device to type when the
 * window's terminal opens. Something every new window has to carry (a launch
 * context the host keeps, say) is added here once rather than at each door.
 * The browser keeps the same single path
 * (web/src/components/workspace/create-window.ts).
 */

export interface WindowTile {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WindowWorkspace =
  /**
   * A workspace that exists. Without a tile the window joins the tab — the
   * workspace's active one unless named — wherever there is room, and the
   * layout is saved first, so the server never meets a tile overlapping what it
   * still thinks is there. With one it lands exactly there: the caller has made
   * the room and chosen the tab.
   */
  | { kind: "workspace"; workspaceId: string; tabId?: string | null; tile?: WindowTile }
  /** A workspace made for this window, which starts with it filling the canvas. */
  | { kind: "new-workspace"; name?: string };

export interface CreateWindowRequest {
  host: { id: string };
  cwd: string;
  /** Opens the window as this agent: a shell its command is typed into. */
  agent?: AgentOut | null;
  /**
   * Typed into the new shell when no agent definition describes what it runs
   * (a template's stored command for an agent this account no longer has).
   */
  command?: string | null;
  name?: string | null;
  /**
   * Explicit skill grants, sent as given — an empty list grants none, so a
   * copy carries exactly its source's. Only an omitted list means the
   * account's defaults. The browser keeps the same rule.
   */
  skillIds?: readonly string[];
  /** Where the window lands; omitted makes it in no workspace, for the caller to place. */
  workspace?: WindowWorkspace;
}

export interface CreateWindowDependencies {
  createSession(input: SessionCreate): Promise<SessionOut>;
  /** For the conversation an agent is started under. */
  newId(): string;
  pending: Pick<PendingLaunchStore, "persist">;
  /** Needed to place a window in a workspace's tab without a tile of its own. */
  getWorkspace?(workspaceId: string): Promise<WorkspaceOut>;
  patchWorkspace?(workspaceId: string, patch: { layout: WorkspaceLayoutV3 }): Promise<WorkspaceOut>;
  /** Needed for a window that starts a new workspace. */
  createWorkspace?(input: WorkspaceCreate): Promise<WorkspaceCreateResponse>;
}

export type CreateWindowResult =
  | {
      status: "created";
      session: SessionOut;
      /** The workspace it landed in; null for a window made on its own. */
      workspaceId: string | null;
      /** An agent command is queued for the window's first terminal. */
      pendingCommand: boolean;
    }
  | {
      /** The shell exists, but the command it was opened for could not be queued. */
      status: "created_unqueued";
      session: SessionOut;
      workspaceId: string | null;
      command: string;
      message: string;
    };

export class LauncherError extends Error {
  constructor(
    readonly code: "tab_missing" | "tab_full",
    message: string,
  ) {
    super(message);
    this.name = "LauncherError";
  }
}

/** What starting an agent in a window types, and the conversation it names. */
export interface AgentStart {
  agentId: string;
  /** Null for a CLI that names its own conversations. */
  conversationId: string | null;
  command: string;
}

/**
 * The one spelling of an agent's start: a fresh conversation, named up front
 * where the CLI lets SPAWN D name it, so a restart can resume this one rather
 * than "the latest", and the command that starts it there.
 */
export function agentStart(agent: AgentOut, newId: () => string): AgentStart {
  const conversationId = newAgentConversationId(agent.kind, newId);
  return { agentId: agent.id, conversationId, command: agentLaunchCommand(agent, conversationId) };
}

/**
 * A placed tile as the workspace envelope carries it: no client-only keys. Its
 * widget goes back exactly as it came, a kind this app cannot draw included —
 * making room for a window must not turn a pane from a newer SPAWN D into a
 * session tile that names no session.
 */
export function toWireTile(tile: {
  session_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widget?: unknown;
}): WorkspaceTile {
  return {
    session_id: tile.session_id,
    x: tile.x,
    y: tile.y,
    w: tile.w,
    h: tile.h,
    ...(tile.widget ? { widget: tile.widget as WorkspaceTile["widget"] } : {}),
  };
}

/**
 * Make room for one more pane in a workspace's tab and save that layout, with
 * the tab made active so the window is where the workspace opens. Returns the
 * rect the window is to fill.
 */
async function makeRoom(
  workspaceId: string,
  tabId: string | null | undefined,
  dependencies: CreateWindowDependencies,
): Promise<WindowTile> {
  if (!dependencies.getWorkspace || !dependencies.patchWorkspace) {
    throw new Error("Placing a window needs the workspace's layout.");
  }
  const workspace = await dependencies.getWorkspace(workspaceId);
  const targetId = tabId ?? workspace.layout.active_tab ?? workspace.layout.tabs[0]?.id;
  const target = workspace.layout.tabs.find((tab) => tab.id === targetId);
  if (!target) throw new LauncherError("tab_missing", "The selected tab no longer exists.");
  const placement = autoPlaceWorkspaceTiles(target.layout.tiles);
  if (!placement.tile) {
    throw new LauncherError("tab_full", "The selected tab has no room for another terminal.");
  }
  const layout: WorkspaceLayoutV3 = {
    ...workspace.layout,
    active_tab: target.id,
    tabs: workspace.layout.tabs.map((tab) =>
      tab.id === target.id
        ? { ...tab, layout: { ...tab.layout, tiles: placement.tiles.map(toWireTile) } }
        : tab,
    ),
  };
  await dependencies.patchWorkspace(workspace.id, { layout });
  return placement.tile;
}

export async function createWindow(
  request: CreateWindowRequest,
  dependencies: CreateWindowDependencies,
): Promise<CreateWindowResult> {
  const destination = request.workspace;
  const tile =
    destination?.kind === "workspace"
      ? (destination.tile ??
        (await makeRoom(destination.workspaceId, destination.tabId, dependencies)))
      : null;

  // The conversation is chosen here, before the window exists, so the window
  // can record it — what makes it that kind of window, so a duplicate opens as
  // one too, and which conversation it starts, so a restart can resume it.
  const start = request.agent ? agentStart(request.agent, dependencies.newId) : null;
  const agentFields = start
    ? { agent_id: start.agentId, agent_session_id: start.conversationId }
    : {};
  const name = request.name?.trim();

  let session: SessionOut;
  let workspaceId: string | null;
  if (destination?.kind === "new-workspace") {
    if (!dependencies.createWorkspace) {
      throw new Error("Starting a workspace needs the workspace endpoint.");
    }
    const created = await dependencies.createWorkspace({
      ...(destination.name ? { name: destination.name } : {}),
      first_session: {
        host_id: request.host.id,
        cwd: request.cwd,
        ...agentFields,
        ...(request.skillIds ? { skill_ids: [...request.skillIds] } : {}),
      },
    });
    if (!created.session) throw new Error("The workspace was created without its first window.");
    session = created.session;
    workspaceId = created.workspace.id;
  } else {
    session = await dependencies.createSession({
      host_id: request.host.id,
      cwd: request.cwd,
      ...agentFields,
      ...(name ? { name } : {}),
      ...(request.skillIds ? { skill_ids: [...request.skillIds] } : {}),
      ...(destination?.kind === "workspace" && tile
        ? { workspace_id: destination.workspaceId, tile }
        : {}),
    });
    workspaceId = destination?.kind === "workspace" ? destination.workspaceId : null;
  }

  const command = start?.command ?? (request.command?.trim() || null);
  if (command === null) return { status: "created", session, workspaceId, pendingCommand: false };
  try {
    // Queued for this incarnation of the window — the shell on the host it was
    // just made on — and typed only there.
    await dependencies.pending.persist(session.id, session.host_id, command);
    return { status: "created", session, workspaceId, pendingCommand: true };
  } catch (error) {
    return {
      status: "created_unqueued",
      session,
      workspaceId,
      command,
      message:
        error instanceof Error
          ? error.message
          : "The agent command could not be saved after the shell was created.",
    };
  }
}
