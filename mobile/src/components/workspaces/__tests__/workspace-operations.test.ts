import {
  duplicateWorkspaceDeep,
  instantiateWorkspaceTemplate,
  nextWorkspaceCopyName,
  type WorkspaceOperationDependencies,
} from "@/components/workspaces/workspace-operations";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";

function workspace(id = "workspace-new"): WorkspaceOut {
  return {
    id,
    name: "Source",
    host_id: "host-1",
    cwd: "/work",
    layout: {
      version: 3,
      active_tab: "tab-default",
      tabs: [
        {
          id: "tab-default",
          name: "Tab 1",
          host_id: null,
          cwd: null,
          layout: { version: 3, tiles: [] },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}

function session(overrides: Partial<SessionOut> = {}): SessionOut {
  return {
    id: "session-1",
    name: "Agent",
    host_id: "host-1",
    host_name: "Mac",
    cwd: "/work",
    status: "running",
    started_at: "2026-08-22T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Idle",
    foreground_command: "codex",
    ...overrides,
  };
}

function agent(): AgentOut {
  return {
    id: "agent-1",
    owner_user_id: null,
    name: "Codex",
    kind: "codex",
    command: "codex",
    env: {},
    install: null,
    yolo_args: null,
    yolo_env: {},
    yolo: false,
  };
}

function dependencyHarness() {
  let current = workspace();
  const randomId = jest.fn<string, []>();
  const createWorkspace = jest.fn<
    ReturnType<WorkspaceOperationDependencies["createWorkspace"]>,
    Parameters<WorkspaceOperationDependencies["createWorkspace"]>
  >(async (input) => {
    current = { ...workspace(), name: input.name ?? "Workspace" };
    return { workspace: current, session: null };
  });
  const getWorkspace = jest.fn<
    ReturnType<WorkspaceOperationDependencies["getWorkspace"]>,
    Parameters<WorkspaceOperationDependencies["getWorkspace"]>
  >(async () => current);
  const patchWorkspace = jest.fn<
    ReturnType<WorkspaceOperationDependencies["patchWorkspace"]>,
    Parameters<WorkspaceOperationDependencies["patchWorkspace"]>
  >(async (_id, patch) => {
    current = {
      ...current,
      ...(patch.name === undefined || patch.name === null ? {} : { name: patch.name }),
      ...(patch.layout === undefined || patch.layout === null ? {} : { layout: patch.layout }),
    };
    return current;
  });
  const deleteWorkspace = jest.fn<
    ReturnType<WorkspaceOperationDependencies["deleteWorkspace"]>,
    Parameters<WorkspaceOperationDependencies["deleteWorkspace"]>
  >(async () => undefined);
  const createSession = jest.fn<
    ReturnType<WorkspaceOperationDependencies["createSession"]>,
    Parameters<WorkspaceOperationDependencies["createSession"]>
  >(async () => session());
  const getSessionAccess = jest.fn<
    ReturnType<WorkspaceOperationDependencies["getSessionAccess"]>,
    Parameters<WorkspaceOperationDependencies["getSessionAccess"]>
  >(async () => ({
    session_id: "session-1",
    skills: [
      {
        id: "skill-1",
        owner_user_id: "owner-1",
        name: "Review",
        description: "",
        content: "Review code",
        enabled_by_default: true,
        created_at: "2026-08-20T00:00:00Z",
      },
    ],
  }));
  const pending = {
    persist: jest.fn(async (sessionId: string, command: string) => ({
      sessionId,
      command,
      createdAt: 1,
      expiresAt: 2,
    })),
    take: jest.fn(async () => ({ status: "missing" as const })),
    clear: jest.fn(async () => undefined),
  };
  const dependencies: WorkspaceOperationDependencies = {
    randomId,
    createWorkspace,
    getWorkspace,
    patchWorkspace,
    deleteWorkspace,
    createSession,
    getSessionAccess,
    pending,
  };
  return {
    dependencies,
    randomId,
    createWorkspace,
    patchWorkspace,
    deleteWorkspace,
    createSession,
    getSessionAccess,
    pending,
  };
}

describe("workspace lifecycle operations", () => {
  test("generates the same copy-name sequence as tabs", () => {
    expect(nextWorkspaceCopyName("Project", [])).toBe("Project copy");
    expect(nextWorkspaceCopyName("Project", ["Project copy", "Project copy 2"])).toBe(
      "Project copy 3",
    );
  });

  test("instantiates file, shell, and agent template tiles in tab order", async () => {
    const harness = dependencyHarness();
    harness.randomId.mockReturnValueOnce("tab-new").mockReturnValueOnce("widget-new");
    const template: WorkspaceTemplateOut = {
      id: "template-1",
      name: "Review setup",
      host_id: "host-1",
      cwd: "/work",
      spec: {
        version: 2,
        tabs: [
          {
            name: "Review",
            tiles: [
              { x: 0, y: 0, w: 8, h: 24, run: { kind: "files" } },
              { x: 8, y: 0, w: 8, h: 24, run: { kind: "shell" } },
              { x: 16, y: 0, w: 8, h: 24, run: { kind: "agent", command: "codex" } },
            ],
          },
        ],
      },
      icon: null,
      icon_source: null,
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-22T00:00:00Z",
    };

    const result = await instantiateWorkspaceTemplate(
      { template, agents: [agent()], name: "Mobile review" },
      harness.dependencies,
    );

    expect(harness.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mobile review", host_id: "host-1", cwd: "/work" }),
    );
    const initialLayout = harness.patchWorkspace.mock.calls[0]?.[1].layout;
    expect(initialLayout?.tabs[0]?.layout.tiles).toEqual([
      expect.objectContaining({
        session_id: "widget-new",
        widget: { kind: "files", host_id: "host-1", path: "/work" },
      }),
    ]);
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspace_id: "workspace-new", tile: { x: 8, y: 0, w: 8, h: 24 } }),
    );
    expect(harness.pending.persist).toHaveBeenCalledWith("session-1", "codex");
    expect(result.agentLaunchesSkipped).toBe(0);
    expect(result.workspace.layout.active_tab).toBe("tab-new");
  });

  test("duplicates tabs, widgets, sessions, and explicit skill grants", async () => {
    const harness = dependencyHarness();
    harness.randomId.mockReturnValueOnce("tab-copy").mockReturnValueOnce("widget-copy");
    const source = workspace("source");
    source.layout.tabs[0] = {
      id: "tab-source",
      name: "Work",
      host_id: null,
      cwd: null,
      layout: {
        version: 3,
        tiles: [
          {
            session_id: "widget-source",
            x: 0,
            y: 0,
            w: 8,
            h: 24,
            widget: { kind: "files", host_id: "host-1", path: "/work" },
          },
          { session_id: "session-1", x: 8, y: 0, w: 16, h: 24 },
        ],
      },
    };
    source.layout.active_tab = "tab-source";

    const result = await duplicateWorkspaceDeep(
      {
        workspace: source,
        sessions: [session()],
        agents: [agent()],
        existingNames: ["Source copy"],
      },
      harness.dependencies,
    );

    expect(harness.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Source copy 2", icon: null }),
    );
    expect(harness.getSessionAccess).toHaveBeenCalledWith("session-1");
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        cwd: "/work",
        name: "Agent",
        skill_ids: ["skill-1"],
        workspace_id: "workspace-new",
        tile: { x: 8, y: 0, w: 16, h: 24 },
      }),
    );
    expect(harness.pending.persist).toHaveBeenCalledWith("session-1", "codex");
    expect(result.agentLaunchesSkipped).toBe(0);
  });

  test("deletes a partial duplicate when recreation fails", async () => {
    const harness = dependencyHarness();
    harness.randomId.mockReturnValueOnce("tab-copy");
    harness.createSession.mockRejectedValueOnce(new Error("offline"));
    const source = workspace("source");
    source.layout.tabs[0]?.layout.tiles.push({
      session_id: "session-1",
      x: 0,
      y: 0,
      w: 24,
      h: 24,
    });

    await expect(
      duplicateWorkspaceDeep(
        { workspace: source, sessions: [session()], agents: [], existingNames: [] },
        harness.dependencies,
      ),
    ).rejects.toThrow("offline");
    expect(harness.deleteWorkspace).toHaveBeenCalledWith("workspace-new");
  });
});
