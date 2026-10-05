import {
  type Agent,
  ApiError,
  type Host,
  type Session,
  sessionAccess,
  sessions,
  workspaces,
} from "@/lib/api";
import type { Rect } from "@/lib/grid";
import { sessionAgent } from "@/lib/sessions";
import { activeTab, type LayoutV3, tabById, withActiveTab, withTabTiles } from "@/lib/tabs";
import { agentLaunchCommand, newAgentConversationId } from "./agent-command";
import { pendingLaunch } from "./pending-launch";
import { addPaneTiles, PENDING_TILE_ID } from "./workspace-grid-helpers";

/**
 * The one way this app opens a window that runs something: the "+" menus,
 * the launcher, a duplicated pane or tab, a replayed template, and "New window
 * here…" on a host's page all come through here.
 *
 * A window is opened as a login shell; an agent window is a shell its agent
 * is typed into once the pane is connected (`pendingLaunch`). Recording the
 * agent and the conversation it starts under with the window is what makes it
 * that kind of window — so a duplicate opens as one too and a restart can
 * bring it back to that conversation.
 *
 * Anything a later SPAWN D has to settle with the host before the window
 * starts (which account it signs in as, what fences it) belongs here, so it
 * is settled once for every way of opening one.
 *
 * Widgets (the file explorer) are layout rather than windows that run
 * anything, and stay with the surfaces that place them.
 */

/** Where the window appears. */
export type WindowWorkspace =
  /**
   * In a tab of this workspace — at `tile`, when the caller has already made
   * room for it there, otherwise as an even share of the tab's band. `tabId`
   * defaults to the workspace's active tab.
   */
  | { id: string; tabId?: string; tile?: Rect }
  /** In a workspace of its own, made for it. */
  | { new: true; name?: string };

export interface CreateWindowInput {
  host: Pick<Host, "id">;
  cwd: string;
  /** The agent the window opens as; omitted or null for a plain shell. */
  agent?: Agent | null;
  /**
   * Typed into the shell when no agent definition stands behind it — a
   * template's stored command whose definition has since gone. Ignored with
   * `agent`, whose own launch command is typed instead.
   */
  command?: string | null;
  /**
   * The skills it is granted, exactly: an empty list grants none. Only an
   * omitted list means the account's defaults — what a new window from a
   * menu, the launcher or a template gets.
   */
  skillIds?: readonly string[];
  /** Omitted: in no workspace yet, for a caller that lands its tile itself. */
  workspace?: WindowWorkspace;
}

export interface CreatedWindow {
  session: Session;
  /** The workspace it appeared in; null when the caller places it. */
  workspaceId: string | null;
  /** The tab it appeared in, when it appeared in one. */
  tabId: string | null;
}

/** The calls it makes, so a test can stand in for the server. */
export interface CreateWindowApi {
  createSession: typeof sessions.create;
  createWorkspace: typeof workspaces.create;
  getWorkspace: typeof workspaces.get;
  updateWorkspace: typeof workspaces.update;
}

const SERVER: CreateWindowApi = {
  createSession: (body) => sessions.create(body),
  createWorkspace: (body) => workspaces.create(body),
  getWorkspace: (id) => workspaces.get(id),
  updateWorkspace: (id, body) => workspaces.update(id, body),
};

export async function createWindow(
  { host, cwd, agent = null, command = null, skillIds, workspace }: CreateWindowInput,
  api: CreateWindowApi = SERVER,
): Promise<CreatedWindow> {
  // The conversation this agent starts under, chosen here so the window can
  // record it and a restart can resume it; null for a CLI that names its own.
  const conversation = agent ? newAgentConversationId(agent.kind) : null;
  const launch = agent ? agentLaunchCommand(agent, conversation) : command?.trim() || null;
  const fields = {
    host_id: host.id,
    cwd,
    ...(agent && { agent_id: agent.id, agent_session_id: conversation }),
    // Absent and empty differ: absent grants the account's default skills,
    // empty grants none — a copy of a window with no skills stays without.
    ...(skillIds !== undefined && { skill_ids: [...skillIds] }),
  };
  const queue = (session: Session) => {
    if (launch) pendingLaunch.set(session.id, session.host_id, launch);
  };

  if (workspace && "new" in workspace) {
    const result = await api.createWorkspace({
      ...(workspace.name && { name: workspace.name }),
      first_session: fields,
    });
    if (!result.session) throw new Error("The workspace was created without its first session.");
    queue(result.session);
    return {
      session: result.session,
      workspaceId: result.workspace.id,
      tabId: activeTab(result.workspace.layout).id,
    };
  }

  if (!workspace) {
    const session = await api.createSession(fields);
    queue(session);
    return { session, workspaceId: null, tabId: null };
  }

  let tile = workspace.tile;
  let tabId = workspace.tabId ?? null;
  if (!tile) {
    const placed = await makeRoom(api, workspace.id, workspace.tabId);
    tile = placed.tile;
    tabId = placed.tabId;
  }
  const session = await api.createSession({ ...fields, workspace_id: workspace.id, tile });
  queue(session);
  return { session, workspaceId: workspace.id, tabId };
}

/** What a duplicate reads about its source, beside what any window makes. */
export interface DuplicateWindowApi extends CreateWindowApi {
  readAccess: typeof sessionAccess.get;
}

const DUPLICATE_SERVER: DuplicateWindowApi = {
  ...SERVER,
  readAccess: (sessionId) => sessionAccess.get(sessionId),
};

/**
 * A copy of a window, placed by its caller (a pane beside its source, a
 * duplicated tab): on the same host, in the same folder, the same kind of
 * window — its agent, in a conversation of its own — and with exactly the
 * skills its source holds, none when it holds none.
 *
 * Skills are read at launch, so they travel with the create rather than
 * being patched on afterwards. A source whose skills cannot be read is not
 * copied: the account's defaults could hand the copy skills its source never
 * had, and none could take away some it had.
 */
export async function duplicateWindow(
  source: Pick<Session, "id" | "host_id" | "cwd" | "agent_id" | "foreground_command">,
  definitions: readonly Agent[],
  api: DuplicateWindowApi = DUPLICATE_SERVER,
): Promise<CreatedWindow> {
  const access = await api.readAccess(source.id);
  return createWindow(
    {
      host: { id: source.host_id },
      cwd: source.cwd,
      // The copy is created as the same type of window, so it is one even
      // before its agent has taken the foreground — and stays one if the
      // agent is later quit.
      agent: sessionAgent(source, definitions),
      skillIds: access.skills.map((skill) => skill.id),
    },
    api,
  );
}

/**
 * Room for one more window in a tab: the window joins an even band rather
 * than halving the biggest occupant. That reshapes the siblings too, so the
 * layout lands before the create — the server refuses a tile overlapping
 * what it still thinks is there — and it lands with the tab made active,
 * because the server appends a new window to its active tab.
 */
async function makeRoom(
  api: CreateWindowApi,
  workspaceId: string,
  tabId: string | undefined,
): Promise<{ tile: Rect | undefined; tabId: string }> {
  const current = await api.getWorkspace(workspaceId);
  const tab = (tabId ? tabById(current.layout, tabId) : null) ?? activeTab(current.layout);
  const placed = addPaneTiles(tab.layout.tiles, PENDING_TILE_ID);
  if (!placed) throw new ApiError(409, "workspace_full", "workspace_full");
  const landed = placed.find((item) => item.session_id === PENDING_TILE_ID);
  // Nothing to reshape around: the server places it.
  if (!landed) return { tile: undefined, tabId: tab.id };
  await api.updateWorkspace(workspaceId, {
    layout: withActiveTab(
      withTabTiles(
        current.layout,
        tab.id,
        placed.filter((item) => item.session_id !== PENDING_TILE_ID),
      ),
      tab.id,
    ),
  });
  return { tile: { x: landed.x, y: landed.y, w: landed.w, h: landed.h }, tabId: tab.id };
}

/** Whether a tab of this workspace has room for one more window. */
export function workspaceHasRoom(layout: LayoutV3, tabId?: string): boolean {
  const tab = (tabId ? tabById(layout, tabId) : null) ?? activeTab(layout);
  return addPaneTiles(tab.layout.tiles, PENDING_TILE_ID) !== null;
}
