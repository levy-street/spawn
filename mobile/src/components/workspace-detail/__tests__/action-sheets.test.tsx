import { render } from "@testing-library/react-native";

import {
  MovePaneSheet,
  PaneActionsSheet,
  TabActionsSheet,
  WorkspaceActionsSheet,
} from "@/components/workspace-detail/action-sheets";
import type { Tile } from "@/data/types/layout";

import { makeSession, makeTab, makeWorkspace } from "./fixtures";

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
        onRemove={jest.fn()}
        onRename={jest.fn()}
        onReorder={jest.fn()}
        onRestart={jest.fn()}
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
