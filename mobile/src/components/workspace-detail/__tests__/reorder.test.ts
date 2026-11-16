import { QueryClient } from "@tanstack/react-query";
import {
  siblingShift,
  tabDestinationIndex,
  tabInsertionX,
} from "@/components/workspace-detail/tab-reorder";
import { reorderPaneLayout } from "@/components/workspace-detail/use-workspace-actions";
import { patchWorkspace } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import * as mobileOrder from "@/data/layout/mobile-order";
import { reorderTab } from "@/data/layout/tabs";
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
    // `groups` always travels, even when the domain layout never had the key.
    expect(patchWorkspaceMock).toHaveBeenCalledWith(workspace.id, {
      layout: { ...layout, groups: [] },
    });
    expect(layout.tabs[1]).toEqual(inactive);
    expect(
      layout.tabs[0]?.layout.tiles.find((tile) => tile.session_id === "files")?.widget,
    ).toEqual({ kind: "files", host_id: "host-1", path: "/work", view: "tree" });
    applyMobileOrder.mockRestore();
  });

  it("resolves every fixed-width tab drop and produces the expected order", () => {
    const geometry = { tabWidth: 160, tabGap: 6 };
    const step = geometry.tabWidth + geometry.tabGap;
    const tabs = Array.from({ length: 8 }, (_, index) => makeTab(`tab-${index}`));
    const workspace = makeWorkspace(tabs);

    for (let from = 0; from < tabs.length; from += 1) {
      for (let to = 0; to < tabs.length; to += 1) {
        const destination = tabDestinationIndex(from, (to - from) * step, tabs.length, geometry);
        const reordered = reorderTab(workspace.layout, tabs[from]?.id ?? "", destination);
        const expected = tabs.map((tab) => tab.id);
        const [moved] = expected.splice(from, 1);
        if (moved) expected.splice(to, 0, moved);

        expect(destination).toBe(to);
        expect(reordered.tabs.map((tab) => tab.id)).toEqual(expected);
        expect(reordered.active_tab).toBe(workspace.layout.active_tab);
      }
    }
  });

  it("crosses tabs at their real positions when a group label shares the row", () => {
    // Two tabs, a 100pt label, then two more: the gap after slot 1 is wider.
    const slotLefts = [0, 166, 432, 598];
    const geometry = { tabWidth: 160, tabGap: 6, slotLefts };

    // Slot 1 must travel past the label before it crosses slot 2's midpoint (512).
    expect(tabDestinationIndex(1, 185, 4, geometry)).toBe(1);
    expect(tabDestinationIndex(1, 187, 4, geometry)).toBe(2);
    expect(tabDestinationIndex(2, -186, 4, geometry)).toBe(2);
    expect(tabDestinationIndex(2, -187, 4, geometry)).toBe(1);
    // A sibling slides into its neighbour's place; labels never move.
    expect(siblingShift(2, 1, 2, geometry)).toBe(-266);
    expect(siblingShift(1, 2, 1, geometry)).toBe(266);
    expect(siblingShift(3, 1, 2, geometry)).toBe(0);
    expect(siblingShift(1, 1, 2, geometry)).toBe(0);
    expect(siblingShift(1, -1, -1, geometry)).toBe(0);
    expect(tabInsertionX(1, 2, geometry)).toBe(432 + 160 + 3);
    expect(tabInsertionX(2, 1, geometry)).toBe(166 - 3);
    expect(tabInsertionX(2, 2, geometry)).toBe(432);
  });

  it("changes destination only after the dragged edge crosses a neighbor midpoint", () => {
    const geometry = { tabWidth: 160, tabGap: 6 };

    expect(tabDestinationIndex(1, 85, 3, geometry)).toBe(1);
    expect(tabDestinationIndex(1, 87, 3, geometry)).toBe(2);
    expect(tabDestinationIndex(1, -85, 3, geometry)).toBe(1);
    expect(tabDestinationIndex(1, -87, 3, geometry)).toBe(0);
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
