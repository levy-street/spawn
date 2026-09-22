import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren, ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceDetail } from "@/components/workspace-detail/workspace-detail";
import type { AgentIdentity, Session } from "@/data/types/domain";
import type { Tile, WorkspaceTab } from "@/data/types/layout";
import { ThemeProvider } from "@/theme";

import { makeSession, makeTab, makeWorkspace } from "./fixtures";

type CapturedProps = Record<string, unknown>;

interface CapturedGroups {
  launcher?: CapturedProps;
  header?: CapturedProps;
  tabStrip?: CapturedProps;
  paneList?: CapturedProps;
  paneActions?: CapturedProps;
  movePane?: CapturedProps;
  movePaneHost?: CapturedProps;
  tabActions?: CapturedProps;
  workspaceActions?: CapturedProps;
  rename?: CapturedProps;
  confirm?: CapturedProps;
}

const mockCaptured: CapturedGroups = {};
const mockGhost: { title: string; identity: AgentIdentity } = {
  title: "Implement mobile",
  identity: { kind: "codex", displayName: "Codex", logoKey: "codex", monogramSeed: "Codex" },
};
const mockOpenTerminal = jest.fn();
let mockWorkspace = makeWorkspace();
let mockSessions: Session[] = [];
const mockLaunchedSession: Session = {
  id: "launched-session",
  name: "Native session",
  host_id: "host-1",
  host_name: "office-mac",
  cwd: "/Users/spawn/dev/spawn",
  status: "running",
  started_at: "2026-08-22T00:00:00Z",
  exited_at: null,
  exit_code: null,
  last_output_at: null,
  last_input_at: null,
  last_activity_at: "2026-08-22T00:00:00Z",
  activity_state: "active",
  activity_label: "Active",
  foreground_command: null,
  agent_id: null,
  agent_session_id: null,
};
const mockWorkspaceActions = {
  createTab: jest.fn(async () => mockWorkspace),
  renameWorkspace: jest.fn(async () => mockWorkspace),
  renameTab: jest.fn(async () => mockWorkspace),
  reorderTab: jest.fn(),
  deleteTab: jest.fn(async () => mockWorkspace),
  renameSession: jest.fn(async () => mockLaunchedSession),
  restartSession: jest.fn(async () => mockLaunchedSession),
  movePane: jest.fn(async () => mockWorkspace),
  reorderPane: jest.fn(),
  removePane: jest.fn(async () => mockWorkspace),
  duplicatePane: jest.fn(async () => mockWorkspace),
  flushReorders: jest.fn(async () => null),
};

jest.mock("@/components/gestures/tab-pager", () => ({
  TabPager: ({
    pages,
    renderPage,
  }: {
    pages: readonly WorkspaceTab[];
    renderPage(tab: WorkspaceTab): ReactNode;
  }) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { View } = jest.requireActual<typeof import("react-native")>("react-native");
    return React.createElement(View, null, pages[0] ? renderPage(pages[0]) : null);
  },
}));

jest.mock("@/components/launcher/launcher-sheet", () => ({
  LauncherSheet: (props: CapturedProps) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");
    mockCaptured.launcher = props;
    return props["visible"]
      ? React.createElement(
          Pressable,
          {
            accessibilityLabel: "Complete launch",
            onPress: () => {
              if (typeof props["onLaunched"] === "function") {
                props["onLaunched"]({ session: mockLaunchedSession, pendingCommand: false });
              }
            },
          },
          React.createElement(Text, null, "Complete launch"),
        )
      : null;
  },
}));

jest.mock("@/components/workspace-detail/workspace-header", () => ({
  WorkspaceHeader: (props: CapturedProps) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { Pressable, Text, View } =
      jest.requireActual<typeof import("react-native")>("react-native");
    mockCaptured.header = props;
    return React.createElement(
      View,
      null,
      React.createElement(
        Pressable,
        {
          accessibilityLabel: "Header add",
          disabled: props["canAddPane"] !== true,
          onPress: props["onAddPane"] as () => void,
        },
        React.createElement(Text, null, "Header add"),
      ),
      React.createElement(
        Pressable,
        { accessibilityLabel: "Header actions", onPress: props["onActions"] as () => void },
        React.createElement(Text, null, "Header actions"),
      ),
    );
  },
}));

jest.mock("@/components/workspace-detail/tab-strip", () => ({
  TabStrip: (props: CapturedProps) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");
    mockCaptured.tabStrip = props;
    const tabs = props["tabs"] as WorkspaceTab[];
    const first = tabs[0];
    const onClose = props["onClose"];
    return first && tabs.length > 1
      ? React.createElement(
          Pressable,
          {
            accessibilityLabel: `Close ${first.name}`,
            onPress: () => {
              if (typeof onClose === "function") onClose(first);
            },
          },
          React.createElement(Text, null, `Close ${first.name}`),
        )
      : null;
  },
}));

jest.mock("@/components/workspace-detail/pane-list", () => ({
  PaneList: (props: CapturedProps) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");
    mockCaptured.paneList = props;
    return React.createElement(
      Pressable,
      { accessibilityLabel: "Pane add", onPress: props["onAddPane"] as () => void },
      React.createElement(Text, null, "Pane add"),
    );
  },
}));

jest.mock("@/components/workspace-detail/action-sheets", () => ({
  PaneActionsSheet: (props: CapturedProps) => {
    mockCaptured.paneActions = props;
    return null;
  },
  MovePaneSheet: (props: CapturedProps) => {
    mockCaptured.movePane = props;
    return null;
  },
  MovePaneHostSheet: (props: CapturedProps) => {
    mockCaptured.movePaneHost = props;
    return null;
  },
  TabActionsSheet: (props: CapturedProps) => {
    mockCaptured.tabActions = props;
    return null;
  },
  WorkspaceActionsSheet: (props: CapturedProps) => {
    mockCaptured.workspaceActions = props;
    return null;
  },
}));

jest.mock("@/components/workspace-detail/rename-dialog", () => ({
  RenameDialog: (props: CapturedProps) => {
    mockCaptured.rename = props;
    return null;
  },
}));

jest.mock("@/components/ui/confirm", () => ({
  Confirm: (props: CapturedProps) => {
    mockCaptured.confirm = props;
    return null;
  },
}));

jest.mock("@/data/queries/workspace-detail", () => ({
  useWorkspaceDetail: () => ({
    workspace: { data: mockWorkspace, refetch: jest.fn() },
    sessions: { data: mockSessions },
    hosts: { data: [] },
    agents: { data: [] },
    loading: false,
    refreshing: false,
    refresh: jest.fn(),
    error: null,
  }),
}));

jest.mock("@/components/workspace-detail/use-workspace-actions", () => ({
  useWorkspaceActions: () => mockWorkspaceActions,
}));

jest.mock("@/data/stores/connection", () => ({
  useConnectionStore: (selector: (state: { sessionTransports: object }) => unknown) =>
    selector({ sessionTransports: {} }),
}));

const mockToast = {
  show: jest.fn(),
  success: jest.fn(),
  error: jest.fn(),
  dismiss: jest.fn(),
  clear: jest.fn(),
};

jest.mock("@/components/ui/toast", () => ({ useToast: () => mockToast }));

function Providers({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, right: 0, bottom: 34, left: 0 },
      }}
    >
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

function expectHandlers(group: keyof CapturedGroups, names: readonly string[]): void {
  const props = mockCaptured[group];
  expect(props).toBeDefined();
  for (const name of names) expect(typeof props?.[name]).toBe("function");
}

describe("workspace action wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspace = makeWorkspace();
    mockSessions = [];
    for (const key of Object.keys(mockCaptured) as Array<keyof CapturedGroups>) {
      delete mockCaptured[key];
    }
  });

  it("routes the header plus and ellipsis to mounted, visible sheets", async () => {
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    expect(mockCaptured.launcher?.["visible"]).toBe(false);
    expect(mockCaptured.workspaceActions?.["visible"]).toBe(false);

    await fireEvent.press(screen.getByLabelText("Header add"));
    expect(mockCaptured.launcher?.["visible"]).toBe(true);
    expect(mockCaptured.launcher?.["initialTabId"]).toBe("main");

    await act(() => {
      (mockCaptured.launcher?.["onDismiss"] as (() => void) | undefined)?.();
    });
    await fireEvent.press(screen.getByLabelText("Header actions"));
    expect(mockCaptured.workspaceActions?.["visible"]).toBe(true);
  });

  it("opens the launcher from each add-pane affordance for the active tab", async () => {
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    expect(mockCaptured.launcher?.["visible"]).toBe(false);
    await fireEvent.press(screen.getByLabelText("Header add"));
    expect(mockCaptured.launcher?.["visible"]).toBe(true);
    expect(mockCaptured.launcher?.["initialTabId"]).toBe("main");
    await fireEvent.press(screen.getByLabelText("Complete launch"));
    expect(mockOpenTerminal).toHaveBeenCalledWith(mockLaunchedSession.id);
    expect(mockCaptured.launcher?.["visible"]).toBe(false);

    await fireEvent.press(screen.getByLabelText("Pane add"));
    expect(mockCaptured.launcher?.["visible"]).toBe(true);
    expect(mockCaptured.launcher?.["initialTabId"]).toBe("main");
    await screen.unmount();
  });

  it("opens workspace actions from the header ellipsis", async () => {
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    expect(mockCaptured.workspaceActions?.["visible"]).toBe(false);
    await fireEvent.press(screen.getByLabelText("Header actions"));
    expect(mockCaptured.workspaceActions?.["visible"]).toBe(true);
  });

  it("disables the header add control at the 16-pane ceiling", async () => {
    const tiles: Tile[] = Array.from({ length: 16 }, (_, index) => ({
      session_id: `session-${index}`,
      x: index,
      y: 0,
      w: 4,
      h: 4,
    }));
    mockWorkspace = makeWorkspace([makeTab("main", tiles)]);
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    const add = screen.getByLabelText("Header add");
    expect(add).toBeDisabled();
    await fireEvent.press(add);
    expect(mockCaptured.launcher?.["visible"]).toBe(false);
  });

  it("confirms a close with live sessions and removes only after confirmation", async () => {
    const session = makeSession();
    mockSessions = [session];
    mockWorkspace = makeWorkspace([
      makeTab("main", [{ session_id: session.id, x: 0, y: 0, w: 24, h: 24 }]),
      makeTab("tests"),
    ]);
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    await fireEvent.press(screen.getByLabelText("Close main"));
    expect(mockCaptured.confirm?.["visible"]).toBe(true);
    expect(mockCaptured.confirm?.["title"]).toBe("Close main?");
    expect(mockWorkspaceActions.deleteTab).not.toHaveBeenCalled();

    await act(async () => {
      (mockCaptured.confirm?.["onConfirm"] as (() => void) | undefined)?.();
    });
    await waitFor(() =>
      expect(mockWorkspaceActions.deleteTab).toHaveBeenCalledWith(mockWorkspace, "main"),
    );
  });

  it("says what happened when a session pane is closed out from under its row", async () => {
    const session = makeSession();
    mockSessions = [session];
    const tile = { session_id: session.id, x: 0, y: 0, w: 24, h: 24 };
    mockWorkspace = makeWorkspace([makeTab("main", [tile])]);
    await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    await act(async () => {
      (mockCaptured.paneList?.["onPaneActions"] as ((target: unknown) => void) | undefined)?.(tile);
    });
    await act(async () => {
      (mockCaptured.paneActions?.["onRemove"] as ((target: unknown) => void) | undefined)?.(tile);
    });
    expect(mockCaptured.confirm?.["title"]).toBe("Close session?");

    await act(async () => {
      (mockCaptured.confirm?.["onConfirm"] as (() => void) | undefined)?.();
    });

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("Session killed"));
  });

  it("closes an empty tab immediately without destructive confirmation", async () => {
    mockWorkspace = makeWorkspace([makeTab("main"), makeTab("tests")]);
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    await fireEvent.press(screen.getByLabelText("Close main"));
    await waitFor(() =>
      expect(mockWorkspaceActions.deleteTab).toHaveBeenCalledWith(mockWorkspace, "main"),
    );
    expect(mockCaptured.confirm?.["visible"]).toBe(false);
  });

  it("persists only the final absolute tab destination from a drag drop", async () => {
    mockWorkspace = makeWorkspace([makeTab("main"), makeTab("tests"), makeTab("server")]);
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    await act(async () => {
      (
        mockCaptured.tabStrip?.["onReorder"] as
          | ((tabId: string, toIndex: number) => void)
          | undefined
      )?.("main", 2);
    });
    expect(mockWorkspaceActions.reorderTab).toHaveBeenCalledTimes(1);
    expect(mockWorkspaceActions.reorderTab).toHaveBeenCalledWith(mockWorkspace, "main", 2);
    await screen.unmount();
  });

  it("supplies a function for every action exposed by the workspace screen", async () => {
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    expectHandlers("header", ["onBack", "onAddPane", "onActions"]);
    expectHandlers("tabStrip", ["onSelect", "onActions", "onAdd", "onClose", "onReorder"]);
    // Rename, move and remove reach the pane through its ... sheet only; the row
    // itself no longer takes them, since round 7 removed the swipe shortcut.
    expectHandlers("paneList", [
      "onAddPane",
      "onOpenTerminal",
      "onOpenFiles",
      "onPaneActions",
      // A tab is refetched by pulling its own list, not only by leaving and
      // coming back to the workspace.
      "onRefresh",
    ]);
    expect(mockCaptured.paneList?.["refreshing"]).toBe(false);
    expectHandlers("paneActions", [
      "onDismiss",
      "onRename",
      "onMove",
      "onDuplicate",
      "onReorder",
      "onRestart",
      "onRemove",
    ]);
    expectHandlers("movePane", ["onDismiss", "onMove"]);
    expectHandlers("tabActions", ["onDismiss", "onRename", "onReorder", "onDelete"]);
    expectHandlers("workspaceActions", ["onDismiss", "onRename", "onAddTab"]);
    expectHandlers("rename", ["onDismiss", "onSubmit"]);
    expectHandlers("confirm", ["onCancel", "onConfirm"]);
    expectHandlers("launcher", ["onDismiss", "onLaunchError", "onLaunched"]);
    await screen.unmount();
  });

  it("moves a carried pane into the tab it was dropped on, and follows it there", async () => {
    const tile: Tile = { session_id: "session-1", x: 0, y: 0, w: 24, h: 24 };
    mockWorkspace = makeWorkspace([makeTab("main", [tile]), makeTab("notes")]);
    mockSessions = [makeSession()];
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    const begin = mockCaptured.paneList?.["onPaneDragBegin"] as
      | ((tile: Tile, ghost: typeof mockGhost) => void)
      | undefined;
    const drop = mockCaptured.paneList?.["onPaneDragEnd"] as
      | ((tabIndex: number) => void)
      | undefined;
    expect(begin).toBeDefined();

    await act(async () => begin?.(tile, mockGhost));
    await act(async () => drop?.(1));

    expect(mockWorkspaceActions.movePane).toHaveBeenCalledWith(mockWorkspace, "session-1", "notes");
    await waitFor(() => expect(mockCaptured.tabStrip?.["activeIndex"]).toBe(1));
    await screen.unmount();
  });

  it("leaves a pane where it is when it is let go over its own tab or over nothing", async () => {
    const tile: Tile = { session_id: "session-1", x: 0, y: 0, w: 24, h: 24 };
    mockWorkspace = makeWorkspace([makeTab("main", [tile]), makeTab("notes")]);
    mockSessions = [makeSession()];
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    const begin = mockCaptured.paneList?.["onPaneDragBegin"] as
      | ((tile: Tile, ghost: typeof mockGhost) => void)
      | undefined;
    const drop = mockCaptured.paneList?.["onPaneDragEnd"] as
      | ((tabIndex: number) => void)
      | undefined;

    await act(async () => begin?.(tile, mockGhost));
    await act(async () => drop?.(0));
    await act(async () => begin?.(tile, mockGhost));
    await act(async () => drop?.(-1));

    expect(mockWorkspaceActions.movePane).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("offers no pane drag at all while the workspace has a single tab", async () => {
    mockWorkspace = makeWorkspace([makeTab("main")]);
    mockSessions = [];
    const screen = await render(
      <WorkspaceDetail
        onBack={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={mockOpenTerminal}
        workspaceId={mockWorkspace.id}
      />,
      { wrapper: Providers },
    );

    expect(mockCaptured.paneList?.["onPaneDragBegin"]).toBeUndefined();
    expect(mockCaptured.paneList?.["paneDrag"]).toBeUndefined();
    await screen.unmount();
  });
});
