import { act, fireEvent, render, screen } from "@testing-library/react-native";

import {
  inferAgentPresentation,
  TerminalHeader,
  type TerminalHeaderProps,
} from "@/components/terminal-ui/terminal-header";
import { sizing } from "@/theme/sizing";

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

let mockStackScreenOptions: Record<string, unknown> = {};
let mockPopoverProps: MockPopoverProps | null = null;

jest.mock("expo-router", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    Stack: {
      Screen: ({ options }: { options: Record<string, unknown> }) => {
        mockStackScreenOptions = options;
        const headerTitle = options["headerTitle"] as (() => React.ReactNode) | undefined;
        const headerRight = options["headerRight"] as (() => React.ReactNode) | undefined;
        return React.createElement(
          View,
          { testID: "mock-terminal-stack-screen" },
          headerTitle?.(),
          headerRight?.(),
        );
      },
    },
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

jest.mock("@/components/workspace-detail/agent-icon", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    AgentIcon: ({ size }: { size: number }) =>
      React.createElement(View, {
        accessibilityLabel: "Terminal agent mark",
        style: { height: size, width: size },
      }),
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
    connectionState: "failed",
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

describe("TerminalHeader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackScreenOptions = {};
    mockPopoverProps = null;
  });

  test("uses the native header without a custom back control or folder path", async () => {
    await render(<TerminalHeader {...props()} />);

    expect(mockStackScreenOptions["headerShown"]).toBe(true);
    expect(mockStackScreenOptions["headerLeft"]).toBeUndefined();
    expect(screen.queryByLabelText("Close terminal")).toBeNull();
    expect(screen.queryByText("/workspace")).toBeNull();
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Codex · studio")).toBeTruthy();
  });

  test("spaces the agent mark and aligns the status with the title row", async () => {
    await render(<TerminalHeader {...props()} />);

    expect(screen.getByTestId("terminal-header")).toHaveStyle({
      alignItems: "center",
      gap: sizing.space.cluster,
    });
    expect(screen.getByTestId("terminal-header-title-line")).toHaveStyle({
      alignItems: "center",
      minHeight: sizing.type.cardTitle.lineHeight,
    });
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  test("renders every action through NativePopover and marks kill destructive", async () => {
    const input = props();
    await render(<TerminalHeader {...input} />);
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
    expect(items.at(-1)).toMatchObject({
      key: "kill",
      destructive: true,
    });

    await act(() => fireEvent.press(screen.getByLabelText("Terminal actions")));
    expect(screen.getByTestId("mock-native-popover")).toHaveProp("accessibilityState", {
      expanded: true,
    });

    await act(() => items.find((item) => item.key === "rename")?.onPress());
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
