import { render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { createElement } from "react";

const mockProviderOrder: string[] = [];

function mockOrderedProvider(name: string) {
  return function OrderedProvider({ children }: PropsWithChildren) {
    mockProviderOrder.push(name);
    return createElement("View", null, children);
  };
}

jest.mock("expo-font", () => ({
  useFonts: () => [true, null],
}));

jest.mock("expo-splash-screen", () => ({
  hideAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-system-ui", () => ({
  setBackgroundColorAsync: jest.fn(async () => undefined),
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: mockOrderedProvider("SafeAreaProvider"),
}));

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: mockOrderedProvider("GestureHandlerRootView"),
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: mockOrderedProvider("KeyboardProvider"),
}));

jest.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetModalProvider: mockOrderedProvider("BottomSheetModalProvider"),
}));

jest.mock("@/theme", () => ({
  ThemeProvider: mockOrderedProvider("ThemeProvider"),
  useTheme: () => ({ colors: { background: "#FAFAFA" } }),
}));

jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    QueryClientProvider: mockOrderedProvider("QueryClientProvider"),
  };
});

jest.mock("@/data/realtime/provider", () => ({
  RealtimeProvider: mockOrderedProvider("RealtimeProvider"),
}));

jest.mock("@/components/ui/toast", () => ({
  ToastProvider: mockOrderedProvider("ToastProvider"),
}));

jest.mock("@/components/ui/confirm", () => ({
  ConfirmHost: mockOrderedProvider("ConfirmHost"),
}));

jest.mock("@/components/media/camera-host", () => ({
  CameraHost: mockOrderedProvider("CameraHost"),
}));

import {
  APP_PROVIDER_ORDER,
  APP_QUERY_DEFAULTS,
  AppProviders,
  createAppQueryClient,
} from "@/lib/providers";

describe("app providers", () => {
  beforeEach(() => {
    mockProviderOrder.length = 0;
  });

  it("mounts the documented dependency order through the router child", async () => {
    function RouterProbe() {
      mockProviderOrder.push("Router");
      return null;
    }

    await render(
      <AppProviders>
        <RouterProbe />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(mockProviderOrder).toEqual(APP_PROVIDER_ORDER);
      expect(require("expo-splash-screen").hideAsync).toHaveBeenCalledTimes(1);
    });
  });

  it("matches the documented QueryClient defaults", () => {
    const defaults = createAppQueryClient().getDefaultOptions().queries;
    expect(defaults).toMatchObject(APP_QUERY_DEFAULTS);
  });
});
