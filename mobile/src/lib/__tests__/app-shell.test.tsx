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
  return {
    Stack,
    usePathname: () => "/workspaces",
    useRouter: () => ({ navigate: jest.fn(), replace: jest.fn(), push: jest.fn() }),
  };
});

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: { user: { id: "u1", is_admin: false } }, isLoading: false }),
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "u1", ready: true }),
}));

import AppStackLayout, { APP_ROUTE_MAP, FULL_SCREEN_BACK_OPTIONS } from "@/app/(drawer)/_layout";
import { ThemeProvider } from "@/theme";

describe("app navigation shell", () => {
  // The owner asked for no menu at all: no burger drawer, no bottom tab bar.
  it("renders a menu-less stack", async () => {
    const screen = await render(
      <ThemeProvider>
        <AppStackLayout />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("root-drawer")).toBeNull();
    expect(screen.queryByTestId("root-tabs")).toBeNull();
    expect(screen.getByTestId("root-stack")).toBeTruthy();
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
