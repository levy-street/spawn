import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { LaunchRequest, WidgetRequest } from "@/components/launcher/launch-orchestrator";
import { LauncherSheet } from "@/components/launcher/launcher-sheet";
import { ThemeProvider } from "@/theme";
import { makeAgent, makeHost, makeSession, makeTab, makeWorkspace } from "./fixtures";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const host = makeHost();
const agent = makeAgent({ name: "Codex" });
const launched = makeSession();

const mockLaunch = jest.fn(async (_request: LaunchRequest) => ({
  status: "launched" as const,
  session: launched,
  pendingCommand: true,
}));
const mockAddWidget = jest.fn(async (_request: WidgetRequest) => makeWorkspace());
let mockData: {
  hosts: ReturnType<typeof makeHost>[];
  agents: ReturnType<typeof makeAgent>[];
  workspace: ReturnType<typeof makeWorkspace> | undefined;
  sessions: ReturnType<typeof makeSession>[];
};

jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));

function mockHostUpdateDialog({ onNotNow, visible }: { onNotNow?(): void; visible: boolean }) {
  if (!visible) return null;
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return React.createElement(
    Pressable,
    { onPress: onNotNow, testID: "launcher-host-update-not-now" },
    React.createElement(Text, null, "Not now"),
  );
}

jest.mock("@/components/hosts/host-update-dialog", () => ({
  HostUpdateDialog: mockHostUpdateDialog,
}));

jest.mock("@/data/queries/launcher", () => ({
  useLauncherData: () => ({
    ...mockData,
    error: null,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  }),
  useLaunchSession: () => ({ isPending: false, mutateAsync: mockLaunch }),
  useAddFilesWidget: () => ({ isPending: false, mutateAsync: mockAddWidget }),
  useRecentDirectories: () => ({
    data: [],
    error: null,
    isLoading: false,
    refetch: jest.fn(async () => undefined),
  }),
  discardLaunchedSession: jest.fn(async () => undefined),
  keepLaunchedShell: jest.fn(async () => undefined),
}));

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** A workspace whose second tab already has a window, in ~/spawn on Ada's Mac. */
const neighbour = makeSession({ id: "30000000-0000-4000-8000-0000000000aa" });
function workspaceWithWindow() {
  return makeWorkspace({
    layout: {
      version: 3,
      active_tab: "tab-1",
      tabs: [
        makeTab(),
        makeTab({
          id: "tab-2",
          layout: { version: 3, tiles: [{ session_id: neighbour.id, x: 0, y: 0, w: 24, h: 24 }] },
        }),
      ],
    },
  });
}

async function renderSheet(overrides: Partial<Parameters<typeof LauncherSheet>[0]> = {}) {
  const onLaunched = jest.fn();
  const onDismiss = jest.fn();
  await render(
    <LauncherSheet
      initialTabId="tab-2"
      onDismiss={onDismiss}
      onLaunched={onLaunched}
      visible
      workspaceId={workspaceWithWindow().id}
      {...overrides}
    />,
    { wrapper: Providers },
  );
  return { onDismiss, onLaunched };
}

describe("adding a window", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockData = {
      hosts: [host],
      agents: [agent],
      workspace: workspaceWithWindow(),
      sessions: [
        neighbour,
        makeSession({
          id: "30000000-0000-4000-8000-0000000000bb",
          cwd: "/Users/ada/notes",
          last_activity_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:00:00Z",
        }),
      ],
    };
  });

  test("asks where after what, with the window beside this tab's first", async () => {
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId(`launcher-choice-${agent.id}`)));

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(screen.getByText(`Where should ${agent.name} run?`)).toBeTruthy();
    const suggested = screen.getByTestId("launcher-where-suggested");
    expect(screen.getByText("~/spawn")).toBeTruthy();
    expect(screen.getByText(`${host.name} · this tab`)).toBeTruthy();
    expect(screen.getByText("~/notes")).toBeTruthy();
    expect(screen.getByTestId("launcher-where-browse")).toBeTruthy();
    expect(suggested).toBeTruthy();
  });

  test("picking the suggested place launches there, in the tab it was opened from", async () => {
    const { onDismiss, onLaunched } = await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId(`launcher-choice-${agent.id}`)));
    await act(() => fireEvent.press(screen.getByTestId("launcher-where-suggested")));

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockLaunch.mock.calls[0]?.[0]).toEqual({
      workspaceId: workspaceWithWindow().id,
      // The tab the drawer was opened from, not the workspace's active one.
      tabId: "tab-2",
      hostId: host.id,
      cwd: "/Users/ada/spawn",
      agent,
    });
    expect(onLaunched).toHaveBeenCalledWith({ session: launched, pendingCommand: true });
    expect(onDismiss).toHaveBeenCalled();
  });

  test("adds a file explorer as layout at the chosen place, with no session to open", async () => {
    const { onLaunched } = await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-files")));
    await act(() => fireEvent.press(screen.getByTestId("launcher-where-suggested")));

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockAddWidget).toHaveBeenCalledWith({
      workspaceId: workspaceWithWindow().id,
      tabId: "tab-2",
      hostId: host.id,
      path: "/Users/ada/spawn",
    });
    expect(onLaunched).toHaveBeenCalledWith({ session: null, pendingCommand: false });
  });

  test("pauses an outdated host launch and lets Not now proceed", async () => {
    const outdated = makeHost({
      update: { state: "available", latest_version: "2", error: null, requested_at: null },
    });
    mockData.hosts = [outdated];
    await renderSheet();

    await fireEvent.press(screen.getByTestId("launcher-choice-shell"));
    await fireEvent.press(screen.getByTestId("launcher-where-suggested"));
    expect(mockLaunch).not.toHaveBeenCalled();

    await act(() => fireEvent.press(screen.getByTestId("launcher-host-update-not-now")));
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: outdated.id, cwd: "/Users/ada/spawn" }),
    );
  });

  test("a workspace with no windows yet still offers each host's home", async () => {
    mockData.workspace = makeWorkspace();
    mockData.sessions = [];
    await renderSheet({ initialTabId: "tab-1" });

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-shell")));

    expect(screen.getByText("~")).toBeTruthy();
    expect(screen.getByText(`${host.name} · home`)).toBeTruthy();
  });

  test("choosing a folder browses one host directly, and asks which with several", async () => {
    await renderSheet();
    await act(() => fireEvent.press(screen.getByTestId(`launcher-choice-${agent.id}`)));
    await act(() => fireEvent.press(screen.getByTestId("launcher-where-browse")));
    expect(screen.getByText(`Folder for ${agent.name}`)).toBeTruthy();
    expect(screen.queryByText("Choose a host")).toBeNull();
  });

  test("with several hosts, choosing a folder asks which machine first", async () => {
    mockData.hosts = [host, makeHost({ id: "20000000-0000-4000-8000-000000000002", name: "hub" })];
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-shell")));
    await act(() => fireEvent.press(screen.getByTestId("launcher-where-browse")));

    expect(screen.getByText("Choose a host")).toBeTruthy();
  });
});
