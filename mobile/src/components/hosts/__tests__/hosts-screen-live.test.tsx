import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
  type ViewabilityConfigCallbackPairs,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

let mockFocused = true;
const mockUseHostsQuery = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => mockFocused,
}));

jest.mock("@/data/queries/hosts", () => ({
  useAgentsQuery: () => ({ data: [], isError: false, isPending: false }),
  useAllSessionsQuery: () => ({ data: [], isError: false, isPending: false }),
  useHostsQuery: () => mockUseHostsQuery(),
  useRemoveHostMutation: () => ({ error: null, isPending: false, mutate: jest.fn() }),
  useRenameHostMutation: () => ({
    error: null,
    isPending: false,
    mutate: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock("@/data/queries/device-trust", () => ({
  useDeviceHostApprovals: () => ({ approvals: [], approved: [], awaiting: [], resolved: true }),
}));

jest.mock("@/components/hosts/host-actions-sheet", () => ({
  HostActionsSheet: () => null,
}));

jest.mock("@/components/hosts/rename-host-dialog", () => ({
  RenameHostDialog: () => null,
}));

jest.mock("@/components/hosts/live-capacity-probe", () => ({
  LiveCapacityProbe: jest.fn(() => null),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn() }),
}));

import { onlineHost, windowsHost } from "@/components/hosts/__tests__/fixtures";
import { HostsScreen } from "@/components/hosts/hosts-screen";
import type { HostOut } from "@/data/api/schemas/hosts";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../tests/render";

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

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

const probe = jest.requireMock("@/components/hosts/live-capacity-probe") as {
  LiveCapacityProbe: jest.Mock;
};

/** The hosts whose card's probe was last told to ask, which is what it is doing now. */
function askingHosts(): string[] {
  const latest = new Map<string, boolean>();
  for (const [props] of probe.LiveCapacityProbe.mock.calls as [
    { enabled: boolean; hostId: string },
  ][]) {
    latest.set(props.hostId, props.enabled);
  }
  return [...latest]
    .filter(([, enabled]) => enabled)
    .map(([hostId]) => hostId)
    .sort();
}

/** Tell the list which cards are on screen, as FlatList does on a device. */
async function reportOnScreen(hosts: readonly HostOut[]): Promise<void> {
  const pairs = screen.getByTestId("hosts-list").props[
    "viewabilityConfigCallbackPairs"
  ] as ViewabilityConfigCallbackPairs;
  await act(async () => {
    for (const pair of pairs) {
      pair.onViewableItemsChanged?.({
        changed: [],
        viewableItems: hosts.map((host, index) => ({
          index,
          isViewable: true,
          item: host,
          key: host.id,
        })),
      });
    }
  });
}

const appStateListeners = new Set<(state: AppStateStatus) => void>();
let initialAppState: AppStateStatus;

async function appGoes(state: AppStateStatus): Promise<void> {
  await act(async () => {
    AppState.currentState = state;
    for (const listener of [...appStateListeners]) listener(state);
  });
}

describe("exact host figures on the Hosts tab", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    initialAppState = AppState.currentState;
    AppState.currentState = "active";
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    });
    mockFocused = true;
    mockUseHostsQuery.mockReturnValue({
      data: [onlineHost, windowsHost],
      isError: false,
      isPending: false,
      isRefetching: false,
      refetch: jest.fn(async () => undefined),
    });
    probe.LiveCapacityProbe.mockClear();
  });

  afterEach(() => {
    AppState.currentState = initialAppState;
    appStateListeners.clear();
    jest.restoreAllMocks();
  });

  test("are asked for only while the app is in the foreground", async () => {
    await render(<HostsScreen />, { wrapper: Providers });
    await reportOnScreen([onlineHost]);
    expect(askingHosts()).toEqual([onlineHost.id]);

    // A phone in a pocket asks nothing and holds no channel open.
    await appGoes("background");
    expect(askingHosts()).toEqual([]);

    await appGoes("active");
    expect(askingHosts()).toEqual([onlineHost.id]);

    // iOS passing through (Control Centre, the app switcher) is still on screen.
    await appGoes("inactive");
    expect(askingHosts()).toEqual([onlineHost.id]);
  });

  test("are asked for only while the Hosts tab is the one in front", async () => {
    const view = await render(<HostsScreen />, { wrapper: Providers });
    await reportOnScreen([onlineHost]);
    expect(askingHosts()).toEqual([onlineHost.id]);

    // A host's page pushed over the tab, or another tab chosen.
    mockFocused = false;
    await view.rerender(<HostsScreen />);
    expect(askingHosts()).toEqual([]);

    mockFocused = true;
    await view.rerender(<HostsScreen />);
    expect(askingHosts()).toEqual([onlineHost.id]);
  });

  test("a backgrounded app that opens on another tab asks nothing", async () => {
    AppState.currentState = "background";
    mockFocused = false;
    await render(<HostsScreen />, { wrapper: Providers });
    await reportOnScreen([onlineHost, windowsHost]);
    expect(askingHosts()).toEqual([]);
  });
});
