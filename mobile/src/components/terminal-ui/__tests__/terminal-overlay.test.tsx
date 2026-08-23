import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import * as Linking from "expo-linking";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LAUNCH_FOCUS_DELAY_MS } from "@/components/terminal-ui/launch-focus";
import { resetPinnedCommandsCache } from "@/components/terminal-ui/pinned-commands";
import {
  agentKindFor,
  REPEAT_PRESS_GAP_MS,
  resolvePinnedCommands,
  type TerminalCommand,
  terminalCommandsFor,
} from "@/components/terminal-ui/terminal-commands";
import { TerminalOverlay } from "@/components/terminal-ui/terminal-overlay";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { DisplayControlState } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

const mockKeyboard = { visible: false };

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardController: {
    dismiss: async () => {
      mockKeyboard.visible = false;
    },
  },
  useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
    selector({ isVisible: mockKeyboard.visible }),
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));

jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

jest.mock("expo-linking", () => ({
  openURL: jest.fn(async () => undefined),
}));

interface MockHeaderProps {
  onKill?: () => void;
}

let mockHeaderProps: MockHeaderProps = {};

jest.mock("@/components/terminal-ui/terminal-header", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalHeader: (props: MockHeaderProps) => {
      mockHeaderProps = props;
      return React.createElement(View, { testID: "mock-terminal-header" });
    },
  };
});
interface MockAccessoryBarProps {
  onAttach?: () => void;
  onMore?: () => void;
  onCommand?: (command: TerminalCommand) => void;
  commands?: readonly TerminalCommand[];
}

let mockAccessoryBarProps: MockAccessoryBarProps = {};

jest.mock("@/components/terminal-ui/accessory-bar", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalAccessoryBar: (props: MockAccessoryBarProps) => {
      mockAccessoryBarProps = props;
      return React.createElement(View, { testID: "mock-accessory-bar" });
    },
  };
});

let mockAttachSheetProps: { onDismiss?: () => void } = {};

jest.mock("@/components/terminal-ui/attachment-sheet", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    AttachmentSheet: (props: { onDismiss?: () => void; visible: boolean }) => {
      mockAttachSheetProps = props;
      return props.visible ? React.createElement(View, { testID: "mock-attach-sheet" }) : null;
    },
  };
});
jest.mock("@/components/terminal-ui/search-bar", () => ({ TerminalSearchBar: () => null }));
jest.mock("@/components/terminal-ui/session-target-sheets", () => ({
  SessionTargetSheets: () => null,
}));
jest.mock("@/components/terminal-ui/font-size-sheet", () => ({ FontSizeSheet: () => null }));
jest.mock("@/components/terminal-ui/diagnostics-sheet", () => ({ DiagnosticsSheet: () => null }));
jest.mock("@/components/terminal-ui/selection-toolbar", () => ({ SelectionToolbar: () => null }));
jest.mock("@/components/terminal-ui/upload-progress-bar", () => ({
  UploadProgressBar: () => null,
}));
jest.mock("@/components/terminal-ui/connection-status", () => ({
  ConnectionStateOverlay: () => null,
}));
jest.mock("@/components/ui/confirm", () => {
  const React = require("react") as typeof import("react");
  const { Pressable, Text } = require("react-native") as typeof import("react-native");
  return {
    Confirm: ({ onConfirm, visible }: { onConfirm: () => void; visible: boolean }) =>
      visible
        ? React.createElement(
            Pressable,
            { accessibilityLabel: "Confirm kill", onPress: onConfirm },
            React.createElement(Text, null, "Kill session"),
          )
        : null,
  };
});
let mockLaunchResult: ((result: { status: string }) => void) | null = null;
const mockDetachPendingLaunch = jest.fn();

jest.mock("@/data/queries/launcher", () => ({
  attachPendingLaunchDelivery: (
    _transport: unknown,
    options: { onResult?: (result: { status: string }) => void },
  ) => {
    mockLaunchResult = options.onResult ?? null;
    return mockDetachPendingLaunch;
  },
}));

const mockSetNotice = jest.fn();

jest.mock("@/components/terminal-ui/use-terminal-transfers", () => ({
  useTerminalTransfers: () => ({
    notice: null,
    setNotice: mockSetNotice,
    progressRatio: null,
    paste: jest.fn(async () => undefined),
    attach: jest.fn(async () => undefined),
  }),
}));

interface MockSurfaceProps {
  onLink?: (url: string) => void;
  onDisplayChange?: (display: DisplayControlState) => void;
  onTransport?: (transport: unknown) => void;
}

let mockTerminalSurfaceProps: MockSurfaceProps = {};
const mockTakeControl = jest.fn();
const mockBlur = jest.fn();
const mockFocus = jest.fn();
const mockSendKey = jest.fn();
const mockSetFollow = jest.fn();

jest.mock("@/terminal/TerminalSurface", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalSurface: React.forwardRef(
      (
        props: MockSurfaceProps,
        ref: React.ForwardedRef<{
          blur: () => void;
          focus: () => void;
          sendKey: (sequence: string) => void;
          setFollow: (follow: boolean) => void;
          takeControl: () => void;
        }>,
      ) => {
        mockTerminalSurfaceProps = props;
        React.useImperativeHandle(ref, () => ({
          blur: mockBlur,
          focus: mockFocus,
          sendKey: mockSendKey,
          setFollow: mockSetFollow,
          takeControl: mockTakeControl,
        }));
        return React.createElement(View, { testID: "terminal" });
      },
    ),
  };
});

const session: SessionOut = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Build",
  host_id: "00000000-0000-4000-8000-000000000002",
  host_name: "studio",
  cwd: "/workspace",
  status: "running",
  started_at: "2026-08-22T00:00:00Z",
  exited_at: null,
  exit_code: null,
  last_output_at: null,
  last_input_at: null,
  last_activity_at: null,
  activity_state: "active",
  activity_label: "Active",
  foreground_command: "codex",
};

const host: HostOut = {
  id: session.host_id,
  name: "studio",
  os: "darwin",
  arch: "arm64",
  version: "1",
  host_key_algorithm: "ed25519",
  host_public_key: "host-public-key",
  host_key_fingerprint: "fingerprint",
  status: "online",
  last_seen_at: null,
  session_count: 1,
  cpu_cores: 8,
  cpu_physical_cores: 8,
  cpu_model: null,
  memory_bytes: null,
  gpu: null,
  cpu_bucket: null,
  mem_bucket: null,
  capacity_at: null,
};

interface OverlayOverrides {
  focused?: boolean;
  onDismiss?: () => void;
  onKill?: () => Promise<void>;
}

async function renderOverlay(overrides: boolean | OverlayOverrides = false) {
  const options: OverlayOverrides =
    typeof overrides === "boolean" ? { focused: overrides } : overrides;
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <ThemeProvider>
        <TerminalOverlay
          focused={options.focused ?? false}
          host={host}
          onDismiss={options.onDismiss ?? jest.fn()}
          onKill={options.onKill ?? jest.fn(async () => undefined)}
          onRename={jest.fn(async () => undefined)}
          onRestart={jest.fn(async () => undefined)}
          session={session}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe("terminal overlay dismissal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTerminalSurfaceProps = {};
  });

  test("keeps the header and terminal together in the native route's transformed scene", async () => {
    await renderOverlay();
    const routeScene = within(screen.getByTestId("terminal-overlay-route-scene"));
    expect(routeScene.getByTestId("mock-terminal-header")).toBeTruthy();
    expect(routeScene.getByTestId("terminal")).toBeTruthy();
    expect(screen.queryByTestId("terminal-full-surface-dismiss")).toBeNull();
    expect(screen.queryByTestId("swipe-dismiss-overlay")).toBeNull();
  });

  test("opens safe terminal links deliberately and rejects unsupported schemes", async () => {
    await renderOverlay();

    await act(() => mockTerminalSurfaceProps.onLink?.("https://example.com/docs"));
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledWith("https://example.com/docs");

    await act(() => mockTerminalSurfaceProps.onLink?.("javascript:alert(1)"));
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(mockSetNotice).toHaveBeenCalledWith("The terminal link uses an unsupported URL scheme.");
  });
});

describe("terminal overlay kill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHeaderProps = {};
  });

  test("leaves the terminal as soon as the kill is confirmed", async () => {
    const onDismiss = jest.fn();
    const onKill = jest.fn(async () => undefined);
    await renderOverlay({ onDismiss, onKill });

    await act(() => {
      mockHeaderProps.onKill?.();
    });
    await act(() => {
      fireEvent.press(screen.getByLabelText("Confirm kill"));
    });

    expect(onKill).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("leaves even when the kill never answers", async () => {
    const onDismiss = jest.fn();
    await renderOverlay({ onDismiss, onKill: () => new Promise<void>(() => undefined) });

    await act(() => {
      mockHeaderProps.onKill?.();
    });
    await act(() => {
      fireEvent.press(screen.getByLabelText("Confirm kill"));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("terminal overlay display control", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTerminalSurfaceProps = {};
  });

  test("stays silent while this viewer owns the grid", async () => {
    await renderOverlay();

    await act(() =>
      mockTerminalSurfaceProps.onDisplayChange?.({
        owner: true,
        viewers: 2,
        cols: 53,
        rows: 30,
      }),
    );

    expect(screen.queryByTestId("terminal-display-control")).toBeNull();
  });

  test("names the owner's grid and hands it back on request", async () => {
    await renderOverlay();

    await act(() =>
      mockTerminalSurfaceProps.onDisplayChange?.({
        owner: false,
        viewers: 2,
        cols: 120,
        rows: 40,
      }),
    );

    expect(screen.getByTestId("terminal-display-control")).toBeTruthy();
    expect(screen.getByText("Sized by another viewer · 120×40")).toBeTruthy();

    await act(() => {
      fireEvent.press(screen.getByTestId("terminal-take-control"));
    });
    expect(mockTakeControl).toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-display-control")).toBeNull();
  });
});

describe("terminal overlay agent launch", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockTerminalSurfaceProps = {};
    mockAccessoryBarProps = {};
    mockLaunchResult = null;
    mockKeyboard.visible = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("raises the keyboard once the launched agent command has gone out", async () => {
    await renderOverlay(true);
    await act(() => mockTerminalSurfaceProps.onTransport?.({ on: () => () => undefined }));

    await act(() => mockLaunchResult?.({ status: "sent" }));
    await act(async () => {
      jest.advanceTimersByTime(LAUNCH_FOCUS_DELAY_MS);
    });

    expect(mockFocus).toHaveBeenCalledTimes(1);
  });

  test("leaves a session that carried no launch alone", async () => {
    await renderOverlay(true);
    await act(() => mockTerminalSurfaceProps.onTransport?.({ on: () => () => undefined }));

    await act(() => mockLaunchResult?.({ status: "missing" }));
    await act(async () => {
      jest.advanceTimersByTime(LAUNCH_FOCUS_DELAY_MS * 4);
    });

    expect(mockFocus).not.toHaveBeenCalled();
  });
});

describe("terminal overlay keyboard hold", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockTerminalSurfaceProps = {};
    mockAccessoryBarProps = {};
    mockAttachSheetProps = {};
    mockKeyboard.visible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("stands the keyboard down under a drawer and puts it back on close", async () => {
    await renderOverlay();

    await act(() => mockAccessoryBarProps.onAttach?.());
    expect(screen.getByTestId("mock-attach-sheet")).toBeTruthy();
    expect(mockBlur).toHaveBeenCalledTimes(1);
    expect(mockFocus).not.toHaveBeenCalled();

    await act(() => mockAttachSheetProps.onDismiss?.());
    expect(screen.queryByTestId("mock-attach-sheet")).toBeNull();
    // The drawer is still animating out; the keyboard follows it, not the flag.
    expect(mockFocus).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(mockFocus).toHaveBeenCalled();
  });

  test("holds for the More drawer too, not just the attach one", async () => {
    await renderOverlay();

    await act(() => mockAccessoryBarProps.onMore?.());
    expect(mockBlur).toHaveBeenCalledTimes(1);
  });

  test("leaves a terminal the operator had left quiet alone", async () => {
    mockKeyboard.visible = false;
    await renderOverlay();

    await act(() => mockAccessoryBarProps.onAttach?.());
    await act(() => mockAttachSheetProps.onDismiss?.());
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });

    expect(mockBlur).not.toHaveBeenCalled();
    expect(mockFocus).not.toHaveBeenCalled();
  });
});

describe("terminal overlay agent keys", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPinnedCommandsCache();
  });

  test("hands the strip the keys pinned for whatever this session is running", async () => {
    // The fixture session is running Codex, so the strip is Codex's, not a shell's.
    expect(agentKindFor(session.foreground_command)).toBe("codex");
    await renderOverlay();

    const ids = mockAccessoryBarProps.commands?.map((command) => command.id) ?? [];
    expect(ids).toContain("key-BackTab");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(terminalCommandsFor("codex").map((command) => command.id)).toContain(id);
    }
  });

  test("sends a pressed key straight through to the surface", async () => {
    await renderOverlay();
    const [cycleMode] = resolvePinnedCommands("codex", ["key-BackTab"]);

    await act(() => mockAccessoryBarProps.onCommand?.(cycleMode as TerminalCommand));
    expect(mockSendKey).toHaveBeenCalledTimes(1);
    expect(mockSendKey).toHaveBeenCalledWith("\u001b[Z");
  });

  test("spaces a double press apart so the agent reads two of them", async () => {
    jest.useFakeTimers();
    try {
      await renderOverlay();
      const [rewind] = resolvePinnedCommands("codex", ["esc-esc"]);

      await act(() => mockAccessoryBarProps.onCommand?.(rewind as TerminalCommand));
      // Two escapes in one packet read as a single modified key, not as a rewind.
      expect(mockSendKey).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(REPEAT_PRESS_GAP_MS);
      });
      expect(mockSendKey).toHaveBeenCalledTimes(2);
      expect(mockSendKey).toHaveBeenNthCalledWith(2, "\u001b");
    } finally {
      jest.useRealTimers();
    }
  });
});
