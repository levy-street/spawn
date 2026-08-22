import { render } from "@testing-library/react-native";

import AppStackLayout from "@/app/(drawer)/_layout";
import { ThemeProvider } from "@/theme";

let mockPathname = "/workspaces";
const mockBack = jest.fn();
const mockReplace = jest.fn();

jest.mock("expo-router", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  const { AppHeader } =
    require("@/components/layout/app-header") as typeof import("@/components/layout/app-header");
  return {
    Stack: () =>
      React.createElement(
        View,
        { testID: "mock-stack" },
        React.createElement(AppHeader, { onBack: mockBack, title: "Current route" }),
      ),
    usePathname: () => mockPathname,
    useRouter: () => ({ replace: mockReplace }),
  };
});

jest.mock("@/components/admin/admin-access", () => {
  const React = require("react") as typeof import("react");
  return {
    AdminAccessBoundary: ({ children }: { children: import("react").ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    resolveAdminAccess: () => "allowed",
  };
});

jest.mock("@/components/nav/profile-menu", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    ProfileMenu: () => React.createElement(View, { testID: "mock-profile-menu" }),
  };
});

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: undefined, error: null, isLoading: false, refetch: jest.fn() }),
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "account-one", ready: true }),
}));

describe("drawer navigation shell", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("mounts bottom navigation and the profile leading control on a root route", async () => {
    mockPathname = "/workspaces";
    const screen = await render(
      <ThemeProvider>
        <AppStackLayout />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("mock-stack")).toBeTruthy();
    expect(screen.getByTestId("bottom-nav")).toBeTruthy();
    expect(screen.getByTestId("mock-profile-menu")).toBeTruthy();
    expect(screen.queryByLabelText("Go back")).toBeNull();
  });

  it("hides root chrome and restores the back control on a pushed route", async () => {
    mockPathname = "/settings/profile";
    const screen = await render(
      <ThemeProvider>
        <AppStackLayout />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("bottom-nav")).toBeNull();
    expect(screen.queryByTestId("mock-profile-menu")).toBeNull();
    expect(screen.getByLabelText("Go back")).toBeTruthy();
  });
});
