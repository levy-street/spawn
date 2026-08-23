import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ArchivedWorkspacesView } from "@/components/longtail/archived-workspaces-screen";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { ThemeProvider } from "@/theme";

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

describe("archived workspaces", () => {
  test("explains suspend semantics and wires restore to the retained workspace", async () => {
    const onRestore = jest.fn();
    const screen = await render(
      <ArchivedWorkspacesView
        loading={false}
        onBack={jest.fn()}
        onDelete={jest.fn()}
        onOpen={jest.fn()}
        onRefresh={jest.fn()}
        onRestore={onRestore}
        refreshing={false}
        workspaces={[WORKSPACE]}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Archive suspends a workspace/)).toBeOnTheScreen();
    expect(screen.getByText("Suspended work")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(WORKSPACE);
  });

  test("renders an honest empty state", async () => {
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

    expect(screen.getByText("No archived workspaces")).toBeOnTheScreen();
    expect(screen.getByText(/until you restore or permanently delete them/)).toBeOnTheScreen();
  });
});
