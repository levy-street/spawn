import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockUseAgentsQuery = jest.fn();
const mockUseAllSessionsQuery = jest.fn();
const mockRemoveHost = jest.fn();
const mockUseHostsQuery = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack, push: mockPush, replace: mockReplace }),
}));

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

jest.mock("@/data/queries/hosts", () => ({
  useAgentsQuery: () => mockUseAgentsQuery(),
  useAllSessionsQuery: () => mockUseAllSessionsQuery(),
  useHostsQuery: () => mockUseHostsQuery(),
  useRemoveHostMutation: () => ({ error: null, isPending: false, mutate: mockRemoveHost }),
  useRenameHostMutation: () => ({
    error: null,
    isPending: false,
    mutate: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock("@/components/hosts/host-actions-sheet", () => ({
  HostActionsSheet: () => null,
}));

jest.mock("@/components/hosts/host-update-dialog", () => ({
  HostUpdateDialog: () => null,
}));

jest.mock("@/components/hosts/live-capacity-probe", () => ({
  LiveCapacityProbe: () => null,
}));

jest.mock("@/components/hosts/rename-host-dialog", () => ({
  RenameHostDialog: () => null,
}));

jest.mock("@/components/ui/action-sheet", () => ({
  ActionSheet: () => null,
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn() }),
}));

import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import { HostsScreen } from "@/components/hosts/hosts-screen";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../tests/render";

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function successfulQuery<T>(data: T) {
  return {
    data,
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: jest.fn(async () => undefined),
  };
}

const queryClient = createTestQueryClient();

function Providers({ children }: React.PropsWithChildren): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

describe("host screen headers", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    mockBack.mockClear();
    mockPush.mockClear();
    mockReplace.mockClear();
    mockUseHostsQuery.mockReturnValue(successfulQuery([]));
    mockUseAllSessionsQuery.mockReturnValue(successfulQuery([]));
    mockUseAgentsQuery.mockReturnValue(successfulQuery([]));
    mockRemoveHost.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  test("Hosts is a root: the mark, its own action, no back control", async () => {
    await render(<HostsScreen />, { wrapper: Providers });

    // A destination root wears the spawnd mark; the tab bar underneath names it.
    expect(screen.queryByText("Hosts")).toBeNull();
    expect(screen.getByLabelText("Hosts")).toBeOnTheScreen();

    // The bottom nav owns Settings now, so the header must not offer it a second
    // time. The fleet's totals are in the header itself, so no action opens them.
    expect(screen.queryByTestId("hosts-settings-action")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();

    // Hosts is a destination root like Workspaces: there is nothing behind it to
    // go back to, so it carries the profile control rather than a chevron.
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();

    const possess = screen.getByTestId("hosts-connect-action");
    expect(possess).toHaveProp("accessibilityLabel", "Possess a host");
    await fireEvent.press(possess);

    expect(mockPush).toHaveBeenNthCalledWith(1, "/onboarding/host");
    expect(mockBack).not.toHaveBeenCalled();
  });

  test("Hosts counts its hosts in the title bar while they load", async () => {
    mockUseHostsQuery.mockReturnValue({ ...successfulQuery(undefined), isPending: true });
    await render(<HostsScreen />, { wrapper: Providers });

    expect(screen.getByText("Counting your hosts…")).toBeOnTheScreen();
  });

  test("Hosts carries the fleet's totals under its mark", async () => {
    mockUseHostsQuery.mockReturnValue(successfulQuery([onlineHost]));
    await render(<HostsScreen />, { wrapper: Providers });

    expect(screen.getByText("1 of 1 online · 12 cores")).toBeOnTheScreen();
    expect(screen.getByTestId(`host-row-${onlineHost.id}`)).toBeOnTheScreen();
  });
});
