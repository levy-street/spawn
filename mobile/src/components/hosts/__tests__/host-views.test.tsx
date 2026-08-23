import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Text as NativeText } from "react-native";
import {
  codexAgent,
  offlineHost,
  onlineHost,
  runningSession,
} from "@/components/hosts/__tests__/fixtures";
import { HostDetailView } from "@/components/hosts/host-detail-view";
import { HostListView } from "@/components/hosts/host-list-screen";
import { ThemeProvider } from "@/theme";

describe("host list and detail rendering", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test("renders every documented list field and opens rows", async () => {
    const onOpen = jest.fn();
    const onOpenActions = jest.fn();
    await render(
      <ThemeProvider>
        <HostListView
          hosts={[onlineHost, offlineHost]}
          onConnect={jest.fn()}
          onOpen={onOpen}
          onOpenActions={onOpenActions}
          onRefresh={jest.fn()}
          refreshing={false}
          summary={<NativeText>Legion rollup</NativeText>}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("office-mac")).toBeOnTheScreen();
    expect(
      screen.getByText(/online · heartbeat [\s\S]*macOS\/arm64 · daemon 1\.4\.2/),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(/offline · last seen [\s\S]*macOS\/arm64 · daemon 1\.4\.2/),
    ).toBeOnTheScreen();
    expect(screen.getAllByText("3 sessions")).toHaveLength(2);
    expect(
      screen.getByTestId(`host-status-${onlineHost.id}`, { includeHiddenElements: true }),
    ).toHaveStyle({ position: "absolute" });
    expect(screen.getByTestId(`host-session-count-${onlineHost.id}`)).toBeOnTheScreen();
    // Between the two hosts, and under the last of them to close the list.
    expect(screen.getAllByTestId("list-separator")).toHaveLength(2);
    expect(screen.getByText("old-laptop")).toBeOnTheScreen();

    const officeMacRow = screen.getByRole("button", { name: /office-mac, online · heartbeat/ });
    await fireEvent.press(officeMacRow);
    expect(onOpen).toHaveBeenCalledWith(onlineHost);

    await fireEvent.press(screen.getByRole("button", { name: "Actions for office-mac" }));
    expect(onOpenActions).toHaveBeenCalledWith(onlineHost);
    expect(onOpen).toHaveBeenCalledTimes(1);

    await fireEvent(officeMacRow, "longPress");
    expect(onOpenActions).toHaveBeenCalledTimes(2);

    // The legion's numbers sit at the head of the list itself; there is no row
    // here that opens a page of its own to show them.
    expect(screen.getByText("Legion rollup")).toBeOnTheScreen();
    expect(screen.queryByText("Fleet overview")).toBeNull();
  });

  test("a legion row reads out capacity, spec and what is running", async () => {
    await render(
      <ThemeProvider>
        <HostListView
          agents={[codexAgent]}
          hosts={[onlineHost, offlineHost]}
          onConnect={jest.fn()}
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          onRefresh={jest.fn()}
          refreshing={false}
          sessions={[runningSession]}
        />
      </ThemeProvider>,
    );

    // The heartbeat's five-level reading, in the words the meter uses.
    expect(screen.getAllByTestId("bucketed-capacity")).toHaveLength(1);
    expect(screen.getByLabelText("CPU Busy")).toBeOnTheScreen();
    expect(screen.getByLabelText("MEM Working")).toBeOnTheScreen();
    // Both fixtures share a spec; the offline one keeps it and loses the meter.
    expect(screen.getAllByText("12 cores · 24 GiB · Apple M4 Pro")).toHaveLength(2);

    // What is on the machine, not just how many of it.
    expect(screen.getByTestId(`host-running-${onlineHost.id}`)).toBeOnTheScreen();
    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(screen.getByTestId(`host-attention-${onlineHost.id}`)).toBeOnTheScreen();

    // An offline machine reports no capacity, and a stale meter is worse than
    // none — the spec still says what the machine is.
    expect(screen.queryByTestId(`host-running-${offlineHost.id}`)).toBeNull();
    expect(screen.getByRole("button", { name: /old-laptop[\s\S]*12 cores/ })).toBeOnTheScreen();
  });

  test("renders host facts and session identity while omitting nonexistent daemon actions", async () => {
    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[codexAgent]}
          host={onlineHost}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[runningSession]}
        />
      </ThemeProvider>,
    );

    for (const value of [
      "macOS/arm64",
      "1.4.2",
      "ed25519",
      "host-public-key",
      "SHA256:hostfingerprint",
      "native app",
      "Codex · /Users/spawn/dev/native",
      "Awaiting input",
    ]) {
      expect(screen.getByText(value)).toBeOnTheScreen();
    }
    expect(screen.queryByText(/restart daemon/i)).not.toBeOnTheScreen();
    expect(screen.queryByText(/update daemon/i)).not.toBeOnTheScreen();
    expect(screen.queryByText(/daemon logs/i)).not.toBeOnTheScreen();
  });
});
