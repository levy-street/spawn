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

interface MockPopoverProps {
  visible: boolean;
  items: Array<{
    key: string;
    label: string;
    icon?: string;
    destructive?: boolean;
    onPress: () => void;
  }>;
}

let mockAppHeaderProps: MockAppHeaderProps | null = null;
let mockPopoverProps: MockPopoverProps | null = null;

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

jest.mock("@/components/ui/native-popover", () => {
  const React = require("react") as typeof import("react");
  const { Text, View } = require("react-native") as typeof import("react-native");
  return {
    NativePopover: (props: MockPopoverProps) => {
      mockPopoverProps = props;
      return React.createElement(
        View,
        { testID: "mock-native-popover", accessibilityState: { expanded: props.visible } },
        props.items.map((item) => React.createElement(Text, { key: item.key }, item.label)),
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
    foregroundCommand: "codex",
    onBack: jest.fn(),
    onRename: jest.fn(async () => undefined),
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
    mockPopoverProps = null;
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

  test("renders every action through NativePopover and marks kill destructive", async () => {
    const input = props();
    await renderHeader(input);
    const items = mockPopoverProps?.items ?? [];

    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      "Restart",
      "Upload file",
      "Search terminal",
      "Font size",
      "Copy mode",
      "Diagnostics",
      "Kill session",
    ]);
    expect(items.map((item) => item.icon)).toEqual([
      "pencil",
      "arrow.clockwise",
      "square.and.arrow.up",
      "magnifyingglass",
      "textformat.size",
      "doc.on.doc",
      "wrench.and.screwdriver",
      "trash",
    ]);
    expect(items.at(-1)).toMatchObject({ key: "kill", destructive: true });

    await act(() => fireEvent.press(screen.getByLabelText("Terminal actions")));
    expect(screen.getByTestId("mock-native-popover")).toHaveProp("accessibilityState", {
      expanded: true,
    });

    await act(() => items.find((item) => item.key === "rename")?.onPress());
    expect(screen.getByTestId("mock-dialog")).toBeTruthy();
    expect(screen.getByLabelText("Session name")).toBeTruthy();
    items.find((item) => item.key === "restart")?.onPress();
    items.find((item) => item.key === "upload")?.onPress();
    items.find((item) => item.key === "search")?.onPress();
    items.find((item) => item.key === "font-size")?.onPress();
    items.find((item) => item.key === "copy-mode")?.onPress();
    items.find((item) => item.key === "diagnostics")?.onPress();
    items.find((item) => item.key === "kill")?.onPress();
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
