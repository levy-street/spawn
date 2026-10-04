import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { AccessibilityInfo, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetParams = jest.fn();
let mockFocused = true;
const mockUseHostQuery = jest.fn();
const mockUseHostsQuery = jest.fn();
const mockUseHostSessionsQuery = jest.fn();
const mockUseHostIdentityConflictQuery = jest.fn();
const mockUseWorkspacesQuery = jest.fn();
const mockRemoveHost = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
    replace: mockReplace,
    setParams: mockSetParams,
  }),
}));

jest.mock("@react-navigation/native", () => ({
  useIsFocused: () => mockFocused,
}));

function mockQuery<T>(data: T) {
  return {
    data,
    error: null,
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: jest.fn(async () => undefined),
  };
}

jest.mock("@/data/queries/hosts", () => ({
  useAgentsQuery: () => mockQuery([]),
  useHostAgentsQuery: () => ({ ...mockQuery(undefined), isFetching: false }),
  useHostBrowserDevicesQuery: () => mockQuery([]),
  useHostIdentityConflictQuery: () => mockUseHostIdentityConflictQuery(),
  useHostPinsQuery: () => mockQuery(null),
  useHostQuery: () => mockUseHostQuery(),
  useHostSessionsQuery: () => mockUseHostSessionsQuery(),
  useHostsQuery: () => mockUseHostsQuery(),
  useRemoveHostMutation: () => ({ error: null, isPending: false, mutate: mockRemoveHost }),
  useRenameHostMutation: () => ({
    error: null,
    isPending: false,
    mutate: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock("@/data/queries/workspaces", () => ({
  useWorkspacesQuery: (archived?: boolean) => mockUseWorkspacesQuery(archived === true),
}));

/** The page's channel to the host, which a test opens by hand. */
jest.mock("@/terminal/HostTransportSurface", () => ({
  HostTransportSurface: jest.fn(() => null),
}));

/** The real file browser, with what the Files tab hands it on record. */
jest.mock("@/components/files/file-browser-body", () => {
  const actual = jest.requireActual<typeof import("@/components/files/file-browser-body")>(
    "@/components/files/file-browser-body",
  );
  const Body = actual.FileBrowserBody;
  return {
    ...actual,
    FileBrowserBody: jest.fn((props: React.ComponentProps<typeof Body>) => <Body {...props} />),
  };
});

/** The window sheet has its own tests; here only what it is asked to open matters. */
jest.mock("@/components/launcher/open-here-sheet", () => ({
  OpenHereSheet: jest.fn(() => null),
}));

jest.mock("@/components/hosts/host-update-dialog", () => ({
  HostUpdateDialog: () => null,
}));

jest.mock("@/components/hosts/rename-host-dialog", () => ({
  RenameHostDialog: () => null,
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn() }),
}));

/** Every action sheet drawn inline, so its rows can be pressed by name. */
jest.mock("@/components/ui/action-sheet", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    ActionSheet: ({
      actions,
      title,
      visible,
    }: {
      actions: { id: string; label: string; disabled?: boolean; onPress(): void }[];
      title?: string;
      visible: boolean;
    }) =>
      visible ? (
        <View testID={`sheet-${title ?? "untitled"}`}>
          {actions.map((action) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: action.disabled === true }}
              disabled={action.disabled === true}
              key={action.id}
              onPress={action.onPress}
            >
              <Text>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null,
  };
});

import {
  offlineHost,
  onlineHost,
  runningSession,
  windowsHost,
} from "@/components/hosts/__tests__/fixtures";
import type { CockpitTab } from "@/components/hosts/cockpit/cockpit-model";
import { HostCockpitScreen } from "@/components/hosts/cockpit/host-cockpit-screen";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { useConnectionStore } from "@/data/stores/connection";
import { resetHostCapabilities, useHostCapabilities } from "@/data/stores/host-capabilities";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../../tests/render";

const surface = jest.requireMock("@/terminal/HostTransportSurface") as {
  HostTransportSurface: jest.Mock;
};
const openHere = jest.requireMock("@/components/launcher/open-here-sheet") as {
  OpenHereSheet: jest.Mock;
};
const fileBrowser = jest.requireMock("@/components/files/file-browser-body") as {
  FileBrowserBody: jest.Mock;
};

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: React.PropsWithChildren): React.JSX.Element {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

const WORKSPACE: WorkspaceOut = {
  id: "88888888-8888-4888-8888-888888888888",
  name: "Native",
  host_id: null,
  cwd: null,
  layout: {
    version: 3,
    active_tab: "t",
    tabs: [
      {
        id: "t",
        name: "Tab",
        host_id: null,
        cwd: null,
        layout: {
          version: 3,
          tiles: [{ session_id: runningSession.id, x: 0, y: 0, w: 12, h: 12 }],
        },
      },
    ],
  },
  position: 0,
  icon: null,
  icon_source: null,
  archived_at: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

function fakeTransport(operations: string[]) {
  const request = jest.fn(async () => ({
    sample: {
      cpu_percent: 42,
      memory_used_bytes: 1,
      memory_total_bytes: 4,
      load_one: 0.5,
      uptime_seconds: 60,
    },
    spec: null,
  }));
  const transport = {
    hostId: onlineHost.id,
    state: "ready",
    capabilities: { operations },
    request,
  } as unknown as HostTransport;
  return { transport, request };
}

/** Open the page's channel to the host the way the surface reports it. */
async function openChannel(transport: HostTransport, state: TransportState = "ready") {
  const props = surface.HostTransportSurface.mock.calls.at(-1)?.[0] as {
    onTransport(transport: HostTransport): void;
    onStateChange(state: TransportState): void;
  };
  await act(async () => {
    props.onTransport(transport);
    props.onStateChange(state);
  });
}

function renderCockpit(tab: CockpitTab = "overview") {
  return render(<HostCockpitScreen hostId={onlineHost.id} tab={tab} />, { wrapper: Providers });
}

describe("host cockpit", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    for (const mock of [mockBack, mockPush, mockReplace, mockSetParams, mockRemoveHost]) {
      mock.mockClear();
    }
    surface.HostTransportSurface.mockClear();
    openHere.OpenHereSheet.mockClear();
    mockFocused = true;
    mockUseHostQuery.mockReturnValue(mockQuery(onlineHost));
    mockUseHostsQuery.mockReturnValue(mockQuery([onlineHost, offlineHost, windowsHost]));
    mockUseHostSessionsQuery.mockReturnValue(mockQuery([runningSession]));
    mockUseHostIdentityConflictQuery.mockReturnValue(mockQuery(false));
    mockUseWorkspacesQuery.mockImplementation((archived: boolean) =>
      mockQuery(archived ? [] : [WORKSPACE]),
    );
    useConnectionStore.getState().reset();
    resetHostCapabilities();
  });

  afterEach(() => jest.restoreAllMocks());

  test("names the host once, says it is reachable, and carries its actions", async () => {
    await renderCockpit();

    expect(screen.getByRole("header", { name: onlineHost.name })).toBeOnTheScreen();
    expect(screen.getAllByText(onlineHost.name)).toHaveLength(1);
    expect(screen.getByText("Online")).toBeOnTheScreen();
    for (const name of ["New window here…", "Switch host", "Host actions"]) {
      expect(screen.getByRole("button", { name })).toBeOnTheScreen();
    }
    expect(screen.getByRole("button", { name: "New window here…" })).toBeEnabled();
    for (const tab of ["Overview", "Files", "Sessions", "Access"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeOnTheScreen();
    }
  });

  test("a tab changes in place, so back still leaves the page", async () => {
    await renderCockpit();
    await fireEvent.press(screen.getByRole("tab", { name: "Sessions" }));
    expect(mockSetParams).toHaveBeenCalledWith({ tab: "sessions" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("each tab draws its own body", async () => {
    const view = await renderCockpit("overview");
    expect(screen.getByTestId("host-overview")).toBeOnTheScreen();
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="files" />);
    expect(screen.getByTestId("host-files-tab")).toBeOnTheScreen();
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="sessions" />);
    expect(screen.getByTestId("host-sessions-tab")).toBeOnTheScreen();
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="access" />);
    expect(screen.getByTestId("host-access-tab")).toBeOnTheScreen();
  });

  test("a window opens in its terminal, over the workspace it belongs to", async () => {
    await renderCockpit();
    await fireEvent.press(screen.getByRole("button", { name: /^native app/ }));
    expect(mockPush.mock.calls).toEqual([
      [{ pathname: "/workspace/[id]", params: { id: WORKSPACE.id } }],
      [`/terminal/${runningSession.id}`],
    ]);
  });

  test("a window in no workspace opens straight in its terminal", async () => {
    mockUseWorkspacesQuery.mockImplementation(() => mockQuery([]));
    await renderCockpit("sessions");
    await fireEvent.press(screen.getByRole("button", { name: /^native app/ }));
    expect(mockPush.mock.calls).toEqual([[`/terminal/${runningSession.id}`]]);
  });

  test("one channel while on screen: its hello is kept, and Overview asks it for figures", async () => {
    jest.useFakeTimers();
    try {
      const view = await renderCockpit("overview");
      expect(surface.HostTransportSurface).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hostId: onlineHost.id,
          hostIdentityPublicKey: onlineHost.host_public_key,
        }),
        undefined,
      );
      const { transport, request } = fakeTransport(["host.metrics", "screen.v1"]);
      await openChannel(transport);

      expect(request).toHaveBeenCalledWith("host.metrics", {});
      expect(await view.findByLabelText("CPU 42%")).toBeOnTheScreen();

      // Every three seconds while Overview is in front.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3_000);
      });
      expect(request).toHaveBeenCalledTimes(2);

      // What the host's hello said is kept for its page's registry.
      const capabilities = await render(<CapabilitiesProbe hostId={onlineHost.id} />);
      expect(capabilities.getByTestId("caps")).toHaveTextContent("host.metrics,screen.v1");
    } finally {
      jest.useRealTimers();
    }
  });

  test("another tab in front asks for no figures", async () => {
    await renderCockpit("sessions");
    const { transport, request } = fakeTransport(["host.metrics"]);
    await openChannel(transport);
    expect(request).not.toHaveBeenCalled();
  });

  test("a page pushed over, an offline host, or a changed identity holds no channel", async () => {
    mockFocused = false;
    const view = await renderCockpit();
    expect(surface.HostTransportSurface).not.toHaveBeenCalled();

    mockFocused = true;
    mockUseHostQuery.mockReturnValue(mockQuery(offlineHost));
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="overview" />);
    expect(surface.HostTransportSurface).not.toHaveBeenCalled();

    mockUseHostQuery.mockReturnValue(mockQuery(onlineHost));
    mockUseHostIdentityConflictQuery.mockReturnValue(mockQuery(true));
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="overview" />);
    expect(surface.HostTransportSurface).not.toHaveBeenCalled();
  });

  test("a changed identity sits above every tab, shuts the way in, and removes the host", async () => {
    mockUseHostIdentityConflictQuery.mockReturnValue(mockQuery(true));
    const view = await renderCockpit("sessions");

    expect(screen.getByTestId("host-identity-conflict")).toBeOnTheScreen();
    const newWindow = screen.getByRole("button", { name: "New window here…" });
    expect(newWindow).toBeDisabled();
    // A shut control says why, in the browser's words.
    expect(newWindow).toHaveProp(
      "accessibilityHint",
      "Connections to this host are blocked until it is removed and possessed again.",
    );
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="access" />);
    expect(screen.getByTestId("host-identity-conflict")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("conflict-remove-host"));
    expect(
      screen.getByText(
        "Its daemon token is revoked and SPAWN D stops connecting to it. Sessions already running there may keep running on that host.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
    expect(mockRemoveHost).toHaveBeenCalledWith(onlineHost, expect.any(Object));
  });

  test("a reconnecting host says so under the header and retries from there", async () => {
    const retry = jest.fn();
    useConnectionStore.setState({
      hostTransports: { [onlineHost.id]: "reconnecting" },
      hostsSeenReady: { [onlineHost.id]: true },
      hostRetries: { [onlineHost.id]: retry },
    });
    await renderCockpit();

    expect(screen.getByText("Reconnecting…")).toBeOnTheScreen();
    const line = screen.getByTestId("host-reconnect");
    expect(within(line).getByText(`Reconnecting to ${onlineHost.name}…`)).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole("button", { name: `Retry connection to ${onlineHost.name}` }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("an offline host says when it was last seen", async () => {
    mockUseHostQuery.mockReturnValue(mockQuery({ ...offlineHost, last_seen_at: null }));
    await renderCockpit();
    expect(screen.getByText("Offline · never connected")).toBeOnTheScreen();
    const newWindow = screen.getByRole("button", { name: "New window here…" });
    expect(newWindow).toBeDisabled();
    expect(newWindow).toHaveProp("accessibilityHint", `${offlineHost.name} is offline.`);
  });

  test("a host this device holds no key for still takes a window, but not a folder browse", async () => {
    mockUseHostQuery.mockReturnValue(mockQuery({ ...onlineHost, host_public_key: null }));
    await renderCockpit();

    const newWindow = screen.getByRole("button", { name: "New window here…" });
    expect(newWindow).toBeEnabled();
    expect(newWindow).not.toHaveProp("accessibilityHint", expect.anything());
    // The page's channel needs the key it verifies the host by.
    expect(surface.HostTransportSurface).not.toHaveBeenCalled();

    // A folder's menu opens a window there, but has no way into Files.
    await fireEvent.press(screen.getByRole("button", { name: "Actions for ~/dev/native" }));
    const sheet = screen.getByTestId("sheet-~/dev/native");
    expect(within(sheet).queryByText("Open in Files")).toBeNull();
    expect(within(sheet).getByText("Open a shell here")).toBeOnTheScreen();
    expect(within(sheet).getByText("Start an agent here…")).toBeOnTheScreen();
  });

  test("switching host keeps the tab", async () => {
    await renderCockpit("sessions");
    await fireEvent.press(screen.getByRole("button", { name: "Switch host" }));
    const sheet = screen.getByTestId("sheet-Switch host");
    expect(within(sheet).queryByText(onlineHost.name)).toBeNull();
    await fireEvent.press(within(sheet).getByText(windowsHost.name));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: "/host/[id]",
      params: { id: windowsHost.id, tab: "sessions" },
    });
  });

  test("the menu renames, updates and removes, the update working only when one is due", async () => {
    const view = await renderCockpit();
    await fireEvent.press(screen.getByRole("button", { name: "Host actions" }));
    let sheet = screen.getByTestId(`sheet-${onlineHost.name}`);
    expect(within(sheet).getByText("Rename")).toBeOnTheScreen();
    expect(within(sheet).getByText("Remove host")).toBeOnTheScreen();
    // Always listed, so the menu keeps one shape; shut on a current host.
    expect(within(sheet).getByRole("button", { name: "Update SPAWN D…" })).toBeDisabled();

    mockUseHostQuery.mockReturnValue(
      mockQuery({
        ...onlineHost,
        update: { state: "available", latest_version: "2.0.0", error: null, requested_at: null },
      }),
    );
    await view.rerender(<HostCockpitScreen hostId={onlineHost.id} tab="overview" />);
    sheet = screen.getByTestId(`sheet-${onlineHost.name}`);
    expect(within(sheet).getByRole("button", { name: "Update SPAWN D…" })).toBeEnabled();
  });

  test("New window here asks what, where and which workspace; a folder already knows where", async () => {
    await renderCockpit();
    const lastRequest = () => openHere.OpenHereSheet.mock.calls.at(-1)?.[0].request;
    expect(lastRequest()).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "New window here…" }));
    expect(lastRequest()).toEqual({ cwd: null });

    await fireEvent.press(screen.getByRole("button", { name: "Actions for ~/dev/native" }));
    const sheet = screen.getByTestId("sheet-~/dev/native");
    expect(within(sheet).getByText("Open in Files")).toBeOnTheScreen();
    await fireEvent.press(within(sheet).getByText("Open a shell here"));
    expect(lastRequest()).toEqual({ cwd: "/Users/spawn/dev/native", run: "shell" });

    await fireEvent.press(screen.getByRole("button", { name: "Actions for ~" }));
    await fireEvent.press(within(screen.getByTestId("sheet-~")).getByText("Start an agent here…"));
    expect(lastRequest()).toEqual({ cwd: "~", run: "agent" });
  });

  test("a window opened here lands in its workspace, in its terminal", async () => {
    await renderCockpit();
    const props = openHere.OpenHereSheet.mock.calls.at(-1)?.[0] as {
      onOpened(opened: { workspaceId: string; sessionId: string }): void;
    };
    await act(async () => props.onOpened({ workspaceId: "w-1", sessionId: "s-1" }));
    expect(mockPush.mock.calls).toEqual([
      [{ pathname: "/workspace/[id]", params: { id: "w-1" } }],
      ["/terminal/s-1"],
    ]);
  });

  test("Files is the browser itself at home; a folder in it opens as its own screen", async () => {
    fileBrowser.FileBrowserBody.mockClear();
    await renderCockpit("files");
    expect(screen.getByTestId("host-files-tab")).toBeOnTheScreen();
    const props = fileBrowser.FileBrowserBody.mock.calls.at(-1)?.[0] as {
      hostId: string;
      hostName: string;
      path?: string;
      onOpenFolder(navigation: { path: string; ancestor: boolean }): void;
    };
    expect(props).toMatchObject({ hostId: onlineHost.id, hostName: onlineHost.name });
    expect(props.path).toBeUndefined();
    await act(async () => props.onOpenFolder({ path: "/Users/spawn/dev/native", ancestor: false }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: "/host/[id]/files",
      params: { id: onlineHost.id, path: "/Users/spawn/dev/native" },
    });
  });

  test("Files opens no browser while the host's identity is in question", async () => {
    fileBrowser.FileBrowserBody.mockClear();
    mockUseHostIdentityConflictQuery.mockReturnValue(mockQuery(true));
    await renderCockpit("files");
    expect(screen.getByTestId("host-files-blocked")).toBeOnTheScreen();
    expect(fileBrowser.FileBrowserBody).not.toHaveBeenCalled();
  });

  test("a folder opens the file browser there; home opens it at home", async () => {
    await renderCockpit();
    await fireEvent.press(screen.getByRole("button", { name: /^~\/dev\/native/ }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: "/host/[id]/files",
      params: { id: onlineHost.id, path: "/Users/spawn/dev/native" },
    });
    await fireEvent.press(screen.getByRole("button", { name: /^~, Home/ }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: "/host/[id]/files",
      params: { id: onlineHost.id },
    });
  });
});

function CapabilitiesProbe({ hostId }: { hostId: string }): React.JSX.Element {
  const capabilities = useHostCapabilities(hostId);
  return <Text testID="caps">{(capabilities ?? []).join(",")}</Text>;
}
