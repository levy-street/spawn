import { fireEvent, render, screen } from "@testing-library/react-native";

import { JumpToLatest } from "@/components/terminal-ui/jump-to-latest";
import { SelectionToolbar } from "@/components/terminal-ui/selection-toolbar";
import { TerminalKeysSheet } from "@/components/terminal-ui/terminal-keys-sheet";
import { ThemeProvider } from "@/theme";

jest.mock("@/components/ui/sheet", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    Sheet: ({ children, visible }: React.PropsWithChildren<{ visible: boolean }>) =>
      visible ? React.createElement(View, { testID: "mock-sheet" }, children) : null,
    SheetHeader: ({ title }: { title: string }) => React.createElement(Text, null, title),
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

  test("sends the selected named key from the shared key sheet", async () => {
    const onKey = jest.fn();
    await render(
      <ThemeProvider>
        <TerminalKeysSheet onDismiss={jest.fn()} onKey={onKey} visible />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Page up" }));
    expect(onKey).toHaveBeenCalledWith({ kind: "named", key: "PageUp" });
  });
});
