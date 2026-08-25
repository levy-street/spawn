import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
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
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("office-mac")).toBeOnTheScreen();
    // A row is a glance: the heartbeat and what the machine has to give. The
    // OS, the architecture and the daemon version belong to its own page.
    expect(screen.getByText(/online · heartbeat [\s\S]*12 cores · 24 GiB/)).toBeOnTheScreen();
    expect(screen.getByText(/offline · last seen [\s\S]*12 cores · 24 GiB/)).toBeOnTheScreen();
    expect(screen.queryByText(/daemon 1\.4\.2/)).toBeNull();
    expect(
      screen.getByTestId(`host-status-${onlineHost.id}`, { includeHiddenElements: true }),
    ).toHaveStyle({ position: "absolute" });
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

    // The list is the machines and nothing else: no bank of fleet totals above
    // the first host, and no row that opens a page of its own to show them.
    expect(screen.queryByTestId("legion-summary")).toBeNull();
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
    expect(screen.getAllByText(/12 cores · 24 GiB/)).toHaveLength(2);

    // What is on the machine, not just how many of it — and not who it is
    // waiting on: a session needing a person is the workspace's to say.
    expect(screen.getByTestId(`host-running-${onlineHost.id}`)).toBeOnTheScreen();
    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(screen.queryByText(/need you/)).toBeNull();

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
      "XOCTsSKj9-Z7qRynE70szG_DNBeHiLzEBOCG1clQbz8",
      "SHA256:pm9SJXQwKoWeB-v_",
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
