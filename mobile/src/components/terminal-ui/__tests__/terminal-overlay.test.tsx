import { render, screen } from "@testing-library/react-native";

import { TerminalOverlay } from "@/components/terminal-ui/terminal-overlay";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { ThemeProvider } from "@/theme";

jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

jest.mock("@/components/ui/swipe-dismiss-overlay", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    SwipeDismissOverlay: ({
      children,
      dragHandleRegion,
    }: React.PropsWithChildren<{ dragHandleRegion?: string }>) =>
      React.createElement(
        View,
        { testID: "mock-swipe-overlay", accessibilityLabel: dragHandleRegion },
        children,
      ),
  };
});

jest.mock("@/components/terminal-ui/terminal-header", () => ({ TerminalHeader: () => null }));
jest.mock("@/components/terminal-ui/modifier-bar", () => ({ ModifierBar: () => null }));
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
jest.mock("@/components/terminal-ui/use-terminal-transfers", () => ({
  useTerminalTransfers: () => ({
    notice: null,
    setNotice: jest.fn(),
    progressRatio: null,
    paste: jest.fn(async () => undefined),
    uploadFile: jest.fn(async () => undefined),
  }),
}));
jest.mock("@/terminal/TerminalSurface", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    TerminalSurface: React.forwardRef(() => React.createElement(View, { testID: "terminal" })),
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

describe("terminal overlay dismissal", () => {
  test("only starts drag dismissal from the header region", async () => {
    await render(
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
      </ThemeProvider>,
    );
    expect(screen.getByTestId("mock-swipe-overlay")).toHaveProp("accessibilityLabel", "header");
  });
});
