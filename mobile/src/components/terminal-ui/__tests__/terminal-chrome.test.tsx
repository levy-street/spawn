import { fireEvent, render, screen } from "@testing-library/react-native";

import { JumpToLatest } from "@/components/terminal-ui/jump-to-latest";
import { SelectionToolbar } from "@/components/terminal-ui/selection-toolbar";
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

describe("terminal chrome", () => {
  test("announces unread output and jumps to the latest line", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <JumpToLatest onPress={onPress} unread />
      </ThemeProvider>,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "Jump to latest output, new output available" }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("New")).toBeTruthy();
  });

  test("keeps copy and cancel actions available only while selection is active", async () => {
    const onCopy = jest.fn();
    const onCancel = jest.fn();
    const view = await render(
      <ThemeProvider>
        <SelectionToolbar onCancel={onCancel} onCopy={onCopy} visible={false} />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("terminal-selection-toolbar")).toBeNull();
    await view.rerender(
      <ThemeProvider>
        <SelectionToolbar onCancel={onCancel} onCopy={onCopy} visible />
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Copy terminal selection" }));
    await fireEvent.press(screen.getByRole("button", { name: "Cancel terminal selection" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("sends the pressed key from the commands drawer", async () => {
    const onCommand = jest.fn();
    await render(
      <ThemeProvider>
        <TerminalCommandsSheet
          kind="shell"
          onCommand={onCommand}
          onDismiss={jest.fn()}
          onTogglePin={jest.fn(() => true)}
          pinned={[]}
          visible
        />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Page up" }));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "key-PageUp", spec: { kind: "named", key: "PageUp" } }),
    );
  });
});
