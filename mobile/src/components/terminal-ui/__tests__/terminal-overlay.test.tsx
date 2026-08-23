import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import * as Linking from "expo-linking";
import { SafeAreaProvider } from "react-native-safe-area-context";

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

jest.mock("@/components/terminal-ui/terminal-header", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalHeader: () => React.createElement(View, { testID: "mock-terminal-header" }),
  };
});
let mockAccessoryBarProps: { onAttach?: () => void; onMore?: () => void } = {};

jest.mock("@/components/terminal-ui/accessory-bar", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalAccessoryBar: (props: { onAttach?: () => void; onMore?: () => void }) => {
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
jest.mock("@/components/terminal-ui/font-size-sheet", () => ({ FontSizeSheet: () => null }));
jest.mock("@/components/terminal-ui/diagnostics-sheet", () => ({ DiagnosticsSheet: () => null }));
jest.mock("@/components/terminal-ui/selection-toolbar", () => ({ SelectionToolbar: () => null }));
jest.mock("@/components/terminal-ui/upload-progress-bar", () => ({
  UploadProgressBar: () => null,
}));
jest.mock("@/components/terminal-ui/connection-status", () => ({
  ConnectionStateOverlay: () => null,
}));
jest.mock("@/components/ui/confirm", () => ({ Confirm: () => null }));
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
}

let mockTerminalSurfaceProps: MockSurfaceProps = {};
const mockTakeControl = jest.fn();
const mockBlur = jest.fn();
const mockFocus = jest.fn();

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
          takeControl: () => void;
        }>,
      ) => {
        mockTerminalSurfaceProps = props;
        React.useImperativeHandle(ref, () => ({
          blur: mockBlur,
          focus: mockFocus,
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

async function renderOverlay() {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <ThemeProvider>
        <TerminalOverlay
          focused={false}
          host={host}
          onDismiss={jest.fn()}
          onKill={jest.fn(async () => undefined)}
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
