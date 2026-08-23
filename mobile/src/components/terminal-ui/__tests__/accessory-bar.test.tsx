import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { TerminalAccessoryBar } from "@/components/terminal-ui/accessory-bar";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: jest.fn(async () => undefined) },
}));

async function renderBar(props?: Partial<React.ComponentProps<typeof TerminalAccessoryBar>>) {
  const onSend = jest.fn();
  const onAttach = jest.fn();
  const onMore = jest.fn();
  const onDismissKeyboard = jest.fn();
  const encode = jest.fn(() => "encoded");
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <ThemeProvider>
        <TerminalAccessoryBar
          encode={encode}
          onAttach={onAttach}
          onDismissKeyboard={onDismissKeyboard}
          onMore={onMore}
          onSend={onSend}
          {...props}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { encode, onAttach, onDismissKeyboard, onMore, onSend };
}

describe("terminal accessory bar", () => {
  test("carries only the keys an agent reaches for, plus a way to the rest", async () => {
    await renderBar();

    for (const name of ["Esc", /^Tab/, "Control C", "More"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // Modifiers, control codes, symbols, arrows and function keys all moved
    // into More; paste and the upload paths into the attach drawer.
    for (const name of [/^Control,/, /^Alt,/, "Paste", "^D", "|", "Arrow up"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  test("encodes a key and forwards both the sequence and the spec", async () => {
    const { encode, onSend } = await renderBar();
    await fireEvent.press(screen.getByRole("button", { name: "Esc" }));

    expect(encode).toHaveBeenCalledWith({ kind: "named", key: "Escape" });
    expect(onSend).toHaveBeenCalledWith("encoded", { kind: "named", key: "Escape" });
  });

  test("holding Tab sends Shift Tab instead", async () => {
    const { encode } = await renderBar();
    await fireEvent(screen.getByRole("button", { name: "Tab, hold for Shift Tab" }), "longPress");

    expect(encode).toHaveBeenCalledWith({ kind: "named", key: "BackTab" });
  });

  test("hands every drawer up to the screen, which owns the keyboard", async () => {
    const { onMore } = await renderBar();
    await fireEvent.press(screen.getByRole("button", { name: "More" }));

    expect(onMore).toHaveBeenCalledTimes(1);
  });

  test("pins attach and send either side of the key row", async () => {
    const { onAttach, onSend } = await renderBar();
    expect(screen.getByTestId("terminal-accessory-bar")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("accessory-attach"));
    expect(onAttach).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId("accessory-send"));
    expect(onSend).toHaveBeenCalledWith("encoded", { kind: "named", key: "Enter" });
  });

  test("keeps its plates below a standard control so the strip stays thin", async () => {
    await renderBar();
    const send = screen.getByTestId("accessory-send");
    const height = sizing.terminalAccessory.controlHeight;

    expect(height).toBeLessThan(sizing.control.minimumTouchTarget);
    // Button restores the target with hit-slop, so the plate may shrink safely.
    expect(Number(send.props["hitSlop"]) * 2 + height).toBeGreaterThanOrEqual(
      sizing.control.minimumTouchTarget,
    );
  });

  test("disables everything that would reach a terminal that is not ready", async () => {
    const { onSend } = await renderBar({ disabled: true });
    await fireEvent.press(screen.getByTestId("accessory-send"));
    await fireEvent.press(screen.getByRole("button", { name: "Esc" }));

    expect(onSend).not.toHaveBeenCalled();
    // Dismissing the keyboard is always allowed; it touches nothing remote.
    expect(screen.getByRole("button", { name: "Dismiss keyboard" })).toBeTruthy();
  });
});
