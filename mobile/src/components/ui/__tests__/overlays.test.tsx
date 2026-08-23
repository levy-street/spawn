import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Screen } from "@/components/layout/screen";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Collapse } from "@/components/ui/collapse";
import { Confirm, ConfirmHost, confirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { NativePopover } from "@/components/ui/native-popover";
import { Popover } from "@/components/ui/popover";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { SwipeDismissOverlay } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { Toast, type ToastRecord } from "@/components/ui/toast";
import { borderWidth, lightColors, spacing, ThemeProvider } from "@/theme";

jest.mock("@gorhom/bottom-sheet", () => {
  const actual = jest.requireActual<typeof import("@gorhom/bottom-sheet")>("@gorhom/bottom-sheet");
  const { ScrollView } = jest.requireActual("react-native") as typeof import("react-native");
  return { ...actual, BottomSheetScrollView: ScrollView };
});

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
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
  });

  test("Dialog renders a full-page surface and dismisses from the close control", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Dialog onDismiss={onDismiss} title="Connection" visible>
        <Text>Dialog body</Text>
      </Dialog>,
      { wrapper: Providers },
    );
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Dialog body")).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("dialog-content").props["style"])).toMatchObject({
      backgroundColor: lightColors.background,
      flex: 1,
      width: "100%",
    });
    expect(StyleSheet.flatten(screen.getByTestId("dialog-header").props["style"])).toMatchObject({
      paddingTop: METRICS.insets.top + spacing[3],
    });
    // The dialog states its own answers: nothing is pinned to the foot unless the
    // caller passes actions, so a lone "Close" never stacks under a form's own row.
    expect(screen.queryByTestId("footer-actions")).toBeNull();
    expect(screen.queryByLabelText("Dismiss dialog")).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Close dialog"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Dialog clears its owned top inset for nested full-page content", async () => {
    const screen = await render(
      <Dialog onDismiss={jest.fn()} showCloseButton={false} title="New workspace" visible>
        <Screen>
          <Text>First field</Text>
        </Screen>
      </Dialog>,
      { wrapper: Providers },
    );

    expect(StyleSheet.flatten(screen.getByTestId("screen-content").props["style"])).toMatchObject({
      paddingTop: spacing[0],
    });
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
    expect(screen.getByTestId("footer-actions").children).toHaveLength(2);
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
    await waitFor(() => expect(popover.getByText("Popover content")).toBeTruthy());
    expect(popover.getByLabelText("Dismiss drawer")).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText("Rename")).toBeTruthy());
    await fireEvent.press(screen.getByText("Rename"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(StyleSheet.flatten(screen.getByTestId("menu-surface").props["style"])).toMatchObject({
      backgroundColor: lightColors.popover,
      borderWidth: borderWidth.none,
    });
  });

  test("NativePopover renders and selects from a solid themed surface", async () => {
    const action = jest.fn();
    const onDismiss = jest.fn();
    const screen = await render(
      <NativePopover
        anchor={{ x: 40, y: 80, width: 44, height: 44 }}
        items={[{ key: "rename", label: "Rename", onPress: action }]}
        onDismiss={onDismiss}
        visible
      />,
      { wrapper: Providers },
    );

    await waitFor(() => expect(screen.getByTestId("native-popover-surface")).toBeTruthy());
    expect(
      StyleSheet.flatten(screen.getByTestId("native-popover-surface").props["style"]),
    ).toMatchObject({
      backgroundColor: lightColors.popover,
      borderWidth: borderWidth.none,
    });
    await fireEvent.press(screen.getByTestId("native-popover-item-rename"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Sheet mounts content and ActionSheet carries only its actions", async () => {
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
    // Drawers carry their actions and nothing else now — no title, no cancel row.
    // Dismissing is the scrim, the drag, or the system gesture.
    await waitFor(() => expect(actionSheet.getByText("Archive")).toBeTruthy());
    expect(actionSheet.queryByText("Cancel")).toBeNull();
    await fireEvent.press(actionSheet.getByText("Archive"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Collapse keeps dynamic content mounted", async () => {
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
