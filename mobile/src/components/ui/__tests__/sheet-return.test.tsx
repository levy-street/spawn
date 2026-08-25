import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { type PropsWithChildren, useState } from "react";
import { Text as NativeText, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Dialog } from "@/components/ui/dialog";
import { resetOverlayStack } from "@/components/ui/overlay-stack";
import { Sheet } from "@/components/ui/sheet";
import { ThemeProvider } from "@/theme";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const menuHandlers = { onDismiss: jest.fn(), onReturn: jest.fn() };
const pickerDismiss = jest.fn();

/**
 * A menu whose row raises a picker. Pressing the row closes the menu and opens
 * the picker in the same breath — one commit, which is what every
 * drawer-opened-from-a-drawer does, and the reason the first one used to go for
 * good.
 */
function Pair(): React.JSX.Element {
  const [menu, setMenu] = useState(true);
  const [picker, setPicker] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => {
          setMenu(false);
          setPicker(true);
        }}
      >
        <NativeText>Open the picker</NativeText>
      </Pressable>
      <Sheet
        onDismiss={() => {
          menuHandlers.onDismiss();
          setMenu(false);
        }}
        onReturn={() => {
          menuHandlers.onReturn();
          setMenu(true);
        }}
        visible={menu}
      >
        <NativeText>Menu row</NativeText>
      </Sheet>
      <Sheet
        onDismiss={() => {
          pickerDismiss();
          setPicker(false);
        }}
        visible={picker}
      >
        <Pressable onPress={() => setPicker(false)}>
          <NativeText>Picker row</NativeText>
        </Pressable>
      </Sheet>
    </>
  );
}

/** A sheet rises only once it has measured itself, so the test says how tall. */
async function measurePanels(height: number): Promise<void> {
  for (const panel of screen.queryAllByTestId("sheet-panel")) {
    await act(() =>
      fireEvent(panel, "layout", { nativeEvent: { layout: { height, width: 390, x: 0, y: 0 } } }),
    );
  }
}

/** The scrim of the drawer on top, which is what a tap outside it lands on. */
async function dismissTopmost(): Promise<void> {
  const scrims = screen.queryAllByTestId("sheet-scrim");
  const top = scrims.at(-1);
  if (!top) throw new Error("No drawer is on screen.");
  await act(() => fireEvent(top, "accessibilityTap"));
}

async function raisePickerFromMenu(): Promise<void> {
  await act(() => fireEvent.press(screen.getByText("Open the picker")));
  await measurePanels(300);
  await waitFor(() => expect(screen.getByText("Picker row")).toBeTruthy());
  // The menu only takes its place underneath once its exit has finished playing.
  await waitFor(() => {
    const overlays = screen.queryAllByTestId("sheet-overlay");
    expect(overlays[0]).toHaveProp("pointerEvents", "none");
  });
}

describe("a drawer opened from inside a drawer", () => {
  beforeEach(() => {
    resetOverlayStack();
    jest.clearAllMocks();
  });

  it("brings the first one back when the second is dismissed rather than acted on", async () => {
    const view = await render(<Pair />, { wrapper: Providers });
    await measurePanels(300);
    expect(screen.getByText("Menu row")).toBeTruthy();

    await raisePickerFromMenu();

    // The menu waits underneath rather than tearing down, still showing what it
    // was even though its owner has already let go of it.
    expect(menuHandlers.onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText("Menu row")).toBeTruthy();

    // A tap outside the picker: dismissed, not answered.
    await dismissTopmost();
    await waitFor(() => expect(menuHandlers.onReturn).toHaveBeenCalledTimes(1));
    expect(menuHandlers.onDismiss).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("keeps a returned drawer up although its owner still holds it closed", async () => {
    // Most owners never mirror the return: they let go of the drawer when they
    // raised the next one and hear nothing more. The returned drawer used to
    // read that stale `visible={false}` as an order and go straight back down.
    function Unmirrored(): React.JSX.Element {
      const [menu, setMenu] = useState(true);
      const [picker, setPicker] = useState(false);
      return (
        <>
          <Pressable
            onPress={() => {
              setMenu(false);
              setPicker(true);
            }}
          >
            <NativeText>Open the picker</NativeText>
          </Pressable>
          <Sheet
            onDismiss={() => {
              menuHandlers.onDismiss();
              setMenu(false);
            }}
            visible={menu}
          >
            <NativeText>Menu row</NativeText>
          </Sheet>
          <Sheet
            onDismiss={() => {
              pickerDismiss();
              setPicker(false);
            }}
            visible={picker}
          >
            <NativeText>Picker row</NativeText>
          </Sheet>
        </>
      );
    }

    const view = await render(<Unmirrored />, { wrapper: Providers });
    await measurePanels(300);
    await raisePickerFromMenu();

    await dismissTopmost();
    await waitFor(() => expect(screen.queryByText("Picker row")).toBeNull());
    // Back on screen and taking touches again — and staying, with no
    // dismissal reported to an owner that never asked for one.
    await waitFor(() => {
      expect(screen.getAllByTestId("sheet-overlay")[0]).toHaveProp("pointerEvents", "auto");
    });
    expect(screen.getByText("Menu row")).toBeTruthy();
    expect(menuHandlers.onDismiss).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("takes both away when the second one is answered instead", async () => {
    const view = await render(<Pair />, { wrapper: Providers });
    await measurePanels(300);
    await raisePickerFromMenu();

    // A row press inside the picker: its owner closes it because the thing it
    // was raised to ask has been answered. The menu has no business coming back
    // over the result.
    await act(() => fireEvent.press(screen.getByText("Picker row")));
    await waitFor(() => expect(screen.queryByText("Picker row")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Menu row")).toBeNull());
    expect(menuHandlers.onReturn).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("brings the drawer back when a full-page form raised from it is backed out of", async () => {
    // A form is a different presentation, but backing out of one is the same
    // gesture as dismissing a drawer, and the row it came from sat in the menu
    // right next to rows that raise drawers.
    function MenuAndForm(): React.JSX.Element {
      const [menu, setMenu] = useState(true);
      const [form, setForm] = useState(false);
      return (
        <>
          <Pressable
            onPress={() => {
              setMenu(false);
              setForm(true);
            }}
          >
            <NativeText>Rename</NativeText>
          </Pressable>
          <Sheet
            onDismiss={() => {
              menuHandlers.onDismiss();
              setMenu(false);
            }}
            onReturn={() => {
              menuHandlers.onReturn();
              setMenu(true);
            }}
            visible={menu}
          >
            <NativeText>Menu row</NativeText>
          </Sheet>
          <Dialog onDismiss={() => setForm(false)} title="Rename session" visible={form}>
            <NativeText>Form body</NativeText>
          </Dialog>
        </>
      );
    }

    const view = await render(<MenuAndForm />, { wrapper: Providers });
    await measurePanels(300);
    await act(() => fireEvent.press(screen.getByText("Rename")));
    await measurePanels(300);
    await waitFor(() => expect(screen.getByText("Form body")).toBeTruthy());
    await waitFor(() => {
      expect(screen.queryAllByTestId("sheet-overlay")[0]).toHaveProp("pointerEvents", "none");
    });

    await act(() => fireEvent.press(screen.getByLabelText("Close dialog")));
    await waitFor(() => expect(menuHandlers.onReturn).toHaveBeenCalledTimes(1));
    expect(menuHandlers.onDismiss).not.toHaveBeenCalled();
    await view.unmount();
  });
});
