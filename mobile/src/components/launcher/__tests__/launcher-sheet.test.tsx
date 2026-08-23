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
};

jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));

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

function homedWorkspace() {
  return makeWorkspace({
    host_id: host.id,
    cwd: "/Users/ada/spawn",
    layout: { version: 3, active_tab: "tab-1", tabs: [makeTab(), makeTab({ id: "tab-2" })] },
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
      workspaceId={homedWorkspace().id}
      {...overrides}
    />,
    { wrapper: Providers },
  );
  return { onDismiss, onLaunched };
}

describe("adding a window", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockData = { hosts: [host], agents: [agent], workspace: homedWorkspace() };
  });

  test("picking an agent is the whole flow: it lands at home, in the tab it was opened from", async () => {
    const { onDismiss, onLaunched } = await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId(`launcher-choice-${agent.id}`)));

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockLaunch.mock.calls[0]?.[0]).toEqual({
      workspaceId: homedWorkspace().id,
      // The tab the drawer was opened from, not the workspace's active one.
      tabId: "tab-2",
      hostId: host.id,
      cwd: "/Users/ada/spawn",
      agent,
    });
    expect(onLaunched).toHaveBeenCalledWith({ session: launched, pendingCommand: true });
    expect(onDismiss).toHaveBeenCalled();
  });

  test("prefers the tab's own home over the workspace's", async () => {
    mockData.workspace = makeWorkspace({
      host_id: host.id,
      cwd: "/Users/ada/spawn",
      layout: {
        version: 3,
        active_tab: "tab-1",
        tabs: [makeTab(), makeTab({ id: "tab-2", host_id: host.id, cwd: "/Users/ada/notes" })],
      },
    });
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-shell")));

    expect(mockLaunch.mock.calls[0]?.[0]).toMatchObject({ cwd: "/Users/ada/notes" });
  });

  test("adds a file explorer as layout, with no session to open afterwards", async () => {
    const { onLaunched } = await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-files")));

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockAddWidget).toHaveBeenCalledWith({
      workspaceId: homedWorkspace().id,
      tabId: "tab-2",
      hostId: host.id,
      path: "/Users/ada/spawn",
    });
    expect(onLaunched).toHaveBeenCalledWith({ session: null, pendingCommand: false });
  });

  test("says where the one tap will land, and offers the way out of it", async () => {
    await renderSheet();

    expect(screen.getByText(`Opens in spawn on ${host.name}`)).toBeTruthy();
    expect(screen.getByTestId("launcher-choice-elsewhere")).toBeTruthy();
  });

  test("'somewhere else' re-points the menu rather than launching anything", async () => {
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-elsewhere")));

    // One host, so it goes straight to the folder browser, and asks for a
    // folder rather than for one to put a particular thing in.
    expect(screen.getByText("Choose a folder")).toBeTruthy();
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  test("asks for a folder instead of launching when the workspace has no home", async () => {
    mockData.workspace = makeWorkspace();
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId(`launcher-choice-${agent.id}`)));

    expect(mockLaunch).not.toHaveBeenCalled();
    // One host: the folder browser answers where, with no host menu in between.
    expect(screen.getByText(`Folder for ${agent.name}`)).toBeTruthy();
    expect(screen.queryByText("Choose a host")).toBeNull();
    expect(screen.queryByTestId("launcher-choice-elsewhere")).toBeNull();
  });

  test("asks which machine first when there is more than one and no home to assume", async () => {
    mockData.workspace = makeWorkspace();
    mockData.hosts = [host, makeHost({ id: "20000000-0000-4000-8000-000000000002", name: "hub" })];
    await renderSheet();

    await act(() => fireEvent.press(screen.getByTestId("launcher-choice-shell")));

    expect(screen.getByText("Choose a host")).toBeTruthy();
  });
});
