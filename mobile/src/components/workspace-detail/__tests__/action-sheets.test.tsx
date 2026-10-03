import { render } from "@testing-library/react-native";

import {
  MovePaneHostSheet,
  MovePaneSheet,
  PaneActionsSheet,
  TabActionsSheet,
  WorkspaceActionsSheet,
} from "@/components/workspace-detail/action-sheets";
import type { Tile } from "@/data/types/layout";

import { makeHost, makeSession, makeTab, makeWorkspace } from "./fixtures";

const mockActionSets: unknown[][] = [];

jest.mock("@/components/ui/action-sheet", () => ({
  ActionSheet: (props: Record<string, unknown>) => {
    mockActionSets.push((props["actions"] as unknown[]) ?? []);
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
