import { render } from "@testing-library/react-native";

import {
  MovePaneHostSheet,
  MovePaneSheet,
  PaneActionsSheet,
  TabActionsSheet,
  TabGroupPickerSheet,
  WorkspaceActionsSheet,
} from "@/components/workspace-detail/action-sheets";
import type { TabGroup, Tile } from "@/data/types/layout";

import { makeHost, makeSession, makeTab, makeWorkspace } from "./fixtures";

const mockActionSets: unknown[][] = [];
const mockSheetTitles: unknown[] = [];

jest.mock("@/components/ui/action-sheet", () => ({
  ActionSheet: (props: Record<string, unknown>) => {
    mockActionSets.push((props["actions"] as unknown[]) ?? []);
    mockSheetTitles.push(props["title"]);
    return null;
  },
}));

interface CapturedAction {
  id: string;
  disabled?: boolean;
  detail?: string;
  onPress: () => void;
}

function latestActions(): CapturedAction[] {
  return (mockActionSets.at(-1) ?? []) as CapturedAction[];
}

function expectEveryActionHandled(actions: readonly CapturedAction[]): void {
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(typeof action.onPress).toBe("function");
}

describe("workspace action sheets", () => {
  beforeEach(() => mockActionSets.splice(0));

  it("gives every pane command a handler and blocked boundary reason", async () => {
    const session = makeSession();
    const tile: Tile = { session_id: session.id, x: 0, y: 0, w: 24, h: 24 };
    const workspace = makeWorkspace([makeTab("main", [tile]), makeTab("tests")]);
    await render(
      <PaneActionsSheet
        agents={[]}
        onDismiss={jest.fn()}
        onDuplicate={jest.fn()}
        onMove={jest.fn()}
        onMoveToHost={jest.fn()}
        onRemove={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        onRestart={jest.fn()}
        onTranscripts={jest.fn()}
        sessionsById={new Map([[session.id, session]])}
        target={{ tabId: "main", tile }}
        visible
        workspace={workspace}
      />,
    );

    const actions = latestActions();
    expectEveryActionHandled(actions);
    expect(actions.find((action) => action.id === "move-up")).toMatchObject({
      disabled: true,
      detail: "Already first",
    });
  });

  it("lets a pane from a newer SPAWN D move or go, but never copies it blind", async () => {
    const tile: Tile = {
      session_id: "desktop-1",
      x: 0,
      y: 0,
      w: 12,
      h: 24,
      widget: { kind: "desktop", host_id: "host-1", desktop_id: "d1" },
    };
    const workspace = makeWorkspace([makeTab("main", [tile]), makeTab("tests")]);
    await render(
      <PaneActionsSheet
        agents={[]}
        onDismiss={jest.fn()}
        onDuplicate={jest.fn()}
        onMove={jest.fn()}
        onMoveToHost={jest.fn()}
        onRemove={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        onRestart={jest.fn()}
        onTranscripts={jest.fn()}
        sessionsById={new Map()}
        target={{ tabId: "main", tile }}
        visible
        workspace={workspace}
      />,
    );

    const actions = latestActions();
    expectEveryActionHandled(actions);
    expect(actions.map((action) => action.id)).toEqual([
      "move",
      "duplicate",
      "move-up",
      "move-down",
      "remove",
    ]);
    expect(actions.find((action) => action.id === "duplicate")).toMatchObject({
      disabled: true,
      detail: "Needs a newer SPAWN D",
    });
    expect(actions.find((action) => action.id === "remove")?.disabled).toBeFalsy();
  });

  it("explains disabled move destinations and wires every destination", async () => {
    const tile: Tile = { session_id: "session-1", x: 0, y: 0, w: 24, h: 24 };
    const workspace = makeWorkspace([makeTab("main", [tile]), makeTab("tests")]);
    await render(
      <MovePaneSheet
        onDismiss={jest.fn()}
        onMove={jest.fn()}
        tile={tile}
        visible
        workspace={workspace}
      />,
    );

    const actions = latestActions();
    expectEveryActionHandled(actions);
    expect(actions.find((action) => action.id === "main")).toMatchObject({
      disabled: true,
      detail: "Current tab",
    });
  });

  it("wires tab and workspace commands while naming their ceilings", async () => {
    const tabs = Array.from({ length: 8 }, (_, index) => makeTab(`tab-${index}`));
    const workspace = makeWorkspace(tabs);
    await render(
      <TabActionsSheet
        onDelete={jest.fn()}
        onDismiss={jest.fn()}
        onNewGroup={jest.fn()}
        onPickGroup={jest.fn()}
        onRemoveFromGroup={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        tab={tabs[0] ?? null}
        visible
        workspace={workspace}
      />,
    );
    expectEveryActionHandled(latestActions());

    await render(
      <WorkspaceActionsSheet
        canAddTab={false}
        onAddTab={jest.fn()}
        onDismiss={jest.fn()}
        onRename={jest.fn()}
        visible
        workspace={workspace}
      />,
    );
    const actions = latestActions();
    expectEveryActionHandled(actions);
    expect(actions.find((action) => action.id === "add-tab")).toMatchObject({
      disabled: true,
      detail: "A workspace can have up to 8 tabs",
    });
  });
});

describe("moving a window to another host", () => {
  beforeEach(() => mockActionSets.splice(0));

  it("offers other hosts' likeliest places, then any folder, and never the host it is on", async () => {
    const here = makeHost({ id: "host-1", name: "dream" });
    const there = makeHost({ id: "host-2", name: "studio" });
    const away = makeHost({ id: "host-3", name: "alto", status: "offline" });
    const pane = makeSession({ id: "pane", host_id: here.id, cwd: "/home/oem/spawn" });
    const neighbour = makeSession({ id: "neighbour", host_id: there.id, cwd: "/Users/me/site" });
    const onSelect = jest.fn();
    const onBrowse = jest.fn();
    await render(
      <MovePaneHostSheet
        hosts={[here, there, away]}
        onBrowse={onBrowse}
        onDismiss={jest.fn()}
        onSelect={onSelect}
        session={pane}
        sessions={[pane, neighbour]}
        tabSessionIds={["pane", "neighbour"]}
        visible
      />,
    );

    // The same sheet title as the browser's where chip.
    expect(mockSheetTitles.at(-1)).toBe("Where this runs");
    const actions = latestActions();
    expect(actions.map((action) => action.id)).toEqual([
      "host-2:/Users/me/site",
      "host-2:~",
      "host-3:~",
      "browse",
    ]);
    expect(actions[0]?.detail).toBe("studio · this tab");
    // An offline host is shown, and cannot be chosen.
    expect(actions[2]?.disabled).toBe(true);

    actions[0]?.onPress();
    expect(onSelect).toHaveBeenCalledWith(there, "/Users/me/site");
    actions[3]?.onPress();
    expect(onBrowse).toHaveBeenCalled();
  });
});

describe("tab group actions", () => {
  beforeEach(() => mockActionSets.splice(0));

  const agents: TabGroup = {
    id: "agents",
    name: "Agents",
    color: "orange",
    collapsed: false,
    tab_ids: ["tests"],
  };
  const unnamed: TabGroup = {
    id: "unnamed",
    name: "",
    color: "#ff8800",
    collapsed: false,
    tab_ids: ["docs"],
  };

  function groupedWorkspace(groups: TabGroup[]) {
    const workspace = makeWorkspace([makeTab("main"), makeTab("tests"), makeTab("docs")]);
    return { ...workspace, layout: { ...workspace.layout, groups } };
  }

  function sheetFor(tabId: string, groups: TabGroup[]) {
    const workspace = groupedWorkspace(groups);
    const handlers = {
      onNewGroup: jest.fn(),
      onPickGroup: jest.fn(),
      onRemoveFromGroup: jest.fn(),
    };
    const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId) ?? null;
    return { workspace, handlers, tab };
  }

  it("offers an ungrouped tab a new group, and the groups there are", async () => {
    const { workspace, handlers, tab } = sheetFor("main", [agents]);
    await render(
      <TabActionsSheet
        onDelete={jest.fn()}
        onDismiss={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        tab={tab}
        visible
        workspace={workspace}
        {...handlers}
      />,
    );
    const actions = latestActions() as Array<CapturedAction & { label: string }>;
    expect(actions.map((action) => action.label)).toEqual(
      expect.arrayContaining(["Add tab to new group", "Add tab to group…"]),
    );
    expect(actions.find((action) => action.id === "remove-from-group")).toBeUndefined();

    actions.find((action) => action.id === "new-group")?.onPress();
    expect(handlers.onNewGroup).toHaveBeenCalledWith(tab);
    actions.find((action) => action.id === "pick-group")?.onPress();
    expect(handlers.onPickGroup).toHaveBeenCalledWith(tab);
  });

  it("offers a grouped tab a move, and removal, but no picker with nowhere else to go", async () => {
    const { workspace, handlers, tab } = sheetFor("tests", [agents]);
    await render(
      <TabActionsSheet
        onDelete={jest.fn()}
        onDismiss={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        tab={tab}
        visible
        workspace={workspace}
        {...handlers}
      />,
    );
    const actions = latestActions() as Array<CapturedAction & { label: string }>;
    const labels = actions.map((action) => action.label);
    expect(labels).toContain("Move tab to new group");
    expect(labels).toContain("Remove from group");
    expect(labels).not.toContain("Move tab to group…");
    const remove = actions.find((action) => action.id === "remove-from-group");
    expect(remove?.detail).toBe("Agents");
    remove?.onPress();
    expect(handlers.onRemoveFromGroup).toHaveBeenCalledWith(tab);
  });

  it("names the move when a grouped tab has another group to go to", async () => {
    const { workspace, handlers, tab } = sheetFor("tests", [agents, unnamed]);
    await render(
      <TabActionsSheet
        onDelete={jest.fn()}
        onDismiss={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        tab={tab}
        visible
        workspace={workspace}
        {...handlers}
      />,
    );
    const labels = (latestActions() as Array<CapturedAction & { label: string }>).map(
      (action) => action.label,
    );
    expect(labels).toContain("Move tab to group…");
  });

  it("lists a new group, then every group the tab is not in, unnamed ones by that name", async () => {
    const { workspace, tab } = sheetFor("tests", [agents, unnamed]);
    const onNewGroup = jest.fn();
    const onPick = jest.fn();
    await render(
      <TabGroupPickerSheet
        onDismiss={jest.fn()}
        onNewGroup={onNewGroup}
        onPick={onPick}
        tab={tab}
        visible
        workspace={workspace}
      />,
    );
    const actions = latestActions() as Array<CapturedAction & { label: string; icon?: unknown }>;
    expect(actions.map((action) => action.label)).toEqual(["New group", "Unnamed group"]);
    expect(actions[1]?.icon).toBeTruthy();
    actions[0]?.onPress();
    expect(onNewGroup).toHaveBeenCalledWith(tab);
    actions[1]?.onPress();
    expect(onPick).toHaveBeenCalledWith(tab, unnamed);
  });
});
