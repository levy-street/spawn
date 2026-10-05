import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockListHostAgents = jest.fn();

jest.mock("@/data/api/endpoints/hosts", () => ({
  ...jest.requireActual("@/data/api/endpoints/hosts"),
  listHostAgents: (hostId: string) => mockListHostAgents(hostId),
}));

import { hostAgent, offlineHost, onlineHost } from "@/components/hosts/__tests__/fixtures";
import { HostAgentsSection } from "@/components/hosts/cockpit/host-agents-section";
import { HostAgentRow } from "@/components/hosts/host-agent-row";
import { qk } from "@/data/queryKeys";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../tests/render";

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderWithClient(ui: React.ReactElement, client = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{ui}</SafeAreaProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("host agent availability", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    mockListHostAgents.mockReset();
    mockListHostAgents.mockResolvedValue({ agents: [hostAgent] });
  });

  afterEach(() => jest.restoreAllMocks());

  test("keeps availability visible without server-authorized execution controls", async () => {
    await renderWithClient(<HostAgentRow agent={{ ...hostAgent, auto_update: true }} />);
    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(screen.getByText("update 1.3.0")).toBeOnTheScreen();
    expect(screen.getByText("/usr/local/bin/codex")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Auto update Codex" })).toBeNull();
  });

  test("checks a host's agents only when asked, and never again on its own", async () => {
    jest.useFakeTimers();
    try {
      await renderWithClient(<HostAgentsSection host={onlineHost} />);

      // Opening the page runs nothing on the host.
      expect(mockListHostAgents).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByRole("button", { name: "Check agents" }));
      expect(await screen.findByText("Codex")).toBeOnTheScreen();
      expect(mockListHostAgents).toHaveBeenCalledTimes(1);
      expect(mockListHostAgents).toHaveBeenCalledWith(onlineHost.id);

      // No timer asks again: the old page re-ran the probe every minute.
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(mockListHostAgents).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByRole("button", { name: "Check again" }));
      await jest.advanceTimersByTimeAsync(0);
      expect(mockListHostAgents).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a host coming or going, or the network returning, never rechecks on its own", async () => {
    const client = createTestQueryClient();
    await renderWithClient(<HostAgentsSection host={onlineHost} />, client);
    await fireEvent.press(screen.getByRole("button", { name: "Check agents" }));
    expect(await screen.findByText("Codex")).toBeOnTheScreen();
    expect(mockListHostAgents).toHaveBeenCalledTimes(1);

    // Every "hosts" realtime frame invalidates host-agents (event-map.ts);
    // that marks the answer stale but must not run the probe again.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["host-agents"] });
    });
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(mockListHostAgents).toHaveBeenCalledTimes(1);
  });

  test("says what checking does before it is asked, and Checking… while it runs", async () => {
    let answer: (value: unknown) => void = () => undefined;
    mockListHostAgents.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await renderWithClient(<HostAgentsSection host={onlineHost} />);
    expect(screen.getByRole("header", { name: "Agent availability" })).toBeOnTheScreen();
    expect(
      screen.getByText(`Check to see which agents are installed on ${onlineHost.name}.`),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Check agents" }));
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();

    await act(async () => answer({ agents: [] }));
    expect(await screen.findByText("No agents are defined.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Check again" })).toBeOnTheScreen();
  });

  test("shows an answer already in hand without asking the host", async () => {
    const client = createTestQueryClient();
    client.setQueryData(qk.hostAgents(onlineHost.id), { agents: [hostAgent] });
    await renderWithClient(<HostAgentsSection host={onlineHost} />, client);

    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(mockListHostAgents).not.toHaveBeenCalled();
  });

  test("an offline host says why there is nothing to check", async () => {
    await renderWithClient(<HostAgentsSection host={offlineHost} />);

    expect(
      screen.getByText("Agent availability is unavailable while the daemon is offline."),
    ).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Check agents" })).toBeNull();
  });
});
