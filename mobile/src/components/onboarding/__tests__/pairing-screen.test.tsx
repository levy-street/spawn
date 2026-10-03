import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);
const mockReplace = jest.fn();
const mockQueryClear = jest.fn();
const mockRefetch = jest.fn(async () => undefined);
const mockHostPairingStep = jest.fn((_props: unknown) => null);
let mockSearchParams: Record<string, string> = {};
let mockMeQuery: {
  data: { user: { id: string } } | undefined;
  isError: boolean;
  isPending: boolean;
  refetch: typeof mockRefetch;
} = {
  data: undefined,
  isError: false,
  isPending: true,
  refetch: mockRefetch,
};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({
    back: mockBack,
    canGoBack: mockCanGoBack,
    replace: mockReplace,
  }),
}));

jest.mock("react-native-keyboard-controller", () => {
  const { ScrollView, View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    KeyboardAwareScrollView: ScrollView,
    KeyboardStickyView: View,
  };
});

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => mockMeQuery,
  useQueryClient: () => ({ clear: mockQueryClear }),
}));

jest.mock("@/components/onboarding/host-pairing-step", () => ({
  HostPairingStep: (props: unknown) => mockHostPairingStep(props),
}));

jest.mock("@/data/api/endpoints/account", () => ({
  getMe: jest.fn(),
}));

import DevicePairingScreen from "@/app/onboarding/device";
import PossessHostScreen from "@/app/onboarding/host";
import { PairingScreen } from "@/components/onboarding/pairing-screen";
import { FixedThemeProvider, lightTheme } from "@/theme";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <FixedThemeProvider mode="light">{children}</FixedThemeProvider>
    </SafeAreaProvider>
  );
}

describe("PairingScreen", () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockCanGoBack.mockReset();
    mockCanGoBack.mockReturnValue(true);
    mockReplace.mockClear();
    mockQueryClear.mockClear();
    mockHostPairingStep.mockClear();
    mockSearchParams = {};
    mockMeQuery = {
      data: undefined,
      isError: false,
      isPending: true,
      refetch: mockRefetch,
    };
  });

  it("renders one shared header over an edge-to-edge themed ground", async () => {
    const screen = await render(<PairingScreen />, { wrapper });

    expect(screen.getAllByRole("header")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Connect a computer" })).toBeOnTheScreen();
    expect(screen.getByTestId("pairing-screen")).toHaveStyle({
      backgroundColor: lightTheme.colors.background,
    });
  });

  it("opens from every Possess a host control under the same name, in the browser's words", async () => {
    const screen = await render(<PossessHostScreen />, { wrapper });

    expect(screen.getAllByRole("header")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Possess a host" })).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Install SPAWN D on the computer, run spawnd possess there, and keep this window open until it comes online.",
      ),
    ).toBeOnTheScreen();
  });

  it("lands a host's own approval link on the pairing steps without that lead", async () => {
    const screen = await render(<DevicePairingScreen />, { wrapper });

    expect(screen.getByRole("header", { name: "Connect a computer" })).toBeOnTheScreen();
    expect(screen.queryByTestId("pairing-lead")).toBeNull();
  });

  it("pops a pushed pairing screen from the header", async () => {
    const screen = await render(<PairingScreen />, { wrapper });

    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("returns a directly opened pairing screen to Hosts", async () => {
    mockCanGoBack.mockReturnValue(false);
    const screen = await render(<PairingScreen />, { wrapper });

    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/hosts");
  });

  it("hands the link ceremony fields to the host step", async () => {
    mockSearchParams = {
      approvalRef: "approval-ref-123",
      hostKey: "host-key-123",
      fragmentMalformed: "true",
    };
    mockMeQuery = {
      data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
      isError: false,
      isPending: false,
      refetch: mockRefetch,
    };

    await render(<PairingScreen />, { wrapper });

    expect(mockHostPairingStep).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "11111111-1111-4111-8111-111111111111",
        initialApprovalRef: "approval-ref-123",
        initialHostKey: "host-key-123",
        initialLinkMalformed: true,
      }),
    );
  });
});
