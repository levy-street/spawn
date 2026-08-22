import { QueryClient } from "@tanstack/react-query";
import { reorderPaneLayout } from "@/components/workspace-detail/use-workspace-actions";
import { patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import * as mobileOrder from "@/data/layout/mobile-order";
import {
  commitWorkspaceLayout,
  createWorkspaceReorderDebouncer,
  WORKSPACE_REORDER_DEBOUNCE_MS,
} from "@/data/queries/workspace-detail";
import { qk } from "@/data/queryKeys";

import { makeTab, makeWorkspace } from "./fixtures";

jest.mock("@/data/api/endpoints/workspaces", () => {
  const actual = jest.requireActual<typeof import("@/data/api/endpoints/workspaces")>(
    "@/data/api/endpoints/workspaces",
  );
  return { ...actual, patchWorkspace: jest.fn() };
});

const patchWorkspaceMock = patchWorkspace as jest.MockedFunction<typeof patchWorkspace>;

describe("workspace mobile reorder", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses applyMobileOrder and PATCHes the complete preserved envelope", async () => {
    const main = makeTab("main", [
      { session_id: "one", x: 0, y: 0, w: 12, h: 24 },
      {
        session_id: "files",
        x: 12,
        y: 0,
        w: 12,
        h: 24,
        widget: { kind: "files", host_id: "host-1", path: "/work", view: "tree" },
      },
    ]);
    const inactive = makeTab("inactive", [
      { session_id: "other", x: 0, y: 0, w: 24, h: 24, untouched: true },
    ]);
    const workspace = makeWorkspace([main, inactive]);
    const applyMobileOrder = jest.spyOn(mobileOrder, "applyMobileOrder");
    const layout = reorderPaneLayout(workspace, "main", "files", -1);
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY, retry: false } },
    });
    client.setQueryData(qk.workspace(workspace.id), workspace);
    patchWorkspaceMock.mockResolvedValue({
      ...workspace,
      layout,
    } as unknown as WorkspaceOut);

    await commitWorkspaceLayout(client, workspace, layout);

    expect(applyMobileOrder).toHaveBeenCalledWith(main, ["files", "one"]);
    expect(patchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(patchWorkspaceMock).toHaveBeenCalledWith(workspace.id, { layout });
    expect(layout.tabs[1]).toEqual(inactive);
    expect(
      layout.tabs[0]?.layout.tiles.find((tile) => tile.session_id === "files")?.widget,
    ).toEqual({ kind: "files", host_id: "host-1", path: "/work", view: "tree" });
    applyMobileOrder.mockRestore();
  });

  it("coalesces rapid reorders into one PATCH after 500ms", async () => {
    jest.useFakeTimers();
    const workspace = makeWorkspace([
      makeTab("main", [
        { session_id: "one", x: 0, y: 0, w: 8, h: 24 },
        { session_id: "two", x: 8, y: 0, w: 8, h: 24 },
        { session_id: "three", x: 16, y: 0, w: 8, h: 24 },
      ]),
    ]);
    const first = reorderPaneLayout(workspace, "main", "three", -1);
    const optimistic = { ...workspace, layout: first };
    const second = reorderPaneLayout(optimistic, "main", "three", -1);
    const patch = jest.fn(async (_workspaceId: string, layout: typeof second) => ({
      ...workspace,
      layout,
    }));
    const onOptimistic = jest.fn();
    const debouncer = createWorkspaceReorderDebouncer({
      patch,
      onOptimistic,
      onSaved: jest.fn(),
      onRollback: jest.fn(),
    });

    debouncer.schedule(workspace, first);
    debouncer.schedule(optimistic, second);
    expect(patch).not.toHaveBeenCalled();
    expect(onOptimistic).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(WORKSPACE_REORDER_DEBOUNCE_MS);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(workspace.id, second);
    jest.useRealTimers();
  });

  it("rolls back to the last server value when a debounced PATCH fails", async () => {
    const workspace = makeWorkspace();
    const next = { ...workspace.layout, active_tab: "main" };
    const failure = new Error("conflict");
    const onRollback = jest.fn();
    const onError = jest.fn();
    const debouncer = createWorkspaceReorderDebouncer({
      patch: jest.fn(async () => Promise.reject(failure)),
      onOptimistic: jest.fn(),
      onSaved: jest.fn(),
      onRollback,
      onError,
      delayMs: 60_000,
    });
    debouncer.schedule(workspace, next);

    await expect(debouncer.flush()).rejects.toBe(failure);
    expect(onRollback).toHaveBeenCalledWith(workspace);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
