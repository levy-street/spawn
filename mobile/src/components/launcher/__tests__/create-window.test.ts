import {
  agentStart,
  type CreateWindowDependencies,
  createWindow,
  type LauncherError,
} from "@/components/launcher/create-window";
import type { SessionCreate, SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceCreate, WorkspaceOut } from "@/data/api/schemas/workspaces";
import { fullTab, makeAgent, makeHost, makeSession, makeTab, makeWorkspace } from "./fixtures";

const CONVERSATION = "50000000-0000-4000-8000-000000000001";

function harness(workspace: WorkspaceOut = makeWorkspace()) {
  const events: string[] = [];
  let current = workspace;
  const created = makeSession();
  const dependencies = {
    createSession: jest.fn(async (input: SessionCreate): Promise<SessionOut> => {
      events.push(`create:${input.host_id}:${input.cwd}`);
      return created;
    }),
    createWorkspace: jest.fn(async (_input: WorkspaceCreate) => {
      events.push("create-workspace");
      return {
        workspace: makeWorkspace({ id: "40000000-0000-4000-8000-000000000009" }),
        session: created,
      };
    }),
    getWorkspace: jest.fn(async () => current),
    patchWorkspace: jest.fn(async (_id: string, patch: { layout: WorkspaceOut["layout"] }) => {
      events.push("patch");
      current = { ...current, layout: patch.layout };
      return current;
    }),
    newId: jest.fn(() => CONVERSATION),
    pending: {
      persist: jest.fn(async (sessionId: string, hostId: string, command: string) => {
        events.push(`persist:${sessionId}@${hostId}`);
        return { sessionId, hostId, command, createdAt: 1, expiresAt: 2 };
      }),
    },
  } satisfies CreateWindowDependencies;
  return { dependencies, events, created, current: () => current };
}

const claude = makeAgent({
  id: "10000000-0000-4000-8000-000000000002",
  name: "Claude Code",
  kind: "claude-code",
  command: "claude",
  yolo_args: null,
});

describe("createWindow — the one way a window is opened", () => {
  test("a shell made on its own asks the server for a window and queues nothing", async () => {
    const { dependencies, events } = harness();
    const result = await createWindow({ host: makeHost(), cwd: "~", name: "  " }, dependencies);

    expect(result).toMatchObject({ status: "created", workspaceId: null, pendingCommand: false });
    expect(dependencies.createSession).toHaveBeenCalledWith({ host_id: makeHost().id, cwd: "~" });
    expect(events).toEqual([`create:${makeHost().id}:~`]);
  });

  test("an agent window names its conversation, records it, then queues the start for that host", async () => {
    const { dependencies, events, created } = harness();
    const result = await createWindow(
      { host: makeHost(), cwd: "/Users/ada/spawn", agent: claude },
      dependencies,
    );

    expect(dependencies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: claude.id, agent_session_id: CONVERSATION }),
    );
    expect(dependencies.pending.persist).toHaveBeenCalledWith(
      created.id,
      created.host_id,
      `claude --session-id ${CONVERSATION}`,
    );
    expect(events).toEqual([
      `create:${makeHost().id}:/Users/ada/spawn`,
      `persist:${created.id}@${created.host_id}`,
    ]);
    expect(result).toMatchObject({ status: "created", pendingCommand: true });
  });

  test("joining a tab saves the room first, with that tab made active", async () => {
    const second = makeTab({ id: "tab-2", name: "Tab 2" });
    const { dependencies, events, current } = harness(
      makeWorkspace({ layout: { version: 3, active_tab: "tab-1", tabs: [makeTab(), second] } }),
    );
    await createWindow(
      {
        host: makeHost(),
        cwd: "~",
        workspace: { kind: "workspace", workspaceId: makeWorkspace().id, tabId: "tab-2" },
      },
      dependencies,
    );

    expect(events).toEqual(["patch", `create:${makeHost().id}:~`]);
    expect(current().layout.active_tab).toBe("tab-2");
    expect(dependencies.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: makeWorkspace().id,
        tile: expect.objectContaining({ x: 0, y: 0 }),
      }),
    );
  });

  test("without a tab named, the window joins the workspace's active tab", async () => {
    const { dependencies, current } = harness();
    await createWindow(
      { host: makeHost(), cwd: "~", workspace: { kind: "workspace", workspaceId: "w" } },
      dependencies,
    );
    expect(current().layout.active_tab).toBe("tab-1");
    expect(current().layout.tabs[0]?.layout.tiles).toHaveLength(0);
  });

  test("a full tab is refused before anything is made", async () => {
    const { dependencies } = harness(
      makeWorkspace({ layout: { version: 3, active_tab: "tab-1", tabs: [fullTab()] } }),
    );
    await expect(
      createWindow(
        { host: makeHost(), cwd: "~", workspace: { kind: "workspace", workspaceId: "w" } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "tab_full" } satisfies Partial<LauncherError>);
    expect(dependencies.patchWorkspace).not.toHaveBeenCalled();
    expect(dependencies.createSession).not.toHaveBeenCalled();
  });

  test("making room keeps a pane from a newer SPAWN D exactly as it was", async () => {
    const desktop = {
      session_id: "desktop-1",
      x: 0,
      y: 0,
      w: 24,
      h: 24,
      widget: { kind: "desktop", display: "seat-1" },
    };
    const { dependencies, current } = harness(
      makeWorkspace({
        layout: {
          version: 3,
          active_tab: "tab-1",
          tabs: [makeTab({ layout: { version: 3, tiles: [desktop] } })],
        },
      }),
    );
    await createWindow(
      { host: makeHost(), cwd: "~", workspace: { kind: "workspace", workspaceId: "w" } },
      dependencies,
    );
    const kept = current().layout.tabs[0]?.layout.tiles.find(
      (tile) => tile.session_id === "desktop-1",
    );
    expect(kept?.widget).toEqual({ kind: "desktop", display: "seat-1" });
  });

  test("an explicit tile lands exactly there, with nothing re-laid out", async () => {
    const { dependencies } = harness();
    await createWindow(
      {
        host: makeHost(),
        cwd: "~",
        skillIds: ["60000000-0000-4000-8000-000000000001"],
        workspace: { kind: "workspace", workspaceId: "w", tile: { x: 8, y: 0, w: 8, h: 24 } },
      },
      dependencies,
    );
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.createSession).toHaveBeenCalledWith({
      host_id: makeHost().id,
      cwd: "~",
      skill_ids: ["60000000-0000-4000-8000-000000000001"],
      workspace_id: "w",
      tile: { x: 8, y: 0, w: 8, h: 24 },
    });
  });

  test("an explicit list of grants is sent as given, an empty one included", async () => {
    // Only an omitted list means the account's defaults: a copy of a window
    // with no skills must not gain the defaults its source never had. The
    // browser follows the same rule.
    const { dependencies } = harness();
    await createWindow({ host: makeHost(), cwd: "~", skillIds: [] }, dependencies);
    expect(dependencies.createSession).toHaveBeenLastCalledWith({
      host_id: makeHost().id,
      cwd: "~",
      skill_ids: [],
    });

    await createWindow(
      { host: makeHost(), cwd: "~", skillIds: [], workspace: { kind: "new-workspace" } },
      dependencies,
    );
    expect(dependencies.createWorkspace).toHaveBeenLastCalledWith({
      first_session: { host_id: makeHost().id, cwd: "~", skill_ids: [] },
    });

    await createWindow({ host: makeHost(), cwd: "~" }, dependencies);
    expect(dependencies.createSession).toHaveBeenLastCalledWith({
      host_id: makeHost().id,
      cwd: "~",
    });
  });

  test("a new workspace starts with the window, its agent and conversation included", async () => {
    const { dependencies, created } = harness();
    const result = await createWindow(
      { host: makeHost(), cwd: "~/code", agent: claude, workspace: { kind: "new-workspace" } },
      dependencies,
    );

    expect(dependencies.createWorkspace).toHaveBeenCalledWith({
      first_session: {
        host_id: makeHost().id,
        cwd: "~/code",
        agent_id: claude.id,
        agent_session_id: CONVERSATION,
      },
    });
    expect(dependencies.createSession).not.toHaveBeenCalled();
    expect(dependencies.pending.persist).toHaveBeenCalledWith(
      created.id,
      created.host_id,
      `claude --session-id ${CONVERSATION}`,
    );
    expect(result).toMatchObject({
      status: "created",
      workspaceId: "40000000-0000-4000-8000-000000000009",
    });
  });

  test("a stored command with no agent behind it is still typed", async () => {
    const { dependencies } = harness();
    await createWindow({ host: makeHost(), cwd: "~", command: " my-agent --fast " }, dependencies);
    expect(dependencies.createSession).toHaveBeenCalledWith({ host_id: makeHost().id, cwd: "~" });
    expect(dependencies.pending.persist).toHaveBeenCalledWith(
      makeSession().id,
      makeSession().host_id,
      "my-agent --fast",
    );
  });

  test("a command that cannot be queued leaves the shell and says so", async () => {
    const { dependencies } = harness();
    dependencies.pending.persist.mockRejectedValueOnce(new Error("Secure storage unavailable"));
    const result = await createWindow({ host: makeHost(), cwd: "~", agent: claude }, dependencies);
    expect(result).toMatchObject({
      status: "created_unqueued",
      command: `claude --session-id ${CONVERSATION}`,
      message: "Secure storage unavailable",
    });
  });

  test("agentStart spells a CLI that names its own conversations without an id", () => {
    const codex = makeAgent();
    const newId = jest.fn(() => CONVERSATION);
    expect(agentStart(codex, newId)).toEqual({
      agentId: codex.id,
      conversationId: null,
      command: "codex",
    });
    expect(newId).not.toHaveBeenCalled();
  });
});
