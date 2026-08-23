import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  inferAgentPresentation,
  TerminalHeader,
  type TerminalHeaderProps,
} from "@/components/terminal-ui/terminal-header";

interface MockHeaderAction {
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}

interface MockAppHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: readonly MockHeaderAction[];
  accessory?: ReactNode;
  testID?: string;
}

interface MockMenuEntry {
  id: string;
  type?: "item" | "separator" | "label";
  label?: string;
  icon?: unknown;
  destructive?: boolean;
  onPress?: () => void;
}
interface MockMenuProps {
  visible: boolean;
  entries: readonly MockMenuEntry[];
}

let mockAppHeaderProps: MockAppHeaderProps | null = null;
let mockMenuProps: MockMenuProps | null = null;

jest.mock("@/components/layout/app-header", () => {
  const React = require("react") as typeof import("react");
  const { Pressable, Text, View } = require("react-native") as typeof import("react-native");
  return {
    AppHeader: (props: MockAppHeaderProps) => {
      mockAppHeaderProps = props;
      return React.createElement(
        View,
        { testID: props.testID },
        props.onBack
          ? React.createElement(
              Pressable,
              { accessibilityLabel: "Back", accessibilityRole: "button", onPress: props.onBack },
              React.createElement(Text, null, "Back"),
            )
          : null,
        React.createElement(Text, null, props.title),
        props.subtitle ? React.createElement(Text, null, props.subtitle) : null,
        props.accessory,
        props.actions?.map((action) =>
          React.createElement(
            Pressable,
            {
              accessibilityLabel: action.accessibilityLabel,
              accessibilityRole: "button",
              key: action.accessibilityLabel,
              onPress: action.onPress,
              testID: action.testID,
            },
            React.createElement(Text, null, action.icon),
          ),
        ),
      );
    },
  };
});

jest.mock("@/components/ui/dialog", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    Dialog: ({
      children,
      footer,
      title,
      visible,
    }: {
      children?: React.ReactNode;
      footer?: React.ReactNode;
      title?: string;
      visible: boolean;
    }) =>
      visible
        ? React.createElement(
            View,
            { accessibilityViewIsModal: true, testID: "mock-dialog" },
            React.createElement(Text, null, title),
            children,
            footer,
          )
        : null,
  };
});

jest.mock("@/components/ui/menu", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    Menu: (props: MockMenuProps) => {
      mockMenuProps = props;
      return React.createElement(
        View,
        { testID: "mock-menu", accessibilityState: { expanded: props.visible } },
        props.entries.map((entry) => React.createElement(Text, { key: entry.id }, entry.label)),
      );
    },
  };
});

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

function props(overrides: Partial<TerminalHeaderProps> = {}): TerminalHeaderProps {
  return {
    title: "Build",
    hostName: "studio",
    cwd: "/Users/dev/spawn",
    foregroundCommand: "codex",
    onBack: jest.fn(),
    onRename: jest.fn(async () => undefined),
    onChangeFolder: jest.fn(),
    onSwitchAgent: jest.fn(),
    onRestart: jest.fn(),
    onKill: jest.fn(),
    onUpload: jest.fn(),
    onSearch: jest.fn(),
    onFontSize: jest.fn(),
    onCopyMode: jest.fn(),
    onDiagnostics: jest.fn(),
    ...overrides,
  };
}

async function renderHeader(input: TerminalHeaderProps) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <TerminalHeader {...input} />
    </SafeAreaProvider>,
  );
}

describe("TerminalHeader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppHeaderProps = null;
    mockMenuProps = null;
  });

  test("uses AppHeader with its standard back action and terminal metadata", async () => {
    const input = props();
    await renderHeader(input);

    expect(mockAppHeaderProps).toMatchObject({
      title: "Build",
      subtitle: "Codex · studio",
      testID: "terminal-header",
    });
    expect(mockAppHeaderProps?.actions).toEqual([
      expect.objectContaining({
        accessibilityLabel: "Terminal actions",
        icon: "Ellipsis",
      }),
    ]);
    // No connection chip in the header any more — the overlay is the one place
    // the connection reports itself.
    expect(screen.queryByTestId("terminal-connection-chip")).toBeNull();

    await act(() => fireEvent.press(screen.getByRole("button", { name: "Back" })));
    expect(input.onBack).toHaveBeenCalledTimes(1);
  });

  test("presents every action as a drawer row and marks kill destructive", async () => {
    const input = props();
    await renderHeader(input);
    const entries = mockMenuProps?.entries ?? [];
    const items = entries.filter((entry) => entry.type !== "separator");

    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Change agent",
      "Change folder",
      "Restart",
      "Upload file",
      "Search terminal",
      "Font size",
      "Copy mode",
      "Diagnostics",
      "Kill session",
    ]);
    // Every row carries a glyph, and the menu draws exactly one rule: the one
    // that sets the destructive action apart. Rows are not divided from each other.
    expect(items.every((item) => item.icon !== undefined)).toBe(true);
    expect(entries.filter((entry) => entry.type === "separator")).toHaveLength(1);
    expect(entries.at(-2)).toMatchObject({ type: "separator" });
    expect(items.at(-1)).toMatchObject({ id: "kill", destructive: true });

    await act(() => fireEvent.press(screen.getByLabelText("Terminal actions")));
    expect(screen.getByTestId("mock-menu")).toHaveProp("accessibilityState", {
      expanded: true,
    });

    await act(() => items.find((item) => item.id === "rename")?.onPress?.());
    expect(screen.getByTestId("mock-dialog")).toBeTruthy();
    expect(screen.getByLabelText("Session name")).toBeTruthy();
    items.find((item) => item.id === "switch-agent")?.onPress?.();
    items.find((item) => item.id === "change-folder")?.onPress?.();
    items.find((item) => item.id === "restart")?.onPress?.();
    items.find((item) => item.id === "upload")?.onPress?.();
    items.find((item) => item.id === "search")?.onPress?.();
    items.find((item) => item.id === "font-size")?.onPress?.();
    items.find((item) => item.id === "copy-mode")?.onPress?.();
    items.find((item) => item.id === "diagnostics")?.onPress?.();
    items.find((item) => item.id === "kill")?.onPress?.();
    expect(input.onSwitchAgent).toHaveBeenCalledTimes(1);
    expect(input.onChangeFolder).toHaveBeenCalledTimes(1);
    expect(input.onRestart).toHaveBeenCalledTimes(1);
    expect(input.onUpload).toHaveBeenCalledTimes(1);
    expect(input.onSearch).toHaveBeenCalledTimes(1);
    expect(input.onFontSize).toHaveBeenCalledTimes(1);
    expect(input.onCopyMode).toHaveBeenCalledTimes(1);
    expect(input.onDiagnostics).toHaveBeenCalledTimes(1);
    expect(input.onKill).toHaveBeenCalledTimes(1);
  });
});

describe("inferAgentPresentation", () => {
  test.each([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["aider", "Aider"],
    [null, "Shell"],
  ])("maps %s to %s", (command, label) => {
    expect(inferAgentPresentation(command)).toEqual({ label });
  });
});
