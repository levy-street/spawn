import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { makeTab, makeWorkspace } from "@/components/workspace-detail/__tests__/fixtures";
import {
  deleteSessionsForTab,
  useWorkspaceActions,
} from "@/components/workspace-detail/use-workspace-actions";
import { ApiError } from "@/data/api/client";
import { deleteSession } from "@/data/api/endpoints/sessions";
import { patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { Workspace } from "@/data/types/domain";
import type { Tile } from "@/data/types/layout";

jest.mock("@/data/api/endpoints/sessions", () => ({
  createSession: jest.fn(),
  deleteSession: jest.fn(),
  getSessionAccess: jest.fn(),
  patchSession: jest.fn(),
  restartSession: jest.fn(),
}));
jest.mock("@/data/api/endpoints/workspaces", () => ({
  listWorkspaces: jest.fn(),
  patchWorkspace: jest.fn(),
}));

const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;
const mockPatchWorkspace = patchWorkspace as jest.MockedFunction<typeof patchWorkspace>;

function tile(sessionId: string): Tile {
  return { session_id: sessionId, x: 0, y: 0, w: 6, h: 6 };
}

function paneIds(layout: Workspace["layout"]): string[] {
  return layout.tabs.flatMap((tab) => tab.layout.tiles.map((item) => item.session_id));
}

let queryClient: QueryClient;

function Providers({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockPatchWorkspace.mockImplementation(async (_id, body) => {
    const base = makeWorkspace();
    return { ...base, layout: body.layout ?? (base.layout as WorkspaceOut["layout"]) };
  });
});

afterEach(() => queryClient.clear());

describe("removing a pane whose session is already gone", () => {
  it("clears the dead row instead of failing on the missing session", async () => {
    mockDeleteSession.mockRejectedValue(new ApiError(404, "not_found", "session not found"));
    const workspace = makeWorkspace([makeTab("main", [tile("alive"), tile("dead")])]);
    const { result } = await renderHook(() => useWorkspaceActions(jest.fn()), {
      wrapper: Providers,
    });

    await result.current.removePane(workspace, tile("dead"));

    const body = mockPatchWorkspace.mock.calls[0]?.[1];
    expect(paneIds(body?.layout as Workspace["layout"])).toEqual(["alive"]);
  });

  it("still reports a session the host genuinely refused to kill", async () => {
    const failure = new ApiError(503, "unavailable", "host is offline");
    mockDeleteSession.mockRejectedValue(failure);
    const workspace = makeWorkspace([makeTab("main", [tile("dead")])]);
    const { result } = await renderHook(() => useWorkspaceActions(jest.fn()), {
      wrapper: Providers,
    });

    await expect(result.current.removePane(workspace, tile("dead"))).rejects.toBe(failure);
    expect(mockPatchWorkspace).not.toHaveBeenCalled();
  });

  it("lets a tab close over sessions the server had already dropped", async () => {
    mockDeleteSession.mockRejectedValue(new ApiError(404, "not_found", "session not found"));

    await expect(deleteSessionsForTab(["one", "two"])).resolves.toBeUndefined();
    expect(mockDeleteSession).toHaveBeenCalledTimes(2);
  });
});
