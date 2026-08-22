import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceListScreen } from "@/components/workspaces/workspace-list-screen";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { ThemeProvider } from "@/theme";

interface CapturedFlashListProps {
  data: ReadonlyArray<{ workspace: { id: string } }>;
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
const mockSetOptions = jest.fn();
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
const mockWorkspaces = [mockWorkspace];
const mockArchived: WorkspaceOut[] = [];
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
      return React.createElement(View, { testID: props.testID });
    },
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual<typeof import("@react-navigation/native")>(
    "@react-navigation/native",
  );
  return { ...actual, useNavigation: () => ({ setOptions: mockSetOptions }) };
});

jest.mock("@/components/ui/toast", () => ({ useToast: () => mockToast }));
jest.mock("@/components/workspaces/change-workspace-icon-dialog", () => ({
  ChangeWorkspaceIconDialog: () => null,
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

  it("leaves the top safe-area inset to the route Screen", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const rootStyle = StyleSheet.flatten(
      screen.getByTestId("workspace-list-screen").props["style"],
    );

    expect(rootStyle.paddingTop).toBeUndefined();
    await screen.unmount();
  });

  it("configures create and destination actions in the native header", async () => {
    const screen = await render(<WorkspaceListScreen />, { wrapper: Providers });
    const options = mockSetOptions.mock.calls.at(-1)?.[0] as
      | { headerRight?: () => React.JSX.Element }
      | undefined;
    const headerRight = options?.headerRight;
    if (!headerRight) throw new Error("Workspace header actions were not configured.");

    const header = await render(headerRight(), { wrapper: Providers });
    expect(header.getByLabelText("New workspace")).toBeTruthy();
    expect(header.getByLabelText("Open hosts")).toBeTruthy();
    expect(header.getByLabelText("Open settings")).toBeTruthy();
    await fireEvent.press(header.getByTestId("new-workspace-button"));
    expect(mockCreateVisible).toBe(true);
    expect(screen.queryByText("Workspaces")).toBeNull();

    await header.unmount();
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
