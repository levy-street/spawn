import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";

interface MockStackProps {
  children: ReactNode;
  screenOptions?: unknown;
}
interface MockStackScreenProps {
  name: string;
  options?: { title?: string };
}

jest.mock("expo-router", () => {
  const { createElement } = require("react");
  const { View } = require("react-native");
  const Stack = ({ children }: MockStackProps) =>
    createElement(View, { testID: "root-stack" }, children);
  Stack.Screen = ({ name, options }: MockStackScreenProps) =>
    createElement(View, {
      accessibilityLabel: options?.title,
      testID: `app-screen-${name}`,
    });
  const Tabs = ({ children }: MockStackProps) =>
    createElement(View, { testID: "root-tabs" }, children);
  Tabs.Screen = ({ name, options }: MockStackScreenProps) =>
    createElement(View, {
      accessibilityLabel: options?.title,
      testID: `app-screen-${name}`,
    });
  return {
    Stack,
    Tabs,
    useNavigationContainerRef: () => ({
      dispatch: jest.fn(),
      getRootState: () => undefined,
      isReady: () => false,
    }),
    usePathname: () => "/workspaces",
    useRouter: () => ({ navigate: jest.fn(), replace: jest.fn(), push: jest.fn() }),
  };
});

jest.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModal: () => ({ dismissAll: jest.fn() }),
}));

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: { user: { id: "u1", is_admin: false } }, isLoading: false }),
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "u1", ready: true }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import AppStackLayout, { APP_ROUTE_MAP, FULL_SCREEN_BACK_OPTIONS } from "@/app/(drawer)/_layout";
import { ThemeProvider } from "@/theme";

/** The shell renders a device-approval watcher that queries; give it a client. */
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("app navigation shell", () => {
  // Round 8 made the shell a plain stack again: the three roots live in a tab
  // group it pushes over, so every detail screen is an ordinary card with a real
  // back entry rather than a tab masquerading as one.
  it("pushes detail screens over the tab group, with no drawer", async () => {
    const screen = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <QueryClientProvider client={testQueryClient()}>
          <ThemeProvider>
            <AppStackLayout />
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );

    expect(screen.queryByTestId("root-drawer")).toBeNull();
    expect(screen.getByTestId("root-stack")).toBeTruthy();
    expect(screen.getByTestId("app-screen-(tabs)")).toBeTruthy();
    for (const pushed of ["workspace/[id]", "host/[id]/index", "legion"]) {
      expect(screen.getByTestId(`app-screen-${pushed}`)).toBeTruthy();
    }
  });

  it("exposes no root Files destination", () => {
    const paths = Object.keys(APP_ROUTE_MAP);
    expect(paths).not.toContain("/files");
    expect(paths.some((p) => p.startsWith("/files"))).toBe(false);
    // Files stay contextual under a host.
    expect(paths).toContain("/host/[id]/files");
  });

  it("keeps every public destination reachable", () => {
    const paths = Object.keys(APP_ROUTE_MAP);
    for (const required of ["/workspaces", "/hosts", "/legion", "/settings", "/admin"]) {
      expect(paths).toContain(required);
    }
  });

  // Edge-only back gestures were the owner's complaint; this must stay full-screen.
  it("enables full-screen back gestures", () => {
    expect(FULL_SCREEN_BACK_OPTIONS).toMatchObject({
      gestureEnabled: true,
      gestureDirection: "horizontal",
      fullScreenGestureEnabled: true,
    });
  });
});
