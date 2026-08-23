import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { pendingLaunches } from "@/components/launcher/pending-launch";
import { useWorkspaceActions } from "@/components/workspace-detail/use-workspace-actions";
import { createSession, deleteSession } from "@/data/api/endpoints/sessions";
import type { Tile } from "@/data/types/layout";

import { makeAgent, makeHost, makeSession, makeTab, makeWorkspace } from "./fixtures";

jest.mock("@/data/api/endpoints/sessions", () => ({
  createSession: jest.fn(),
  deleteSession: jest.fn(async () => undefined),
  getSessionAccess: jest.fn(async () => ({ skills: [] })),
  patchSession: jest.fn(),
  restartSession: jest.fn(),
}));

jest.mock("@/data/api/endpoints/workspaces", () => ({ patchWorkspace: jest.fn() }));

const mockCommit = jest.fn();

jest.mock("@/data/queries/workspace-detail", () => ({
  normalizeWorkspace: (value: unknown) => value,
  useWorkspaceLayoutCommit: () => mockCommit,
  useWorkspaceReorder: () => ({ schedule: jest.fn(), flush: jest.fn() }),
}));

jest.mock("@/components/launcher/pending-launch", () => ({
  pendingLaunches: { persist: jest.fn(async () => undefined) },
}));

const host = makeHost({ id: "host-2", name: "studio" });
const tile: Tile = { session_id: "session-1", x: 0, y: 0, w: 24, h: 24 };
const moved = makeSession({ id: "session-2", host_id: host.id, host_name: host.name });

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function actions() {
  const hook = await renderHook(() => useWorkspaceActions(jest.fn()), { wrapper: Providers });
  return hook.result.current;
}

describe("running a window on another host", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (createSession as jest.Mock).mockResolvedValue(moved);
  });

  test("starts the new shell before tearing the old one down, and keeps the tile's place", async () => {
    const workspace = makeWorkspace([makeTab("main", [tile]), makeTab("notes")]);
    mockCommit.mockResolvedValue(workspace);
    const order: string[] = [];
    (createSession as jest.Mock).mockImplementation(async () => {
      order.push("create");
      return moved;
    });
    (deleteSession as jest.Mock).mockImplementation(async () => {
      order.push("delete");
    });

    const result = await (await actions()).movePaneToHost(workspace, tile, host, makeSession(), []);

    expect(order).toEqual(["create", "delete"]);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ host_id: host.id, cwd: "~" }),
    );
    expect(deleteSession).toHaveBeenCalledWith("session-1");
    // Same rect, new session behind it.
    expect(mockCommit.mock.calls[0]?.[1].tabs[0].layout.tiles).toEqual([
      { session_id: moved.id, x: 0, y: 0, w: 24, h: 24 },
    ]);
    expect(result.session).toEqual(moved);
  });

  test("queues whatever agent was running so it comes back up on the new host", async () => {
    const agent = makeAgent({ command: "codex" });
    const workspace = makeWorkspace([makeTab("main", [tile])]);
    mockCommit.mockResolvedValue(workspace);

    await (await actions()).movePaneToHost(
      workspace,
      tile,
      host,
      makeSession({ foreground_command: "codex" }),
      [agent],
    );

    expect(pendingLaunches.persist).toHaveBeenCalledWith(moved.id, "codex");
  });

  test("removes the shell it just started when the layout write is refused", async () => {
    const workspace = makeWorkspace([makeTab("main", [tile])]);
    mockCommit.mockRejectedValue(new Error("workspace_full"));

    const move = (await actions()).movePaneToHost;
    await expect(move(workspace, tile, host, makeSession(), [])).rejects.toThrow("workspace_full");

    expect(deleteSession).toHaveBeenCalledWith(moved.id);
    // The window the person is looking at is left exactly as it was.
    expect(deleteSession).not.toHaveBeenCalledWith("session-1");
  });

  test("refuses a pane that is no longer in this workspace, creating nothing", async () => {
    const workspace = makeWorkspace([makeTab("main")]);

    const move = (await actions()).movePaneToHost;
    await expect(move(workspace, tile, host, makeSession(), [])).rejects.toThrow(
      "no longer in this workspace",
    );

    expect(createSession).not.toHaveBeenCalled();
  });
});
