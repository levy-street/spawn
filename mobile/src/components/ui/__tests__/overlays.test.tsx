import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AccessibilityInfo, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ActionSheet } from "@/components/ui/action-sheet";
import { Collapse } from "@/components/ui/collapse";
import { Confirm, ConfirmHost, confirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { SwipeDismissOverlay } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { Toast, type ToastRecord } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/theme";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

describe("overlay rendering and dismissal", () => {
  test("Dialog renders its copy and dismisses from the close control", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Dialog onDismiss={onDismiss} title="Connection" visible>
        <Text>Dialog body</Text>
      </Dialog>,
      { wrapper: Providers },
    );
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Dialog body")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Close dialog"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Confirm renders both decisions and invokes them independently", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const screen = await render(
      <Confirm onCancel={onCancel} onConfirm={onConfirm} title="Stop session?" visible />,
      { wrapper: Providers },
    );
    await fireEvent.press(screen.getByText("Confirm"));
    await fireEvent.press(screen.getByText("Cancel"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("imperative confirm resolves and a second request cancels the first", async () => {
    const screen = await render(<ConfirmHost />, { wrapper: Providers });
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(() => {
      first = confirm({ title: "First" });
      second = confirm({ title: "Second", confirmLabel: "Continue" });
    });
    if (!first || !second) throw new Error("confirmation promises were not created");
    await expect(first).resolves.toBe(false);
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
    await fireEvent.press(screen.getByText("Continue"));
    await expect(second).resolves.toBe(true);
  });

  test("SwipeDismissOverlay and Popover render their children", async () => {
    const swipe = await render(
      <SwipeDismissOverlay onDismiss={jest.fn()} visible>
        <Text>Swipe content</Text>
      </SwipeDismissOverlay>,
      { wrapper: Providers },
    );
    expect(swipe.getByText("Swipe content")).toBeTruthy();
    await swipe.unmount();

    const onDismiss = jest.fn();
    const popover = await render(
      <Popover
        anchorRect={{ top: 80, bottom: 124, left: 40, right: 84 }}
        onDismiss={onDismiss}
        visible
      >
        <Text>Popover content</Text>
      </Popover>,
      { wrapper: Providers },
    );
    expect(popover.getByText("Popover content")).toBeTruthy();
    await fireEvent.press(popover.getByLabelText("Dismiss popover"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Menu fires selection and closes after an enabled action", async () => {
    const action = jest.fn();
    const onDismiss = jest.fn();
    const screen = await render(
      <Menu
        anchorRect={{ top: 80, bottom: 124, left: 40, right: 84 }}
        entries={[{ id: "rename", label: "Rename", onPress: action }]}
        onDismiss={onDismiss}
        visible
      />,
      { wrapper: Providers },
    );
    await fireEvent.press(screen.getByText("Rename"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Sheet mounts content and ActionSheet exposes a cancel affordance", async () => {
    const sheet = await render(
      <Sheet onDismiss={jest.fn()} visible>
        <SheetHeader title="Sheet title" />
        <Text>Sheet body</Text>
      </Sheet>,
      { wrapper: Providers },
    );
    await waitFor(() => expect(sheet.getByText("Sheet body")).toBeTruthy());
    await sheet.unmount();

    const onDismiss = jest.fn();
    const actionSheet = await render(
      <ActionSheet
        actions={[{ id: "archive", label: "Archive", onPress: jest.fn() }]}
        onDismiss={onDismiss}
        visible
      />,
      { wrapper: Providers },
    );
    await waitFor(() => expect(actionSheet.getByText("Cancel")).toBeTruthy());
    await fireEvent.press(actionSheet.getByText("Cancel"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Tooltip opens on long press and Collapse keeps dynamic content mounted", async () => {
    const tooltip = await render(
      <Tooltip content="Helpful context">
        <View accessibilityLabel="Help trigger" />
      </Tooltip>,
      { wrapper: Providers },
    );
    const trigger = tooltip.getByHintText("Helpful context");
    await fireEvent(trigger, "layout", {
      nativeEvent: { layout: { x: 40, y: 80, width: 44, height: 44 } },
    });
    await fireEvent(trigger, "longPress");
    await waitFor(() => expect(tooltip.getByText("Helpful context")).toBeTruthy());
    await tooltip.unmount();

    const collapse = await render(
      <Collapse open>
        <Text>Disclosure content</Text>
      </Collapse>,
      { wrapper: Providers },
    );
    expect(collapse.getByText("Disclosure content")).toBeTruthy();
  });

  test("Toast dismisses from its close control", async () => {
    const onDismiss = jest.fn();
    const toast: ToastRecord = {
      id: "notice",
      message: "Connected",
      variant: "success",
      durationMs: 5_000,
      expiresAt: 10_000,
      leaving: false,
    };
    const screen = await render(<Toast onDismiss={onDismiss} toast={toast} />, {
      wrapper: Providers,
    });
    expect(screen.getByText("Connected")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Dismiss notification"));
    expect(onDismiss).toHaveBeenCalledWith("notice");
  });

  test("reduced-motion variants still render their final state", async () => {
    const reducedMotion = jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockResolvedValueOnce(true);
    const screen = await render(
      <Dialog onDismiss={jest.fn()} title="Reduced" visible>
        <Text>Final state</Text>
      </Dialog>,
      { wrapper: Providers },
    );
    await waitFor(() => expect(screen.getByText("Final state")).toBeTruthy());
    reducedMotion.mockRestore();
  });
});
