import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));

/** The file browser has its own tests; here only how the Files tab embeds it matters. */
jest.mock("@/components/files/file-browser-body", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return { FileBrowserBody: jest.fn(() => <View testID="file-browser-body" />) };
});

import { FileBrowserBody } from "@/components/files/file-browser-body";
import {
  codexAgent,
  offlineHost,
  onlineHost,
  runningSession,
  windowsHost,
} from "@/components/hosts/__tests__/fixtures";
import { AccessTab } from "@/components/hosts/cockpit/access-tab";
import { FilesTab } from "@/components/hosts/cockpit/files-tab";
import { OverviewTab, type OverviewTabProps } from "@/components/hosts/cockpit/overview-tab";
import { SessionsTab } from "@/components/hosts/cockpit/sessions-tab";
import { HostIdentityConflict } from "@/components/hosts/host-identity-conflict";
import type { HostMetrics } from "@/components/hosts/host-model";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { deriveHostOffers } from "@/data/selectors/host-offers";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../../tests/render";

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

function overview(overrides: Partial<OverviewTabProps> = {}): React.JSX.Element {
  return (
    <OverviewTab
      agents={[codexAgent]}
      host={onlineHost}
      identityConflict={false}
      metrics={null}
      metricsUnavailable={false}
      offers={deriveHostOffers(null)}
      onFolderActions={jest.fn()}
      onOpenAllSessions={jest.fn()}
      onOpenFolder={jest.fn()}
      onOpenSession={jest.fn()}
      onOpenUpdate={jest.fn()}
      onRefresh={jest.fn()}
      refreshing={false}
      sessions={[runningSession]}
      {...overrides}
    />
  );
}

const SAMPLE: HostMetrics = {
  sample: {
    cpu_percent: 23,
    memory_used_bytes: 12_884_901_888,
    memory_total_bytes: 34_359_738_368,
    load_one: 1.4,
    uptime_seconds: 6 * 24 * 3600,
  },
  spec: {
    cpu_cores: 16,
    cpu_physical_cores: 12,
    cpu_model: "Apple M5 Max",
    memory_bytes: 34_359_738_368,
    gpu: null,
  },
};

describe("host cockpit tabs", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test("Overview shows the machine, what runs on it and its folders", async () => {
    const onOpenSession = jest.fn();
    const onOpenAllSessions = jest.fn();
    await render(overview({ onOpenSession, onOpenAllSessions }), { wrapper: Providers });

    for (const value of [
      "macOS · ARM64",
      "Apple M4 Pro",
      "10 cores · 12 threads",
      "24 GiB",
      "1.4.2",
      "native app",
      "Codex · ~/dev/native",
      "Awaiting input",
      "~/dev/native",
      "1 window here",
      "~",
    ]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    // Nothing here a daemon cannot do, and nothing the server would run.
    expect(screen.queryByText(/restart daemon/i)).toBeNull();
    expect(screen.queryByText(/daemon logs/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Check agents" })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: /^native app/ }));
    expect(onOpenSession).toHaveBeenCalledWith(runningSession);
    await fireEvent.press(screen.getByRole("button", { name: "All sessions" }));
    expect(onOpenAllSessions).toHaveBeenCalledTimes(1);
  });

  test("Overview reads exact figures while they come, and the heartbeat's otherwise", async () => {
    const view = await render(overview(), { wrapper: Providers });
    expect(screen.getByTestId("bucketed-capacity")).toBeOnTheScreen();
    expect(screen.queryByTestId("exact-capacity")).toBeNull();

    expect(screen.queryByText("live")).toBeNull();

    await view.rerender(overview({ metrics: SAMPLE }));
    expect(screen.getByLabelText("CPU 23%")).toBeOnTheScreen();
    // The browser's figures, each named: Memory, Load and Up.
    expect(screen.getByLabelText("Memory 12 GiB of 32 GiB")).toBeOnTheScreen();
    // Read whole on a small phone: no line limit to cut it short, and it can
    // only wrap between its two amounts.
    const memory = screen.getByTestId("host-figure-memory");
    expect(memory.props["children"]).toBe("12\u00a0GiB of 32\u00a0GiB");
    expect(memory.props["numberOfLines"]).toBeUndefined();
    expect(screen.getByLabelText("Load 1.40")).toBeOnTheScreen();
    expect(screen.getByLabelText("Up 6d 0h")).toBeOnTheScreen();
    expect(screen.getByText("live")).toBeOnTheScreen();
    // The spec the host just sent is preferred to the one it registered with.
    expect(screen.getByText("Apple M5 Max")).toBeOnTheScreen();
    expect(screen.getByText("12 cores · 16 threads")).toBeOnTheScreen();

    await view.rerender(
      overview({
        host: { ...onlineHost, cpu_bucket: null, mem_bucket: null },
        metricsUnavailable: true,
      }),
    );
    expect(screen.getByText("This host does not report live capacity.")).toBeOnTheScreen();
    expect(screen.queryByText(/^Live figures appear here/)).toBeNull();
  });

  test("with nothing known yet, Right now says what its figures wait on", async () => {
    await render(overview({ host: { ...onlineHost, cpu_bucket: null, mem_bucket: null } }), {
      wrapper: Providers,
    });
    expect(screen.getByTestId("host-right-now")).toBeOnTheScreen();
    expect(
      screen.getByText(`Live figures appear here while SPAWN D can reach ${onlineHost.name}.`),
    ).toBeOnTheScreen();
  });

  test("an offline host gets its mini-doctor and no live figures", async () => {
    await render(overview({ host: { ...offlineHost, last_seen_at: null }, sessions: [] }), {
      wrapper: Providers,
    });
    expect(screen.getByText("Something wrong?")).toBeOnTheScreen();
    expect(screen.getByTestId("host-doctor-never-connected")).toBeOnTheScreen();
    expect(screen.queryByTestId("host-right-now")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Copy spawnd doctor" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("spawnd doctor");
    expect(screen.getByText("Nothing is running here.")).toBeOnTheScreen();
    // Sessions lists ended windows too, so the way there stays.
    expect(screen.getByRole("button", { name: "All sessions" })).toBeOnTheScreen();
  });

  test("a folder opens in Files, and its menu opens a window there", async () => {
    const onOpenFolder = jest.fn();
    const onFolderActions = jest.fn();
    await render(overview({ onOpenFolder, onFolderActions }), { wrapper: Providers });

    await fireEvent.press(screen.getByRole("button", { name: /^~\/dev\/native/ }));
    expect(onOpenFolder).toHaveBeenCalledWith("/Users/spawn/dev/native");
    await fireEvent.press(screen.getByRole("button", { name: "Actions for ~" }));
    expect(onFolderActions).toHaveBeenCalledWith("~");
  });

  test("while the identity is in question no folder opens, and each says why", async () => {
    const onOpenFolder = jest.fn();
    const onFolderActions = jest.fn();
    await render(overview({ identityConflict: true, onFolderActions, onOpenFolder }), {
      wrapper: Providers,
    });
    const reason = "Connections to this host are blocked until it is removed and possessed again.";
    expect(screen.getAllByText(reason).length).toBe(2);
    for (const menu of screen.getAllByRole("button", { name: /Actions for/ })) {
      expect(menu).toBeDisabled();
      expect(menu).toHaveProp("accessibilityHint", reason);
    }
    await fireEvent.press(screen.getByText("~/dev/native"));
    expect(onOpenFolder).not.toHaveBeenCalled();
    expect(onFolderActions).not.toHaveBeenCalled();
  });

  test("an offline host's folders neither browse nor open a window, and say why", async () => {
    const onOpenFolder = jest.fn();
    await render(overview({ host: offlineHost, onOpenFolder }), { wrapper: Providers });
    const menu = screen.getByRole("button", { name: "Actions for ~" });
    expect(menu).toBeDisabled();
    expect(menu).toHaveProp("accessibilityHint", `${offlineHost.name} is offline.`);
  });

  test("the machine says Windows the same way, and an update can be opened from it", async () => {
    const onOpenUpdate = jest.fn();
    await render(
      overview({
        host: {
          ...windowsHost,
          update: { state: "available", latest_version: "2.0.0", error: null, requested_at: null },
        },
        onOpenUpdate,
      }),
      { wrapper: Providers },
    );
    expect(screen.getByText("Windows · x64")).toBeOnTheScreen();
    // Named as the CPU and MEM gauges above them are, in the browser's order.
    expect(screen.queryByText("Processor")).toBeNull();
    expect(screen.queryByText("Graphics")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "update available" }));
    expect(onOpenUpdate).toHaveBeenCalledTimes(1);
  });

  test("the machine reads in the browser's order and words", async () => {
    await render(overview(), { wrapper: Providers });
    const facts = screen.getByTestId("host-machine-facts");
    const labels = within(facts)
      .getAllByText(/^(System|CPU|Cores|Memory|GPU|SPAWN D)$/)
      .map((node) => node.props["children"]);
    expect(labels).toEqual(["System", "CPU", "Cores", "Memory", "GPU", "SPAWN D"]);
  });

  test("a newer server's possession date is shown; an older one's absence is not missed", async () => {
    const view = await render(
      overview({ host: { ...onlineHost, created_at: "2026-03-14T12:00:00Z" } }),
      {
        wrapper: Providers,
      },
    );
    // One line, "Possessed March 14, 2026" in the device's own date format.
    expect(screen.getByText(/^Possessed \S.*2026$/)).toBeOnTheScreen();
    await view.rerender(overview());
    expect(screen.queryByText(/^Possessed/)).toBeNull();
  });

  test("Files is the file browser itself, at home; a folder opens as its own screen", async () => {
    const body = jest.mocked(FileBrowserBody);
    body.mockClear();
    const onOpenFiles = jest.fn();
    await render(
      <FilesTab
        host={onlineHost}
        identityConflict={false}
        onOpenFiles={onOpenFiles}
        onRefresh={jest.fn()}
        refreshing={false}
      />,
      { wrapper: Providers },
    );
    expect(screen.getByTestId("file-browser-body")).toBeOnTheScreen();
    // No interim list of ways in: the browser is the tab.
    expect(screen.queryByText("Browse files")).toBeNull();
    expect(screen.queryByText("Where your agents work")).toBeNull();
    const props = body.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      hostId: onlineHost.id,
      hostIdentityPublicKey: onlineHost.host_public_key,
      hostName: onlineHost.name,
      hostOS: onlineHost.os,
    });
    // Home: the embedded browser is given no folder of its own.
    expect(props?.path).toBeUndefined();
    props?.onOpenFolder({ path: "/Users/spawn/dev/native", ancestor: false });
    expect(onOpenFiles).toHaveBeenLastCalledWith("/Users/spawn/dev/native");
  });

  test.each<[string, HostOut, boolean, string, string]>([
    [
      "a changed identity",
      onlineHost,
      true,
      "Files are blocked",
      "Connections to this host are blocked until it is removed and possessed again.",
    ],
    [
      "an offline host",
      offlineHost,
      false,
      `${offlineHost.name} is offline`,
      "File browsing needs a live, direct connection to this host.",
    ],
    [
      "a host without a key",
      { ...onlineHost, host_public_key: null },
      false,
      "Host identity unavailable",
      "Reconnect this host to establish its trusted identity before browsing files.",
    ],
  ])("Files stays shut for %s and says why", async (_case, host, conflict, title, reason) => {
    const body = jest.mocked(FileBrowserBody);
    body.mockClear();
    const onOpenFiles = jest.fn();
    await render(
      <FilesTab
        host={host}
        identityConflict={conflict}
        onOpenFiles={onOpenFiles}
        onRefresh={jest.fn()}
        refreshing={false}
      />,
      { wrapper: Providers },
    );
    const blocked = screen.getByTestId("host-files-blocked");
    expect(within(blocked).getByText(title)).toBeOnTheScreen();
    expect(within(blocked).getByText(reason)).toBeOnTheScreen();
    // The browser is never mounted, so no channel to the host is opened.
    expect(screen.queryByTestId("file-browser-body")).toBeNull();
    expect(body).not.toHaveBeenCalled();
    expect(onOpenFiles).not.toHaveBeenCalled();
  });

  test("Sessions groups the host's windows under their workspaces", async () => {
    const onOpenSession = jest.fn();
    const inWorkspace = { ...runningSession, id: "55555555-5555-4555-8555-555555555555" };
    const workspace: WorkspaceOut = {
      id: "66666666-6666-4666-8666-666666666666",
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
            layout: { version: 3, tiles: [{ session_id: inWorkspace.id, x: 0, y: 0, w: 1, h: 1 }] },
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
    await render(
      <SessionsTab
        agents={[codexAgent]}
        hostName={onlineHost.name}
        onOpenSession={onOpenSession}
        onRefresh={jest.fn()}
        refreshing={false}
        sessions={[runningSession, inWorkspace]}
        workspaces={[workspace]}
      />,
      { wrapper: Providers },
    );
    expect(screen.getByRole("header", { name: "Native" })).toBeOnTheScreen();
    expect(screen.getByRole("header", { name: "Not in a workspace" })).toBeOnTheScreen();
    const group = screen.getByTestId(`host-sessions-group-${workspace.id}`);
    expect(within(group).getByText("1")).toBeOnTheScreen();
    await fireEvent.press(screen.getAllByRole("button", { name: /^native app/ })[0] as never);
    expect(onOpenSession).toHaveBeenCalledWith(inWorkspace);
  });

  test("an empty host says nothing runs there, and what the tab would list", async () => {
    await render(
      <SessionsTab
        agents={[]}
        hostName={onlineHost.name}
        onOpenSession={jest.fn()}
        onRefresh={jest.fn()}
        refreshing={false}
        sessions={[]}
        workspaces={[]}
      />,
      { wrapper: Providers },
    );
    expect(screen.getByText(`Nothing runs on ${onlineHost.name}.`)).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Windows opened on this host are listed here, under the workspace they are in.",
      ),
    ).toBeOnTheScreen();
  });

  test("Access shows the identity, the approving devices and where to manage them", async () => {
    const onManageDevices = jest.fn();
    await render(
      <AccessTab
        browserDevices={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            key_algorithm: "ed25519",
            public_key: "phone-key",
            label: "Work phone",
            created_at: "2026-08-01T00:00:00Z",
            revoked_at: null,
          },
        ]}
        host={onlineHost}
        hostPins={{
          data: {
            capacity: { used: 3, max: 32 },
            pins: [
              {
                browser_device_id: "11111111-1111-4111-8111-111111111111",
                delivered: true,
                undelivered_reason: null,
              },
            ],
          },
          error: null,
          isPending: false,
          retry: jest.fn(),
        }}
        onManageDevices={onManageDevices}
        onRefresh={jest.fn()}
        refreshing={false}
      />,
      { wrapper: Providers },
    );
    for (const value of [
      "ed25519",
      "SHA256:pm9SJXQwKoWeB-v_",
      "Approving devices · 3 of 32",
      "Work phone",
    ]) {
      expect(screen.getByText(value)).toBeOnTheScreen();
    }
    // The algorithm and the fingerprint derived here; the raw key is noise.
    expect(screen.queryByText("Public key")).toBeNull();
    expect(screen.queryByText("XOCTsSKj9-Z7qRynE70szG_DNBeHiLzEBOCG1clQbz8")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: /^Manage devices/ }));
    expect(onManageDevices).toHaveBeenCalledTimes(1);
  });

  test("the identity-conflict panel explains the fork and offers removal as its only exit", async () => {
    const onRemove = jest.fn();
    await render(<HostIdentityConflict onRemove={onRemove} />, { wrapper: Providers });

    const panel = screen.getByTestId("host-identity-conflict");
    expect(panel).toHaveProp("accessibilityRole", "alert");
    expect(
      screen.getByText("This host's identity changed — connections are blocked"),
    ).toBeOnTheScreen();
    // The browser's words, so a reinstall reads the same on every device.
    expect(
      screen.getByText(
        "This host answered with a different identity than the one this device approved. Either the host's software was reinstalled — a reinstall gives it a new identity — or something between you and the host is impersonating it. This device won't connect either way.",
      ),
    ).toBeOnTheScreen();
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
    expect(within(panel).queryByText(/trust|accept/i)).toBeNull();
    await fireEvent.press(screen.getByTestId("conflict-remove-host"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
