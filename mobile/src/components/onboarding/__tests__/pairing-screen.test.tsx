import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);
const mockReplace = jest.fn();
const mockRefetch = jest.fn(async () => undefined);

jest.mock("expo-router", () => ({
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
  useQuery: () => ({
    data: undefined,
    isError: false,
    isPending: true,
    refetch: mockRefetch,
  }),
}));

jest.mock("@/components/onboarding/host-pairing-step", () => ({
  HostPairingStep: () => null,
}));

jest.mock("@/data/api/endpoints/account", () => ({
  getMe: jest.fn(),
}));

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
  });

  it("renders one shared header over an edge-to-edge themed ground", async () => {
    const screen = await render(<PairingScreen />, { wrapper });

    expect(screen.getAllByRole("header")).toHaveLength(1);
    expect(screen.getByRole("header", { name: "Connect a host" })).toBeOnTheScreen();
    expect(screen.getByTestId("pairing-screen")).toHaveStyle({
      backgroundColor: lightTheme.colors.background,
    });
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
});
