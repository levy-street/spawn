import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, View } from "react-native";
import {
  codexAgent,
  offlineHost,
  onlineHost,
  runningSession,
  windowsHost,
} from "@/components/hosts/__tests__/fixtures";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import { HostCard } from "@/components/hosts/host-card";
import type { LiveCapacityProbeProps } from "@/components/hosts/live-capacity-probe";
import { fleetRollup } from "@/data/selectors/host";
import { useConnectionStore } from "@/data/stores/connection";
import { ThemeProvider } from "@/theme";

const mockLiveCapacityProbe = jest.fn((_props: LiveCapacityProbeProps) => null);

jest.mock("@/components/hosts/live-capacity-probe", () => ({
  LiveCapacityProbe: (props: LiveCapacityProbeProps) => mockLiveCapacityProbe(props),
}));

function lastProbe(): LiveCapacityProbeProps {
  const call = mockLiveCapacityProbe.mock.calls.at(-1);
  if (!call) throw new Error("the card rendered no capacity probe");
  return call[0];
}

const LIVE_SAMPLE = {
  sample: {
    cpu_percent: 23.4,
    memory_used_bytes: 4_294_967_296,
    memory_total_bytes: 8_589_934_592,
    load_one: 1.4,
    uptime_seconds: 90_000,
  },
  spec: null,
};

async function renderCard(props: Partial<React.ComponentProps<typeof HostCard>> = {}) {
  return render(
    <ThemeProvider>
      <HostCard
        agents={[codexAgent]}
        host={onlineHost}
        onOpen={jest.fn()}
        onOpenActions={jest.fn()}
        sessions={[runningSession]}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe("host card", () => {
  beforeEach(() => {
    mockLiveCapacityProbe.mockClear();
    useConnectionStore.getState().reset();
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test("derives the fleet totals through the shared selector", () => {
    expect(fleetRollup([onlineHost, offlineHost], [runningSession], [codexAgent])).toMatchObject({
      hosts: 2,
      onlineHosts: 1,
      offlineHosts: 1,
      liveSessions: 1,
      runningAgents: 1,
      attention: 1,
    });
  });

  test("labels coarse capacity with segment words, never percentages", async () => {
    await render(
      <ThemeProvider>
        <View>
          <CapacityMeter capacity={{ source: "bucketed", cpuSegments: 3, memorySegments: 2 }} />
        </View>
      </ThemeProvider>,
    );
    expect(screen.getByTestId("bucketed-capacity")).toBeOnTheScreen();
    expect(screen.getByText("Busy")).toBeOnTheScreen();
    expect(screen.getByText("Working")).toBeOnTheScreen();
    expect(screen.queryByText(/%/)).not.toBeOnTheScreen();
  });

  test("renders exact percentages only for direct metrics", async () => {
    await render(
      <ThemeProvider>
        <View>
          <CapacityMeter
            capacity={{
              source: "exact",
              cpuPercent: 47.4,
              memoryPercent: 50,
              memoryUsedBytes: 4_294_967_296,
              memoryTotalBytes: 8_589_934_592,
              loadOne: 1.25,
              uptimeSeconds: 90_000,
            }}
          />
        </View>
      </ThemeProvider>,
    );
    expect(screen.getByTestId("exact-capacity")).toBeOnTheScreen();
    expect(screen.getByText("47%")).toBeOnTheScreen();
    expect(screen.getByText("50%")).toBeOnTheScreen();
  });

  test("shows what the host is, what it has to give, and what runs on it", async () => {
    await renderCard();

    expect(screen.getByText("office-mac")).toBeOnTheScreen();
    expect(screen.getByText(/online · heartbeat [\s\S]*12 cores · 24 GiB/)).toBeOnTheScreen();
    expect(screen.getByTestId("bucketed-capacity")).toBeOnTheScreen();
    expect(screen.getByText("Codex")).toBeOnTheScreen();
    // A session waiting on a person is the workspace's to say, not the host's.
    expect(screen.queryByText(/need you/)).toBeNull();
  });

  test("marks hosts whose daemon is updating", async () => {
    await renderCard({
      host: {
        ...onlineHost,
        update: {
          state: "updating",
          latest_version: "2.0.0",
          error: null,
          requested_at: "2026-08-25T00:00:00Z",
        },
      },
      sessions: [],
    });
    expect(screen.getByText("updating")).toBeOnTheScreen();
  });

  test("keeps a Windows host on the same generic card", async () => {
    const onOpen = jest.fn();
    await renderCard({ host: windowsHost, onOpen, sessions: [] });

    await fireEvent.press(screen.getByRole("button", { name: /^studio-pc, online/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a reconnecting host says so on its card and retries from there", async () => {
    const retry = jest.fn();
    const connections = useConnectionStore.getState();
    connections.setHostTransport(onlineHost.id, "ready");
    connections.setHostTransport(onlineHost.id, "connecting");
    connections.setHostRetry(onlineHost.id, retry);
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const onOpen = jest.fn();

    await renderCard({ onOpen });

    // The dot is this device's reading, not the server's: warning, and pulsing.
    expect(
      screen.getByTestId(`host-status-${onlineHost.id}`, { includeHiddenElements: true }),
    ).toHaveProp("accessibilityLabel", "Reconnecting to office-mac…");
    expect(
      screen.getByTestId(`host-status-${onlineHost.id}-pulse`, { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    expect(screen.getByText("Reconnecting to office-mac…")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Retry connection to office-mac" }));

    expect(retry).toHaveBeenCalledTimes(1);
    // Retry sits beside the card's press target, so it never also opens the host.
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("names the connection problem when there is one", async () => {
    const retry = jest.fn();
    const connections = useConnectionStore.getState();
    connections.setHostProblem(onlineHost.id, "This device is not approved for office-mac yet.");
    connections.setHostRetry(onlineHost.id, retry);

    await renderCard();

    expect(screen.getByText("This device is not approved for office-mac yet.")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Retry connection to office-mac" }),
    ).toBeOnTheScreen();
  });

  test("a connected host shows no reconnect line and no Retry", async () => {
    useConnectionStore.getState().setHostTransport(onlineHost.id, "ready");

    await renderCard();

    expect(screen.queryByTestId(`host-reconnect-${onlineHost.id}`)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
    expect(
      screen.getByTestId(`host-status-${onlineHost.id}`, { includeHiddenElements: true }),
    ).toHaveProp("accessibilityLabel", "Connected to office-mac");
  });

  test("asks for exact figures only while the card is live, and shows them when they come", async () => {
    await renderCard({ liveCapacity: false });
    expect(lastProbe()).toMatchObject({ enabled: false, hostId: onlineHost.id });

    await screen.rerender(
      <ThemeProvider>
        <HostCard
          agents={[codexAgent]}
          host={onlineHost}
          liveCapacity
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          sessions={[runningSession]}
        />
      </ThemeProvider>,
    );
    expect(lastProbe()).toMatchObject({ enabled: true, hostId: onlineHost.id });

    await act(async () => {
      lastProbe().onStateChange("ready");
      lastProbe().onMetrics(LIVE_SAMPLE);
    });

    // One line, the same height as the coarse reading it replaces.
    expect(screen.getByTestId("exact-capacity")).toBeOnTheScreen();
    expect(screen.getByText("23%")).toBeOnTheScreen();
    expect(screen.getByText("50%")).toBeOnTheScreen();
    expect(screen.queryByText(/uptime/)).toBeNull();
    expect(screen.getByRole("button", { name: /CPU 23%, memory 50%/ })).toBeOnTheScreen();

    // Scrolled away (or the tab left): back to the heartbeat's reading.
    await screen.rerender(
      <ThemeProvider>
        <HostCard
          agents={[codexAgent]}
          host={onlineHost}
          liveCapacity={false}
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          sessions={[runningSession]}
        />
      </ThemeProvider>,
    );
    expect(lastProbe()).toMatchObject({ enabled: false });
    expect(screen.getByTestId("bucketed-capacity")).toBeOnTheScreen();
  });

  test("never opens a channel to an offline host or one without a key", async () => {
    await renderCard({ host: offlineHost, liveCapacity: true, sessions: [] });
    expect(lastProbe()).toMatchObject({ enabled: false });
    expect(screen.queryByTestId("bucketed-capacity")).toBeNull();

    await screen.rerender(
      <ThemeProvider>
        <HostCard
          host={{ ...onlineHost, host_public_key: null }}
          liveCapacity
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
        />
      </ThemeProvider>,
    );
    expect(lastProbe()).toMatchObject({ enabled: false });
    expect(screen.getByText("This host does not report live capacity.")).toBeOnTheScreen();
  });

  test("says so when a reachable host has no live figures to give", async () => {
    await renderCard({ liveCapacity: true });

    await act(async () => {
      lastProbe().onStateChange("ready");
      lastProbe().onUnavailable("unsupported operation: host.metrics");
    });

    expect(screen.getByText("This host does not report live capacity.")).toBeOnTheScreen();
    // The heartbeat's reading stays: it is still true.
    expect(screen.getByTestId("bucketed-capacity")).toBeOnTheScreen();
  });

  test("a failed channel is not mistaken for a host without telemetry", async () => {
    await renderCard({ liveCapacity: true });

    await act(async () => {
      lastProbe().onStateChange("failed");
      lastProbe().onUnavailable("The connection to office-mac failed.");
    });

    expect(screen.queryByText("This host does not report live capacity.")).toBeNull();
  });
});
