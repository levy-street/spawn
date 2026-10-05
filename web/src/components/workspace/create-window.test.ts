import { afterEach, describe, expect, test } from "bun:test";
import { type Agent, ApiError, type Session, type Skill, type Workspace } from "@/lib/api";
import type { Tile } from "@/lib/grid";
import type { LayoutV3 } from "@/lib/tabs";
import {
  type CreateWindowApi,
  createWindow,
  type DuplicateWindowApi,
  duplicateWindow,
  workspaceHasRoom,
} from "./create-window";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { pendingLaunch } from "./pending-launch";

const DREAM = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

const claude: Agent = {
  id: "55555555-5555-4555-8555-555555555555",
  owner_user_id: null,
  name: "Claude Code",
  kind: "claude-code",
  command: "claude",
  env: {},
  install: null,
  yolo_args: "--dangerously-skip-permissions",
  yolo_env: {},
  yolo: false,
};

function row(body: { host_id: string; cwd: string }): Session {
  return {
    id: SESSION,
    name: null,
    host_id: body.host_id,
    host_name: null,
    cwd: body.cwd,
    status: "starting",
    started_at: "2026-10-03T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "unknown",
    activity_label: "Unknown",
    foreground_command: null,
    agent_id: null,
    agent_session_id: null,
  };
}

function layout(tabs: Array<{ id: string; tiles: Tile[] }>, active = tabs[0]?.id): LayoutV3 {
  return {
    version: 3,
    active_tab: active as string,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      name: tab.id,
      layout: { version: 3, tiles: tab.tiles },
    })),
  } as LayoutV3;
}

function workspaceWith(current: LayoutV3): Workspace {
  return {
    id: WORKSPACE,
    name: "spawn",
    host_id: null,
    cwd: null,
    layout: current,
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
  } as Workspace;
}

/** The server, as far as opening a window goes, with every call written down. */
function fakeServer(current: LayoutV3 = layout([{ id: "main", tiles: [] }])) {
  const calls: Array<{ call: string; body?: unknown }> = [];
  let held = current;
  const api: CreateWindowApi = {
    createSession: async (body) => {
      calls.push({ call: "createSession", body });
      return row(body);
    },
    createWorkspace: async (body) => {
      calls.push({ call: "createWorkspace", body });
      const first = body?.first_session;
      return {
        workspace: workspaceWith(layout([{ id: "fresh", tiles: [] }])),
        session: first ? row(first) : null,
      };
    },
    getWorkspace: async () => {
      calls.push({ call: "getWorkspace" });
      return workspaceWith(held);
    },
    updateWorkspace: async (_id, body) => {
      calls.push({ call: "updateWorkspace", body });
      if (body.layout) held = body.layout;
      return workspaceWith(held);
    },
  };
  return { api, calls, layout: () => held };
}

afterEach(() => pendingLaunch.clear(SESSION));

describe("createWindow", () => {
  test("a shell joins its tab's band, the reshape landing before the create", async () => {
    const left: Tile = { session_id: "left", x: 0, y: 0, w: 24, h: 24 };
    const server = fakeServer(layout([{ id: "main", tiles: [left] }]));
    const created = await createWindow(
      { host: { id: DREAM }, cwd: "/srv", workspace: { id: WORKSPACE } },
      server.api,
    );
    expect(server.calls.map((call) => call.call)).toEqual([
      "getWorkspace",
      "updateWorkspace",
      "createSession",
    ]);
    const body = server.calls[2]?.body as Record<string, unknown>;
    expect(body.workspace_id).toBe(WORKSPACE);
    expect(body.tile).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    expect("agent_id" in body).toBe(false);
    expect("skill_ids" in body).toBe(false);
    // The sibling gave up half the band; the newcomer is not written twice.
    expect(server.layout().tabs[0]?.layout.tiles).toEqual([{ ...left, w: 12 }]);
    expect(created).toMatchObject({ workspaceId: WORKSPACE, tabId: "main" });
    expect(pendingLaunch.has(SESSION, DREAM)).toBe(false);
  });

  test("an agent window records its agent and conversation, and queues the launch on its host", async () => {
    const server = fakeServer();
    await createWindow(
      { host: { id: DREAM }, cwd: "/srv", agent: claude, workspace: { id: WORKSPACE } },
      server.api,
    );
    const body = server.calls.at(-1)?.body as { agent_id: string; agent_session_id: string };
    expect(body.agent_id).toBe(claude.id);
    expect(body.agent_session_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(pendingLaunch.take(SESSION, DREAM)).toBe(`claude --session-id ${body.agent_session_id}`);
  });

  test("lands in the named tab, made active so the server appends there", async () => {
    const server = fakeServer(
      layout(
        [
          { id: "one", tiles: [] },
          { id: "two", tiles: [] },
        ],
        "one",
      ),
    );
    const created = await createWindow(
      { host: { id: DREAM }, cwd: "~", workspace: { id: WORKSPACE, tabId: "two" } },
      server.api,
    );
    expect(server.layout().active_tab).toBe("two");
    expect(created.tabId).toBe("two");
  });

  test("an exact rect is taken as it is, with no layout write", async () => {
    const server = fakeServer();
    const tile = { x: 0, y: 0, w: 8, h: 8 };
    await createWindow(
      { host: { id: DREAM }, cwd: "/srv", workspace: { id: WORKSPACE, tile } },
      server.api,
    );
    expect(server.calls.map((call) => call.call)).toEqual(["createSession"]);
    expect((server.calls[0]?.body as { tile: unknown }).tile).toEqual(tile);
  });

  test("a full tab refuses before any window exists", async () => {
    const tiles: Tile[] = Array.from({ length: 16 }, (_, index) => ({
      session_id: `tile-${index}`,
      x: (index % 4) * 6,
      y: Math.floor(index / 4) * 6,
      w: 6,
      h: 6,
    }));
    const full = layout([{ id: "main", tiles }]);
    expect(workspaceHasRoom(full)).toBe(false);
    expect(workspaceHasRoom(layout([{ id: "main", tiles: [] }]))).toBe(true);
    const server = fakeServer(full);
    const refused = await createWindow(
      { host: { id: DREAM }, cwd: "/srv", workspace: { id: WORKSPACE } },
      server.api,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(isWorkspaceFullError(refused)).toBe(true);
    expect(server.calls.some((call) => call.call === "createSession")).toBe(false);
  });

  test("a new workspace starts with the window as its first session", async () => {
    const server = fakeServer();
    const created = await createWindow(
      { host: { id: DREAM }, cwd: "/srv", agent: claude, workspace: { new: true } },
      server.api,
    );
    expect(server.calls.map((call) => call.call)).toEqual(["createWorkspace"]);
    const body = server.calls[0]?.body as { name?: string; first_session: Record<string, unknown> };
    expect("name" in body).toBe(false);
    expect(body.first_session).toMatchObject({ host_id: DREAM, cwd: "/srv", agent_id: claude.id });
    expect(created).toMatchObject({ workspaceId: WORKSPACE, tabId: "fresh" });
    expect(pendingLaunch.has(SESSION, DREAM)).toBe(true);
  });

  test("a copy carries its skills and is placed by its caller", async () => {
    const server = fakeServer();
    const created = await createWindow(
      { host: { id: DREAM }, cwd: "/srv", skillIds: ["skill-a"] },
      server.api,
    );
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body.skill_ids).toEqual(["skill-a"]);
    expect("workspace_id" in body).toBe(false);
    expect(created).toMatchObject({ workspaceId: null, tabId: null });
    // An empty list is none, as given; only an omitted one is the defaults.
    await createWindow({ host: { id: DREAM }, cwd: "/srv", skillIds: [] }, server.api);
    expect((server.calls[1]?.body as Record<string, unknown>).skill_ids).toEqual([]);
    await createWindow({ host: { id: DREAM }, cwd: "/srv" }, server.api);
    expect("skill_ids" in (server.calls[2]?.body as object)).toBe(false);
  });

  test("a stored command with no definition behind it is typed, and types nothing", async () => {
    const server = fakeServer();
    await createWindow(
      { host: { id: DREAM }, cwd: "/srv", command: " aider --yes ", workspace: { id: WORKSPACE } },
      server.api,
    );
    expect("agent_id" in (server.calls.at(-1)?.body as object)).toBe(false);
    expect(pendingLaunch.take(SESSION, DREAM)).toBe("aider --yes");
  });
});

describe("duplicateWindow", () => {
  const source = {
    id: "66666666-6666-4666-8666-666666666666",
    host_id: DREAM,
    cwd: "/srv/app",
    agent_id: claude.id,
    foreground_command: null,
  };

  const skill = (id: string): Skill => ({
    id,
    owner_user_id: "77777777-7777-4777-8777-777777777777",
    name: id,
    description: "",
    content: "",
    enabled_by_default: true,
    created_at: "2026-10-03T00:00:00Z",
  });

  function withAccess(skills: string[] | Error) {
    const server = fakeServer();
    const reads: string[] = [];
    const api: DuplicateWindowApi = {
      ...server.api,
      readAccess: async (sessionId) => {
        reads.push(sessionId);
        if (skills instanceof Error) throw skills;
        return { session_id: sessionId, skills: skills.map(skill) };
      },
    };
    return { api, calls: server.calls, reads };
  }

  test("a window with no skills is copied with none, never the account's defaults", async () => {
    const server = withAccess([]);
    await duplicateWindow(source, [claude], server.api);
    expect(server.reads).toEqual([source.id]);
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body.skill_ids).toEqual([]);
  });

  test("a copy is the same kind of window with the same skills, placed by its caller", async () => {
    const server = withAccess(["skill-a", "skill-b"]);
    const created = await duplicateWindow(source, [claude], server.api);
    expect(server.calls.map((call) => call.call)).toEqual(["createSession"]);
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      host_id: DREAM,
      cwd: "/srv/app",
      agent_id: claude.id,
      skill_ids: ["skill-a", "skill-b"],
    });
    expect(body.agent_session_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect("workspace_id" in body).toBe(false);
    expect(created).toMatchObject({ workspaceId: null, tabId: null });
  });

  test("a source whose skills cannot be read is not copied", async () => {
    const server = withAccess(new ApiError(503, "unavailable", "unavailable"));
    const refused = await duplicateWindow(source, [claude], server.api).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect(server.calls).toEqual([]);
  });
});
