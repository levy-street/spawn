import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { pendingLaunches } from "@/components/launcher/pending-launch";
import { useWorkspaceActions } from "@/components/workspace-detail/use-workspace-actions";
import { createSession, deleteSession } from "@/data/api/endpoints/sessions";
import type { Tile } from "@/data/types/layout";

import { makeAgent, makeSession, makeTab, makeWorkspace } from "./fixtures";

jest.mock("@/data/api/endpoints/sessions", () => ({
  createSession: jest.fn(),
  deleteSession: jest.fn(async () => undefined),
  getSessionAccess: jest.fn(async () => ({ skills: [] })),
  moveSession: jest.fn(),
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
  pendingLaunches: {
    persist: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

jest.mock("expo-crypto", () => ({ randomUUID: () => "0b0e7c1e-1111-4a2a-9c3c-5d6e7f809102" }));

const codex = makeAgent({ id: "agent-codex", name: "codex", kind: "codex", command: "codex" });
const source = makeSession({ id: "source", agent_id: codex.id });
const copy = makeSession({ id: "copy", agent_id: codex.id });
const sourceTile: Tile = { session_id: source.id, x: 0, y: 0, w: 12, h: 24 };

/** A tab with room beside the source pane. */
function roomyWorkspace() {
  return makeWorkspace([makeTab("main", [sourceTile])]);
}

/** A tab already holding as many panes as a tab can. */
function fullWorkspace() {
  const tiles: Tile[] = Array.from({ length: 16 }, (_, index) => ({
    session_id: index === 0 ? source.id : `pane-${index}`,
    x: (index % 4) * 6,
    y: Math.floor(index / 4) * 6,
    w: 6,
    h: 6,
  }));
  return makeWorkspace([makeTab("main", tiles)]);
}

async function actions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Providers({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = await renderHook(() => useWorkspaceActions(jest.fn()), { wrapper: Providers });
  return hook.result.current;
}

describe("duplicating a pane", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (createSession as jest.Mock).mockResolvedValue(copy);
    (pendingLaunches.persist as jest.Mock).mockResolvedValue(undefined);
    mockCommit.mockImplementation(async (workspace: unknown) => workspace);
  });

  test("queues the copy's agent before the layout that shows it is saved", async () => {
    const workspace = roomyWorkspace();
    await (await actions()).duplicatePane(workspace, sourceTile, source, [codex]);

    // Exactly the source's grants: none, sent as none rather than left to
    // the account's defaults.
    expect((createSession as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      host_id: source.host_id,
      cwd: source.cwd,
      agent_id: codex.id,
      skill_ids: [],
    });
    expect(pendingLaunches.persist).toHaveBeenCalledWith(copy.id, copy.host_id, "codex");
    expect(mockCommit).toHaveBeenCalledTimes(1);
    const persisted = (pendingLaunches.persist as jest.Mock).mock.invocationCallOrder[0] ?? 0;
    const committed = mockCommit.mock.invocationCallOrder[0] ?? 0;
    expect(persisted).toBeLessThan(committed);
    const layout = mockCommit.mock.calls[0]?.[1] as {
      tabs: { layout: { tiles: Tile[] } }[];
    };
    expect(layout.tabs[0]?.layout.tiles.map((tile) => tile.session_id)).toContain(copy.id);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(pendingLaunches.clear).not.toHaveBeenCalled();
  });

  test("a full tab deletes the copy and clears its queued command", async () => {
    const duplicate = (await actions()).duplicatePane;
    await expect(duplicate(fullWorkspace(), sourceTile, source, [codex])).rejects.toThrow(
      "This tab is full — close a window before duplicating another.",
    );
    expect(mockCommit).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith(copy.id);
    expect(pendingLaunches.clear).toHaveBeenCalledWith(copy.id);
  });

  test("a layout that fails to save deletes the copy and clears its queued command", async () => {
    mockCommit.mockRejectedValue(new Error("layout conflict"));
    const duplicate = (await actions()).duplicatePane;
    await expect(duplicate(roomyWorkspace(), sourceTile, source, [codex])).rejects.toThrow(
      "layout conflict",
    );
    expect(deleteSession).toHaveBeenCalledWith(copy.id);
    expect(pendingLaunches.clear).toHaveBeenCalledWith(copy.id);
  });

  test("a copy whose agent could not be queued is still placed, and says it is a shell", async () => {
    (pendingLaunches.persist as jest.Mock).mockRejectedValue(new Error("storage full"));
    const duplicate = (await actions()).duplicatePane;
    await expect(duplicate(roomyWorkspace(), sourceTile, source, [codex])).rejects.toThrow(
      "The session was duplicated as a shell, but the agent command could not be saved.",
    );
    // The layout was saved with the copy in it; nothing was torn down.
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(pendingLaunches.clear).not.toHaveBeenCalled();
  });
});
