import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";

import { ProfileMenu } from "@/components/nav/profile-menu";
import { logOut } from "@/data/api/endpoints/auth";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockResetConnection = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock("@/components/ui/sheet", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    Sheet: ({ children, visible }: { children: import("react").ReactNode; visible: boolean }) =>
      visible ? React.createElement(View, { testID: "profile-sheet" }, children) : null,
    SheetHeader: ({ title }: { title: string }) => React.createElement(Text, null, title),
  };
});

jest.mock("@/data/api/endpoints/auth", () => ({
  logOut: jest.fn(async () => undefined),
}));

jest.mock("@/data/queries/auth", () => ({
  useMeQuery: () => ({ data: { user: { email: "charlie@example.com" } } }),
}));

jest.mock("@/data/stores/connection", () => ({
  useConnectionStore: { getState: () => ({ reset: mockResetConnection }) },
}));

jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({ accountId: "account-one", ready: true }),
}));

jest.mock("@/lib/haptics", () => ({
  // The drawer warns on a destructive row — logging out is one.
  haptics: { overlayOpen: jest.fn(), selection: jest.fn(), warning: jest.fn() },
}));

async function renderMenu() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const clear = jest.spyOn(queryClient, "clear");

  function Providers({ children }: PropsWithChildren): React.JSX.Element {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{children}</ThemeProvider>
      </QueryClientProvider>
    );
  }

  const screen = await render(<ProfileMenu />, { wrapper: Providers });
  return { clear, screen };
}

describe("ProfileMenu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(logOut).mockResolvedValue(undefined);
  });

  it("uses the square header action target for the circular avatar", async () => {
    const { screen } = await renderMenu();
    const style = StyleSheet.flatten(screen.getByTestId("profile-menu-trigger").props["style"]);

    expect(style.height).toBe(sizing.appHeader.actionTarget);
    expect(style.width).toBe(style.height);
    expect(style.minHeight).toBe(style.height);
    expect(style.minWidth).toBe(style.width);
  });

  it("opens a profile sheet and pushes Profile", async () => {
    const { screen } = await renderMenu();

    expect(screen.queryByTestId("profile-sheet")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Open profile menu"));

    expect(haptics.overlayOpen).toHaveBeenCalledTimes(1);
    // The email header was removed: the drawer is two actions, and whose account
    // it is is already answered by the avatar you tapped to open it.
    expect(screen.queryByText("charlie@example.com")).toBeNull();
    expect(screen.getByRole("button", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Profile" }));

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/profile");
    expect(screen.queryByTestId("profile-sheet")).toBeNull();
  });

  it("carries the theme choice, and stays up while it changes", async () => {
    const { screen } = await renderMenu();

    await fireEvent.press(screen.getByLabelText("Open profile menu"));
    expect(screen.getByTestId("profile-theme-mode")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "System" }).props["accessibilityState"].checked).toBe(
      true,
    );

    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));

    // A value, not an action: the sheet holds so the change can be seen and
    // undone, the way Appearance in Settings behaves.
    expect(screen.getByRole("radio", { name: "Dark" }).props["accessibilityState"].checked).toBe(
      true,
    );
    expect(screen.getByTestId("profile-sheet")).toBeTruthy();
  });

  it("mirrors the account sign-out cleanup even when the request fails", async () => {
    jest.mocked(logOut).mockRejectedValueOnce(new Error("offline"));
    const { clear, screen } = await renderMenu();

    await fireEvent.press(screen.getByLabelText("Open profile menu"));
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login"));
    expect(mockResetConnection).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
