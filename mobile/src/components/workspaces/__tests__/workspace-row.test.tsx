import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceListEmpty } from "@/components/workspaces/workspace-list-empty";
import { WorkspaceListError } from "@/components/workspaces/workspace-list-error";
import {
  WorkspaceRow,
  workspaceActionLabels,
  workspaceRollupLabel,
} from "@/components/workspaces/workspace-row";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { WorkspaceStats } from "@/data/types/domain";
import { ThemeProvider } from "@/theme";

jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual<typeof import("react-native-gesture-handler")>(
    "react-native-gesture-handler",
  );
  return { ...actual, GestureDetector: ({ children }: PropsWithChildren) => children };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function workspace(archived = false): WorkspaceOut {
  return {
    id: "workspace-1",
    name: "spawn mobile",
    host_id: null,
    cwd: null,
    layout: {
      version: 3,
      active_tab: "tab-1",
      tabs: [
        {
          id: "tab-1",
          name: "Tab 1",
          host_id: null,
          cwd: null,
          layout: { version: 3, tiles: [] },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: archived ? "2026-08-22T00:00:00Z" : null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}

const stats: WorkspaceStats = {
  tabs: 2,
  tiles: 5,
  terminals: 4,
  widgets: 1,
  running: 3,
  waiting: 1,
  dead: 0,
  attention: 1,
  remainingTabs: 6,
  nominalRemainingPanes: 27,
  archived: false,
  recency: 0,
};

const callbacks = {
  onOpen: jest.fn(),
  onRename: jest.fn(),
  onChangeIcon: jest.fn(),
  onDuplicate: jest.fn(),
  onArchive: jest.fn(),
  onUnarchive: jest.fn(),
  onDelete: jest.fn(),
};

describe("workspace list presentation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("renders selector-provided rollups and attention", async () => {
    const screen = await render(
      <WorkspaceRow {...callbacks} stats={stats} workspace={workspace()} />,
      { wrapper: Providers },
    );
    expect(screen.getByText("2 tabs · 3 running · 1 need attention")).toBeTruthy();
    expect(screen.getByLabelText("1 need attention")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/spawn mobile\. 2 tabs/));
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  test("defines active and archived action menus with the correct lifecycle action", () => {
    expect(workspaceActionLabels(false)).toEqual([
      "Rename",
      "Change icon",
      "Duplicate",
      "Archive",
      "Delete",
    ]);
    expect(workspaceActionLabels(true)).toEqual([
      "Rename",
      "Change icon",
      "Duplicate",
      "Restore",
      "Delete",
    ]);
  });

  test("exposes rename and lifecycle actions through swipe affordances", async () => {
    const active = await render(
      <WorkspaceRow {...callbacks} stats={stats} workspace={workspace()} />,
      { wrapper: Providers },
    );
    await fireEvent.press(active.getByLabelText("Rename"));
    await fireEvent.press(active.getByLabelText("Archive"));
    expect(callbacks.onRename).toHaveBeenCalledTimes(1);
    expect(callbacks.onArchive).toHaveBeenCalledTimes(1);
    await active.unmount();

    const archived = await render(
      <WorkspaceRow
        {...callbacks}
        stats={{ ...stats, archived: true }}
        workspace={workspace(true)}
      />,
      { wrapper: Providers },
    );
    await fireEvent.press(archived.getByLabelText("Restore"));
    expect(callbacks.onUnarchive).toHaveBeenCalledTimes(1);
    await archived.unmount();
  });

  test("renders empty search and recoverable error states", async () => {
    const onCreate = jest.fn();
    const empty = await render(<WorkspaceListEmpty onCreate={onCreate} query="missing" />, {
      wrapper: Providers,
    });
    expect(empty.getByText("No workspaces match")).toBeTruthy();
    expect(empty.getByText("Try a different name.")).toBeTruthy();
    await empty.unmount();

    const onRetry = jest.fn();
    const error = await render(<WorkspaceListError message="Offline" onRetry={onRetry} />, {
      wrapper: Providers,
    });
    expect(error.getByText("Workspaces unavailable")).toBeTruthy();
    expect(error.getByText("Offline")).toBeTruthy();
    await fireEvent.press(error.getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await error.unmount();
  });

  test("formats singular and no-attention rollups", () => {
    expect(workspaceRollupLabel({ ...stats, tabs: 1, running: 1, attention: 0 })).toBe(
      "1 tab · 1 running",
    );
  });
});
