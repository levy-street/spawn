import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { fireEvent, render } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockPush = jest.fn();
const mockRefetch = jest.fn(async () => undefined);
const mockMutation = {
  error: null,
  isPending: false,
  mutate: jest.fn(),
  reset: jest.fn(),
};

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/data/queries/hosts", () => ({
  useHostsQuery: () => ({
    data: [],
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: mockRefetch,
  }),
  useRemoveHostMutation: () => mockMutation,
  useRenameHostMutation: () => mockMutation,
  // The Legion tab counts sessions and agents for its rollup.
  useAllSessionsQuery: () => ({ data: [], isError: false, isPending: false }),
  useAgentsQuery: () => ({ data: [], isError: false, isPending: false }),
}));

jest.mock("@/data/queries/settings", () => ({
  useHostsSettingsQuery: () => ({
    data: [],
    isError: false,
    isPending: false,
  }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn() }),
}));

jest.mock("@/components/hosts/host-actions-sheet", () => ({
  HostActionsSheet: () => null,
}));

jest.mock("@/components/hosts/rename-host-dialog", () => ({
  RenameHostDialog: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HostPairingScreen from "@/app/onboarding/host";
import { HostListScreen } from "@/components/hosts/host-list-screen";
import { HostsPanel } from "@/components/settings/hosts-panel";
import { ThemeProvider } from "@/theme";

/** The shell renders a device-approval watcher that queries; give it a client. */
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: React.PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={testQueryClient()}>
          <ThemeProvider>
            <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

describe("standalone host pairing route", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("is backed by an existing standalone pairing screen", () => {
    expect(HostPairingScreen).toEqual(expect.any(Function));
  });

  it("is reachable from both connect controls on Hosts", async () => {
    const screen = await render(<HostListScreen />, { wrapper: Providers });
    const connectButtons = screen.getAllByRole("button", { name: "Connect a host" });
    expect(connectButtons).toHaveLength(2);

    for (const button of connectButtons) await fireEvent.press(button);

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenNthCalledWith(1, "/onboarding/host");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/onboarding/host");
  });

  it("is reachable from Settings Hosts", async () => {
    const screen = await render(<HostsPanel />, { wrapper: Providers });
    await fireEvent.press(screen.getByRole("button", { name: "Connect a host" }));
    expect(mockPush).toHaveBeenCalledWith("/onboarding/host");
  });
});
