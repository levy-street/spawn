import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockUseAgentsQuery = jest.fn();
const mockUseAllSessionsQuery = jest.fn();
const mockUseHostAgentsQuery = jest.fn();
const mockUseHostQuery = jest.fn();
const mockUseHostSessionsQuery = jest.fn();
const mockUseHostsQuery = jest.fn();
const mockUseSkillsQuery = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack, push: mockPush, replace: mockReplace }),
}));

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

jest.mock("@/data/queries/hosts", () => ({
  useAgentsQuery: () => mockUseAgentsQuery(),
  useAllSessionsQuery: () => mockUseAllSessionsQuery(),
  useHostAgentPolicyMutation: () => ({ isPending: false, mutate: jest.fn() }),
  useHostAgentsQuery: () => mockUseHostAgentsQuery(),
  useHostQuery: () => mockUseHostQuery(),
  useHostSessionsQuery: () => mockUseHostSessionsQuery(),
  useHostsQuery: () => mockUseHostsQuery(),
  useInstallHostAgentMutation: () => ({ isPending: false, mutate: jest.fn() }),
  useRemoveHostMutation: () => ({ error: null, isPending: false, mutate: jest.fn() }),
  useRenameHostMutation: () => ({
    error: null,
    isPending: false,
    mutate: jest.fn(),
    reset: jest.fn(),
  }),
  useSkillsQuery: () => mockUseSkillsQuery(),
}));

jest.mock("@/components/hosts/host-actions-sheet", () => ({
  HostActionsSheet: () => null,
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
import { HostAgentsScreen } from "@/components/hosts/host-agents-screen";
import { HostDetailScreen } from "@/components/hosts/host-detail-screen";
import { HostListScreen } from "@/components/hosts/host-list-screen";
import { LegionScreen } from "@/components/hosts/legion-screen";
import { ThemeProvider } from "@/theme";

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

function Providers({ children }: React.PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
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
    mockUseHostQuery.mockReturnValue(successfulQuery(onlineHost));
    mockUseHostSessionsQuery.mockReturnValue(successfulQuery([]));
    mockUseHostAgentsQuery.mockReturnValue(successfulQuery({ agents: [] }));
    mockUseSkillsQuery.mockReturnValue(successfulQuery([]));
  });

  afterEach(() => jest.restoreAllMocks());

  test("Hosts renders one title and wires all global header actions", async () => {
    await render(<HostListScreen />, { wrapper: Providers });

    expect(screen.getAllByText("Hosts")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Hosts" })).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("hosts-legion-action"));
    await fireEvent.press(screen.getByTestId("hosts-settings-action"));
    await fireEvent.press(screen.getByTestId("hosts-connect-action"));
    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));

    expect(mockPush).toHaveBeenNthCalledWith(1, "/legion");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/settings");
    expect(mockPush).toHaveBeenNthCalledWith(3, "/onboarding/host");
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test("Legion moves its rollup and live switch into its only title bar", async () => {
    mockUseHostsQuery.mockReturnValue(successfulQuery([onlineHost]));
    await render(<LegionScreen />, { wrapper: Providers });

    expect(screen.getAllByText("The legion")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "The legion" })).toBeOnTheScreen();
    expect(screen.getByText("1 online · 1 total")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("switch", { name: "Live capacity" }));

    expect(screen.getByText(/Live figures come straight from each daemon/)).toBeOnTheScreen();
  });

  test("host detail renders its host name only in the shared title bar", async () => {
    await render(<HostDetailScreen hostId={onlineHost.id} />, { wrapper: Providers });

    expect(screen.getAllByText(onlineHost.name)).toHaveLength(1);
    expect(screen.getByRole("header", { name: onlineHost.name })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Host actions" })).toBeOnTheScreen();
  });

  test("host agents puts host context and refresh in the shared title bar", async () => {
    await render(<HostAgentsScreen hostId={onlineHost.id} />, { wrapper: Providers });

    expect(screen.getAllByText("Agents & skills")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Agents & skills" })).toBeOnTheScreen();
    expect(screen.getByText(onlineHost.name)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Refresh agents and skills" })).toBeOnTheScreen();
  });
});
