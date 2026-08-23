import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { TerminalAccessoryBar } from "@/components/terminal-ui/accessory-bar";
import { resolvePinnedCommands } from "@/components/terminal-ui/terminal-commands";
import { spacing, ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

const mockKeyboard = { visible: true };

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: jest.fn(async () => undefined) },
  useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
    selector({ isVisible: mockKeyboard.visible }),
}));

const claudeCommands = resolvePinnedCommands("claude-code", [
  "key-Escape",
  "key-BackTab",
  "text-/",
]);

async function renderBar(props?: Partial<React.ComponentProps<typeof TerminalAccessoryBar>>) {
  const onSend = jest.fn();
  const onCommand = jest.fn();
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
          onCommand={onCommand}
          onDismissKeyboard={onDismissKeyboard}
          onMore={onMore}
          onSend={onSend}
          {...props}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { encode, onAttach, onCommand, onDismissKeyboard, onMore, onSend };
}

describe("terminal accessory bar", () => {
  beforeEach(() => {
    mockKeyboard.visible = true;
  });

  test("carries no key caps of its own — only the ones pinned for this agent", async () => {
    await renderBar();

    // The strip used to be a fixed, partial keyboard above the real one, the same
    // rank whether a shell or Claude Code was running. With nothing pinned it is
    // four round controls, and every key is behind the shortcuts button.
    for (const name of ["Esc", /^Tab/, "Control C", "More", "^D", "|", "Arrow up"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByTestId("accessory-shortcuts")).toBeOnTheScreen();
  });

  test("hands every drawer up to the screen, which owns the keyboard", async () => {
    const { onMore } = await renderBar();
    await fireEvent.press(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(onMore).toHaveBeenCalledTimes(1);
  });

  test("pins attach and send either side of the strip", async () => {
    const { onAttach, onSend } = await renderBar();
    expect(screen.getByTestId("terminal-accessory-bar")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("accessory-attach"));
    expect(onAttach).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId("accessory-send"));
    expect(onSend).toHaveBeenCalledWith("encoded", { kind: "named", key: "Enter" });
  });

  test("shows the keys pinned for the running agent and hands back the one pressed", async () => {
    const { onCommand } = await renderBar({ commands: claudeCommands });

    expect(screen.getByTestId("accessory-command-key-Escape")).toBeOnTheScreen();
    expect(screen.getByTestId("accessory-command-key-BackTab")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Cycle mode" }));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "key-BackTab", cap: "⇧⇥" }),
    );
  });

  test("offers the keyboard dismissal, drawn large, while a keyboard is up", async () => {
    await renderBar();
    expect(screen.getByTestId("accessory-dismiss-keyboard")).toBeOnTheScreen();

    // It is the one control here aimed at while the keyboard is in the way, so
    // its chevron is drawn above the size the rest of the strip's glyphs share.
    // The glyph itself is hidden from assistive tech — its button carries the
    // label — so the query has to reach past that to measure it.
    const chevron = screen.getByTestId("accessory-dismiss-keyboard-icon", {
      includeHiddenElements: true,
    });
    expect(chevron).toHaveStyle({ height: sizing.terminalAccessory.dismissIcon });
    expect(sizing.terminalAccessory.dismissIcon).toBeGreaterThan(spacing[4]);
  });

  test("drops the dismissal once there is no keyboard to dismiss", async () => {
    mockKeyboard.visible = false;
    await renderBar();

    expect(screen.queryByTestId("accessory-dismiss-keyboard")).toBeNull();
    expect(screen.getByTestId("accessory-send")).toBeOnTheScreen();
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
    const { onAttach, onCommand, onMore, onSend } = await renderBar({
      commands: claudeCommands,
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId("accessory-send"));
    await fireEvent.press(screen.getByTestId("accessory-shortcuts"));
    await fireEvent.press(screen.getByTestId("accessory-attach"));
    await fireEvent.press(screen.getByTestId("accessory-command-key-Escape"));

    expect(onSend).not.toHaveBeenCalled();
    expect(onMore).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    // Dismissing the keyboard is always allowed; it touches nothing remote.
    expect(screen.getByRole("button", { name: "Dismiss keyboard" })).toBeTruthy();
  });
});
