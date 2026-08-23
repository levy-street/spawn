import { fireEvent, render, screen } from "@testing-library/react-native";

import { TerminalCommandsSheet } from "@/components/terminal-ui/terminal-commands-sheet";
import { ThemeProvider } from "@/theme";

jest.mock("@/components/ui/sheet", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    Sheet: ({ children, visible }: React.PropsWithChildren<{ visible: boolean }>) =>
      visible ? React.createElement(View, { testID: "mock-sheet" }, children) : null,
    SheetHeader: ({ title, action }: { title: string; action?: React.ReactNode }) =>
      React.createElement(View, null, React.createElement(Text, null, title), action),
    SheetScrollView: View,
  };
});

async function renderSheet(
  props?: Partial<React.ComponentProps<typeof TerminalCommandsSheet>>,
): Promise<{ onCommand: jest.Mock; onTogglePin: jest.Mock }> {
  const onCommand = jest.fn();
  const onTogglePin = jest.fn(() => true);
  await render(
    <ThemeProvider>
      <TerminalCommandsSheet
        kind="claude-code"
        onCommand={onCommand}
        onDismiss={jest.fn()}
        onTogglePin={onTogglePin}
        pinned={["key-Escape"]}
        visible
        {...props}
      />
    </ThemeProvider>,
  );
  return { onCommand, onTogglePin };
}

describe("terminal commands drawer", () => {
  test("says which agent's keys these are", async () => {
    await renderSheet();
    expect(screen.getByText("Claude Code keys")).toBeOnTheScreen();
  });

  test("names an agent key by what it does, not by which key it is", async () => {
    const { onCommand } = await renderSheet();

    await fireEvent.press(screen.getByRole("button", { name: "Cycle mode" }));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "key-BackTab" }));
  });

  test("sends rather than pins until pinning is asked for", async () => {
    const { onCommand, onTogglePin } = await renderSheet();

    await fireEvent.press(screen.getByRole("button", { name: "Interrupt" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onTogglePin).not.toHaveBeenCalled();

    // A visible mode with a way out, rather than a long press nobody discovers.
    await fireEvent.press(screen.getByTestId("commands-pin-toggle"));
    expect(screen.getByTestId("commands-pin-hint")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Unpin Interrupt" }));
    expect(onTogglePin).toHaveBeenCalledWith("key-Escape");
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  test("marks what is already on the strip while pinning", async () => {
    await renderSheet({ pinned: ["ctrl-a"] });
    await fireEvent.press(screen.getByTestId("commands-pin-toggle"));

    expect(screen.getByRole("button", { name: "Unpin Line start" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Pin Line end" })).toBeOnTheScreen();
  });

  test("comes back out of pin mode when the drawer is closed and reopened", async () => {
    const view = await render(
      <ThemeProvider>
        <TerminalCommandsSheet
          kind="shell"
          onCommand={jest.fn()}
          onDismiss={jest.fn()}
          onTogglePin={jest.fn(() => true)}
          pinned={[]}
          visible
        />
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByTestId("commands-pin-toggle"));
    expect(screen.getByTestId("commands-pin-hint")).toBeOnTheScreen();

    await view.rerender(
      <ThemeProvider>
        <TerminalCommandsSheet
          kind="shell"
          onCommand={jest.fn()}
          onDismiss={jest.fn()}
          onTogglePin={jest.fn(() => true)}
          pinned={[]}
          visible={false}
        />
      </ThemeProvider>,
    );
    await view.rerender(
      <ThemeProvider>
        <TerminalCommandsSheet
          kind="shell"
          onCommand={jest.fn()}
          onDismiss={jest.fn()}
          onTogglePin={jest.fn(() => true)}
          pinned={[]}
          visible
        />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId("commands-pin-hint")).toBeNull();
  });
});
