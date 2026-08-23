import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ArchivedWorkspacesView } from "@/components/workspaces/archived-workspaces-screen";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { borderWidth, ThemeProvider } from "@/theme";

const WORKSPACE: WorkspaceOut = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Suspended work",
  host_id: null,
  cwd: null,
  layout: {
    version: 3,
    active_tab: "tab-1",
    tabs: [
      {
        id: "tab-1",
        name: "main",
        host_id: null,
        cwd: null,
        layout: { version: 3, tiles: [] },
      },
    ],
  },
  position: 0,
  icon: null,
  icon_source: null,
  archived_at: "2026-08-22T00:00:00Z",
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function wrapper({ children }: React.PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("archived workspaces overlay", () => {
  test("uses the global header and shared navigation row", async () => {
    const onBack = jest.fn();
    const onOpen = jest.fn();
    const onRestore = jest.fn();
    const screen = await render(
      <ArchivedWorkspacesView
        loading={false}
        onBack={onBack}
        onDelete={jest.fn()}
        onOpen={onOpen}
        onRefresh={jest.fn()}
        onRestore={onRestore}
        refreshing={false}
        workspaces={[WORKSPACE]}
      />,
      { wrapper },
    );

    expect(screen.getAllByText("Archived workspaces")).toHaveLength(1);
    expect(screen.getByTestId("archived-workspaces-header")).toHaveStyle({
      borderBottomWidth: borderWidth.hairline,
      paddingTop: METRICS.insets.top,
    });
    expect(screen.getByTestId("screen-content")).toHaveStyle({ paddingTop: 0 });
    expect(screen.getByLabelText(/Suspended work, 1 tab · archived/)).toHaveStyle({
      borderRadius: borderWidth.none,
    });

    await fireEvent.press(screen.getByLabelText("Go back"));
    await fireEvent.press(screen.getByLabelText(/Suspended work, 1 tab · archived/));
    await fireEvent.press(screen.getByRole("button", { name: "Restore" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(WORKSPACE);
    expect(onRestore).toHaveBeenCalledWith(WORKSPACE);
  });

  test("keeps the existing suspend explanation and honest empty state", async () => {
    const screen = await render(
      <ArchivedWorkspacesView
        loading={false}
        onBack={jest.fn()}
        onDelete={jest.fn()}
        onOpen={jest.fn()}
        onRefresh={jest.fn()}
        onRestore={jest.fn()}
        refreshing={false}
        workspaces={[]}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Archive suspends a workspace/)).toBeOnTheScreen();
    expect(screen.getByText("No archived workspaces")).toBeOnTheScreen();
    expect(screen.getByText(/until you restore or permanently delete them/)).toBeOnTheScreen();
  });
});
