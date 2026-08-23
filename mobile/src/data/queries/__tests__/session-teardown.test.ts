import { QueryClient } from "@tanstack/react-query";

import { makeTab, makeWorkspace } from "@/components/workspace-detail/__tests__/fixtures";
import { ApiError } from "@/data/api/client";
import { deleteSession } from "@/data/api/endpoints/sessions";
import { listWorkspaces, patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { killSession, removeSessionPanes } from "@/data/queries/session-teardown";
import { qk } from "@/data/queryKeys";
import type { Workspace } from "@/data/types/domain";
import type { Tile } from "@/data/types/layout";

jest.mock("@/data/api/endpoints/sessions", () => ({ deleteSession: jest.fn() }));
jest.mock("@/data/api/endpoints/workspaces", () => ({
  listWorkspaces: jest.fn(),
  patchWorkspace: jest.fn(),
}));

const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;
const mockListWorkspaces = listWorkspaces as jest.MockedFunction<typeof listWorkspaces>;
const mockPatchWorkspace = patchWorkspace as jest.MockedFunction<typeof patchWorkspace>;

function tile(sessionId: string, widget?: Tile["widget"]): Tile {
  return { session_id: sessionId, x: 0, y: 0, w: 6, h: 6, ...(widget ? { widget } : {}) };
}

function workspaceHolding(sessionId: string): Workspace {
  return makeWorkspace([makeTab("main", [tile("keep-me"), tile(sessionId)])]);
}

/** The list endpoint answers in wire shape; the fixtures are built in domain shape. */
function listed(workspace: Workspace): WorkspaceOut {
  return workspace as unknown as WorkspaceOut;
}

function paneIds(layout: Workspace["layout"]): string[] {
  return layout.tabs.flatMap((tab) => tab.layout.tiles.map((item) => item.session_id));
}

/** The layout the workspace was actually asked to save. */
function savedLayout(call = 0): Workspace["layout"] {
  const body = mockPatchWorkspace.mock.calls[call]?.[1];
  return body?.layout as Workspace["layout"];
}

let queryClient: QueryClient;

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockPatchWorkspace.mockImplementation(async (_id, body) => {
    const base = makeWorkspace();
    return { ...base, layout: body.layout ?? (base.layout as WorkspaceOut["layout"]) };
  });
});

// Left behind, a query's garbage-collection timer keeps the worker alive well
// past the assertions.
afterEach(() => queryClient.clear());

describe("killSession", () => {
  it("reports a session the server had already dropped as gone rather than failing", async () => {
    mockDeleteSession.mockRejectedValue(new ApiError(404, "not_found", "session not found"));

    await expect(killSession("session-1")).resolves.toEqual({ alreadyGone: true });
  });

  it("passes every other failure through", async () => {
    const failure = new ApiError(503, "unavailable", "host is offline");
    mockDeleteSession.mockRejectedValue(failure);

    await expect(killSession("session-1")).rejects.toBe(failure);
  });

  it("reports a live session as newly killed", async () => {
    mockDeleteSession.mockResolvedValue(undefined);

    await expect(killSession("session-1")).resolves.toEqual({ alreadyGone: false });
  });
});

describe("removeSessionPanes", () => {
  it("takes the dead pane out of a workspace already on the device", async () => {
    queryClient.setQueryData(qk.workspace("workspace-1"), workspaceHolding("session-1"));

    await expect(removeSessionPanes(queryClient, "session-1")).resolves.toBe(1);

    expect(mockListWorkspaces).not.toHaveBeenCalled();
    expect(paneIds(savedLayout())).toEqual(["keep-me"]);
  });

  it("finds the layout over the network when no workspace has been opened yet", async () => {
    mockListWorkspaces.mockResolvedValue([listed(workspaceHolding("session-1"))]);

    await expect(removeSessionPanes(queryClient, "session-1")).resolves.toBe(1);

    expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
    expect(paneIds(savedLayout())).toEqual(["keep-me"]);
  });

  it("leaves layouts alone when nothing points at the session", async () => {
    queryClient.setQueryData(qk.workspace("workspace-1"), workspaceHolding("other-session"));
    mockListWorkspaces.mockResolvedValue([]);

    await expect(removeSessionPanes(queryClient, "session-1")).resolves.toBe(0);

    expect(mockPatchWorkspace).not.toHaveBeenCalled();
  });

  it("never mistakes a files widget for the session it shares an id with", async () => {
    const widgetOnly = makeWorkspace([
      makeTab("main", [tile("session-1", { kind: "files", host_id: "host-1", path: "/tmp" })]),
    ]);
    queryClient.setQueryData(qk.workspace("workspace-1"), widgetOnly);
    mockListWorkspaces.mockResolvedValue([]);

    await expect(removeSessionPanes(queryClient, "session-1")).resolves.toBe(0);

    expect(mockPatchWorkspace).not.toHaveBeenCalled();
  });
});
