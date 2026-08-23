import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceListScreen } from "@/components/workspaces/workspace-list-screen";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { borderWidth, ThemeProvider } from "@/theme";

interface CapturedFlashListProps {
  contentContainerStyle?: StyleProp<ViewStyle>;
  data: ReadonlyArray<{ workspace: { id: string } }>;
  ItemSeparatorComponent?: ComponentType;
  ListFooterComponent?: ReactNode;
  keyExtractor(item: { workspace: { id: string } }): string;
  onRefresh(): void;
  refreshing: boolean;
  testID?: string;
}

const mockFlashListRenders: CapturedFlashListProps[] = [];
let mockFlashListMounts = 0;
let mockSessionsRefetching = false;
let mockCreateVisible = false;
const mockPush = jest.fn();
const mockRefetchWorkspaces = jest.fn(() => Promise.resolve({}));
const mockRefetchArchived = jest.fn(() => Promise.resolve({}));
const mockRefetchSessions = jest.fn(() => Promise.resolve({}));
const mockRefetchTemplates = jest.fn(() => Promise.resolve({}));
const mockToast = { success: jest.fn(), error: jest.fn() };

const mockWorkspace: WorkspaceOut = {
  id: "workspace-1",
  name: "Native",
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
  archived_at: null,
  created_at: "2026-08-22T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z",
};
const mockWorkspaces = [
  mockWorkspace,
  { ...mockWorkspace, id: "workspace-2", name: "Web", position: 1 },
];
const mockArchived: WorkspaceOut[] = [
  {
    ...mockWorkspace,
    id: "workspace-archived",
    name: "Archived native",
    archived_at: "2026-08-22T00:00:00Z",
  },
];
const mockSessions: never[] = [];
const mockTemplates: never[] = [];
const mockAgents: never[] = [];
const mockMutation = { isPending: false, mutate: jest.fn() };

jest.mock("@shopify/flash-list", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    FlashList: (props: CapturedFlashListProps) => {
      React.useEffect(() => {
        mockFlashListMounts += 1;
      }, []);
      mockFlashListRenders.push(props);
      const Separator = props.ItemSeparatorComponent;
      return React.createElement(
        View,
        { testID: props.testID },
        props.data.length > 1 && Separator !== undefined ? React.createElement(Separator) : null,
        props.ListFooterComponent ?? null,
      );
    },
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/components/ui/toast", () => ({ useToast: () => mockToast }));
jest.mock("@/components/workspaces/change-workspace-icon-sheet", () => ({
  ChangeWorkspaceIconSheet: () => null,
}));
jest.mock("@/components/workspaces/create-workspace-dialog", () => ({
  CreateWorkspaceDialog: ({ visible }: { visible: boolean }) => {
    mockCreateVisible = visible;
    return null;
  },
}));
jest.mock("@/components/workspaces/rename-workspace-dialog", () => ({
  RenameWorkspaceDialog: () => null,
}));

jest.mock("@/data/queries/workspaces", () => ({
  useWorkspacesQuery: (archived = false) =>
    archived
      ? {
          data: mockArchived,
          error: null,
          isLoading: false,
          isRefetching: false,
          refetch: mockRefetchArchived,
        }
      : {
          data: mockWorkspaces,
          error: null,
          isLoading: false,
          isRefetching: false,
          refetch: mockRefetchWorkspaces,
        },
  useWorkspaceSessionsQuery: () => ({
    data: mockSessions,
    error: null,
    isRefetching: mockSessionsRefetching,
    refetch: mockRefetchSessions,
  }),
  useWorkspaceTemplatesQuery: () => ({
    data: mockTemplates,
    refetch: mockRefetchTemplates,
  }),
  useWorkspaceAgentsQuery: () => ({ data: mockAgents }),
  useCreateWorkspaceMutation: () => mockMutation,
  useRenameWorkspaceMutation: () => mockMutation,
  useChangeWorkspaceIconMutation: () => mockMutation,
  useArchiveWorkspaceMutation: () => mockMutation,
  useUnarchiveWorkspaceMutation: () => mockMutation,
  useDeleteWorkspaceMutation: () => mockMutation,
  writeWorkspaceCaches: jest.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: { retry: false },
  },
});

function Providers({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, right: 0, bottom: 34, left: 0 },
        }}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

function latestList(): CapturedFlashListProps {
  const current = mockFlashListRenders[mockFlashListRenders.length - 1];
  if (!current) throw new Error("Workspace list did not render.");
  return current;
}

describe("workspace list refresh stability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlashListRenders.length = 0;
    mockFlashListMounts = 0;
    mockSessionsRefetching = false;
    mockCreateVisible = false;
  });

  it("shows refreshing only for an explicit user pull", async () => {
    mockSessionsRefetching = true;
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    expect(latestList().refreshing).toBe(false);

    let finishSessionRefresh: (() => void) | undefined;
    mockRefetchSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSessionRefresh = () => resolve({});
      }),
    );
    await act(() => latestList().onRefresh());
    expect(latestList().refreshing).toBe(true);

    await act(async () => {
      finishSessionRefresh?.();
      await Promise.resolve();
    });
    expect(latestList().refreshing).toBe(false);
    await screen.unmount();
  });

  it("stretches the list content so a pull below the last row still refreshes", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });

    // Two workspaces leave most of the screen empty. Unless the content grows to
    // the full height, the scroll surface ends under the last row and a pull
    // started in the space beneath it reaches nothing.
    expect(StyleSheet.flatten(latestList().contentContainerStyle)?.flexGrow).toBe(1);
    await screen.unmount();
  });

  it("leaves the top safe-area inset to the route Screen", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const rootStyle = StyleSheet.flatten(
      screen.getByTestId("workspace-list-screen").props["style"],
    );

    expect(rootStyle.paddingTop).toBeUndefined();
    await screen.unmount();
  });

  it("renders one global header carrying only the create action", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    // A destination root wears the spawnd mark rather than its own name: the tab
    // bar underneath already says which root this is.
    expect(screen.queryByText("Workspaces")).toBeNull();
    expect(screen.getByLabelText("Workspaces")).toBeTruthy();
    expect(screen.getByTestId("new-workspace-button")).toBeTruthy();

    // Hosts and Settings moved to the bottom nav; offering them here too was the
    // duplication round 6 removed. Creating a workspace is not navigation, so it stays.
    expect(screen.queryByLabelText("Open hosts")).toBeNull();
    expect(screen.queryByLabelText("Open settings")).toBeNull();

    await fireEvent.press(screen.getByTestId("new-workspace-button"));
    expect(mockCreateVisible).toBe(true);

    await screen.unmount();
  });

  it("offers a create row under the last workspace", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const createRow = within(screen.getByTestId("new-workspace-row")).getByLabelText(
      "New workspace",
    );

    // The row sits inside the list's footer, so it trails the workspaces rather
    // than floating over them.
    expect(within(screen.getByTestId("workspace-list")).getByTestId("new-workspace-row")).toBe(
      screen.getByTestId("new-workspace-row"),
    );

    await fireEvent.press(createRow);
    expect(mockCreateVisible).toBe(true);

    await screen.unmount();
  });

  it("pins archived navigation to the foot of the screen with its count and chevron", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const root = screen.getByTestId("workspace-list-screen");
    const archivedSection = screen.getByTestId("archived-workspaces-section");
    const searchSection = screen.getByTestId("workspace-search-section");
    const sectionStyle = StyleSheet.flatten(searchSection.props["style"]);
    const archivedRow = screen.getByLabelText("1 Archived workspace");

    // Archived sits below the list now, pinned above the nav bar: a rarely-taken
    // side road should not stand between the search and the workspaces.
    expect(root.children.indexOf(archivedSection)).toBeGreaterThan(
      root.children.indexOf(searchSection),
    );
    expect(archivedRow).toHaveStyle({ borderRadius: borderWidth.none });
    // The count carries the label rather than a second line restating "workspace".
    expect(within(archivedSection).getByText("1 Archived workspace")).toBeTruthy();
    expect(within(archivedSection).queryByText("1 workspace")).toBeNull();
    expect(within(searchSection).getByTestId("workspace-search")).toBeTruthy();
    expect(searchSection.parent).toBe(screen.getByTestId("workspace-list-screen"));
    expect(screen.queryByTestId("keyboard-sticky-view")).toBeNull();
    expect(screen.getByTestId("workspace-list-header")).toHaveStyle({
      borderBottomWidth: borderWidth.hairline,
    });
    expect(sectionStyle?.borderTopWidth).toBeUndefined();
    expect(sectionStyle?.borderBottomWidth).toBeUndefined();
    expect(within(searchSection).getByTestId("list-separator")).toHaveStyle({
      height: borderWidth.hairline,
    });
    expect(screen.getByTestId("workspace-list")).toBeTruthy();

    await fireEvent.press(archivedRow);
    expect(mockPush).toHaveBeenCalledWith("/workspaces/archived");
    await screen.unmount();
  });

  it("joins workspace rows with a global separator that runs edge to edge", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    expect(latestList().ItemSeparatorComponent).toBeDefined();
    // The row separators and the one above the create row all run edge to edge.
    for (const separator of within(screen.getByTestId("workspace-list")).getAllByTestId(
      "list-separator",
    )) {
      const style = StyleSheet.flatten(separator.props["style"]);
      expect(style["marginLeft"]).toBeUndefined();
      expect(style["marginRight"]).toBeUndefined();
    }
    await screen.unmount();
  });

  it("keeps the list mounted with stable data and keys during a background refetch", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const before = latestList();
    const beforeKeys = before.data.map(before.keyExtractor);

    mockSessionsRefetching = true;
    await screen.rerender(<WorkspaceListScreen />);
    const during = latestList();

    expect(mockFlashListMounts).toBe(1);
    expect(during.data).toBe(before.data);
    expect(during.data.map(during.keyExtractor)).toEqual(beforeKeys);
    expect(during.refreshing).toBe(false);
    await screen.unmount();
  });
});
