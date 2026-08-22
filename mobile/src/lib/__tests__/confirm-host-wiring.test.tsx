import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AccessibilityInfo, View } from "react-native";

jest.mock("expo-font", () => ({
  useFonts: () => [true, null],
}));

jest.mock("expo-splash-screen", () => ({
  hideAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-system-ui", () => ({
  setBackgroundColorAsync: jest.fn(async () => undefined),
}));

jest.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetModalProvider: ({ children }: PropsWithChildren) => children,
}));

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: PropsWithChildren) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: PropsWithChildren) => children,
}));

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: PropsWithChildren) => children,
}));

jest.mock("@/data/realtime/provider", () => ({
  RealtimeProvider: ({ children }: PropsWithChildren) => children,
}));

jest.mock("@/components/ui/toast", () => ({
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));

import { confirm } from "@/components/ui/confirm";
import { AppProviders } from "@/lib/providers";

describe("global confirmation host wiring", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  });

  it("resolves acceptance and dismissal through AppProviders", async () => {
    const screen = await render(
      <AppProviders>
        <View testID="router" />
      </AppProviders>,
    );

    let accepted: Promise<boolean> | undefined;
    await act(() => {
      accepted = confirm({ title: "Archive workspace?", confirmLabel: "Archive" });
    });
    if (!accepted) throw new Error("acceptance promise was not created");
    await waitFor(() => expect(screen.getByText("Archive workspace?")).toBeTruthy());
    await fireEvent.press(screen.getByText("Archive"));
    await expect(accepted).resolves.toBe(true);

    let dismissed: Promise<boolean> | undefined;
    await act(() => {
      dismissed = confirm({ title: "Delete workspace?" });
    });
    if (!dismissed) throw new Error("dismissal promise was not created");
    await waitFor(() => expect(screen.getByText("Delete workspace?")).toBeTruthy());
    await fireEvent.press(screen.getByText("Cancel"));
    await expect(dismissed).resolves.toBe(false);
  });

  it("resolves a superseded request as false", async () => {
    const screen = await render(
      <AppProviders>
        <View testID="router" />
      </AppProviders>,
    );

    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(() => {
      first = confirm({ title: "First request" });
      second = confirm({ title: "Second request", confirmLabel: "Continue" });
    });
    if (!first || !second) throw new Error("confirmation promises were not created");

    await expect(first).resolves.toBe(false);
    await waitFor(() => expect(screen.getByText("Second request")).toBeTruthy());
    await fireEvent.press(screen.getByText("Continue"));
    await expect(second).resolves.toBe(true);
  });
});
