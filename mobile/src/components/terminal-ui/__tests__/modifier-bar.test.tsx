import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ModifierBar } from "@/components/terminal-ui/modifier-bar";
import { ThemeProvider } from "@/theme";

jest.mock("react-native-keyboard-controller", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    KeyboardController: { dismiss: jest.fn(async () => undefined) },
    KeyboardStickyView: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(View, props, children),
    useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
      selector({ isVisible: false }),
  };
});

jest.mock("@/components/terminal-ui/terminal-keys-sheet", () => ({
  TerminalKeysSheet: () => null,
}));

async function renderBar(props?: Partial<React.ComponentProps<typeof ModifierBar>>) {
  const onSend = jest.fn();
  const encode = jest.fn(() => "encoded");
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <ThemeProvider>
        <ModifierBar
          encode={encode}
          onDismissKeyboard={jest.fn()}
          onPaste={jest.fn()}
          onSend={onSend}
          sessionId="session-1"
          {...props}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { encode, onSend };
}

describe("terminal modifier bar", () => {
  test("encodes a momentary modifier into the next KeySpec and forwards the result", async () => {
    const { encode, onSend } = await renderBar();
    await fireEvent.press(screen.getByTestId("modifier-ctrl"));
    await fireEvent.press(screen.getByRole("button", { name: "|" }));

    expect(encode).toHaveBeenCalledWith({
      kind: "text",
      text: "|",
      modifiers: { ctrl: true },
    });
    expect(onSend).toHaveBeenCalledWith("encoded", {
      kind: "text",
      text: "|",
      modifiers: { ctrl: true },
    });

    await fireEvent.press(screen.getByRole("button", { name: "/" }));
    expect(encode).toHaveBeenLastCalledWith({ kind: "text", text: "/", modifiers: {} });
  });

  test("double-tap lock survives multiple key presses", async () => {
    const { encode } = await renderBar();
    const control = screen.getByTestId("modifier-ctrl");
    await fireEvent.press(control);
    await fireEvent.press(control);
    await fireEvent.press(screen.getByRole("button", { name: "/" }));
    await fireEvent.press(screen.getByRole("button", { name: "-" }));

    expect(encode).toHaveBeenNthCalledWith(1, {
      kind: "text",
      text: "/",
      modifiers: { ctrl: true },
    });
    expect(encode).toHaveBeenNthCalledWith(2, {
      kind: "text",
      text: "-",
      modifiers: { ctrl: true },
    });
  });

  test("keeps Send pinned outside the horizontal key scroller", async () => {
    await renderBar();
    expect(screen.getByTestId("modifier-send")).toBeOnTheScreen();
    expect(screen.getByTestId("terminal-modifier-bar")).toBeOnTheScreen();
  });
});
