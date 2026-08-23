import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider, useToast } from "@/components/ui/toast";
import { haptics } from "@/lib/haptics";
import { spacing, ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

jest.mock("@/lib/haptics", () => ({
  haptics: {
    selection: jest.fn(),
    impact: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    overlayOpen: jest.fn(),
    overlayDismiss: jest.fn(),
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function ToastHarness(): React.JSX.Element {
  const toast = useToast();
  return (
    <View>
      <Pressable accessibilityLabel="Show success" onPress={() => toast.success("Saved")} />
      <Pressable accessibilityLabel="Show error" onPress={() => toast.error("Failed")} />
    </View>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => jest.clearAllMocks());

  test("stacks notices and emits semantic haptics", async () => {
    const screen = await render(<ToastHarness />, { wrapper: Providers });
    await fireEvent.press(screen.getByLabelText("Show success"));
    await fireEvent.press(screen.getByLabelText("Show error"));
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(haptics.success).toHaveBeenCalledTimes(1);
    expect(haptics.error).toHaveBeenCalledTimes(1);
  });

  test("hangs its notices from the top edge, one gutter in from each side", async () => {
    const screen = await render(<ToastHarness />, { wrapper: Providers });
    await fireEvent.press(screen.getByLabelText("Show success"));

    const host = StyleSheet.flatten(screen.getByTestId("toast-host").props["style"]);
    expect(host["top"]).toBe(0);
    expect(host["left"]).toBe(sizing.screen.gutter);
    expect(host["right"]).toBe(sizing.screen.gutter);
    // Clears the status bar and nothing else: the notice belongs to the top.
    expect(host["paddingTop"]).toBe(METRICS.insets.top + spacing[2]);
  });
});
