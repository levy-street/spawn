import { render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, View } from "react-native";
import {
  codexAgent,
  offlineHost,
  onlineHost,
  runningSession,
} from "@/components/hosts/__tests__/fixtures";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import { LegionHostCard } from "@/components/hosts/legion-host-card";
import { fleetRollup } from "@/data/selectors/host";
import { ThemeProvider } from "@/theme";

const mockLiveCapacityProbe = jest.fn((_props: unknown) => null);

jest.mock("@/components/hosts/live-capacity-probe", () => ({
  LiveCapacityProbe: (props: unknown) => mockLiveCapacityProbe(props),
}));

describe("Legion fleet surface", () => {
  beforeEach(() => {
    mockLiveCapacityProbe.mockClear();
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
    expect(screen.getByText(/4.0 GiB of 8.0 GiB/)).toBeOnTheScreen();
  });

  test("renders fleet hardware, coarse capacity, sessions, attention, and running agent", async () => {
    await render(
      <ThemeProvider>
        <LegionHostCard
          agents={[codexAgent]}
          host={onlineHost}
          liveEnabled={false}
          onOpen={jest.fn()}
          sessions={[runningSession]}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("12 cores · 24 GiB · Apple M4 Pro")).toBeOnTheScreen();
    expect(screen.getByText("1 live session")).toBeOnTheScreen();
    expect(screen.getByText("1 need you")).toBeOnTheScreen();
    expect(screen.getByText("Codex")).toBeOnTheScreen();
  });

  test("marks hosts whose daemon is updating", async () => {
    await render(
      <ThemeProvider>
        <LegionHostCard
          agents={[]}
          host={{
            ...onlineHost,
            update: {
              state: "updating",
              latest_version: "2.0.0",
              error: null,
              requested_at: "2026-08-25T00:00:00Z",
            },
          }}
          liveEnabled={false}
          onOpen={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("updating")).toBeOnTheScreen();
  });

  test("pauses a live-capacity probe while its card is outside the viewport", async () => {
    await render(
      <ThemeProvider>
        <LegionHostCard
          agents={[]}
          host={onlineHost}
          liveEnabled
          onOpen={jest.fn()}
          probeEnabled={false}
          sessions={[]}
        />
      </ThemeProvider>,
    );

    expect(mockLiveCapacityProbe).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, hostId: onlineHost.id }),
    );
  });
});
