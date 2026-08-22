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
    const onOpenLegion = jest.fn();
    await render(
      <ThemeProvider>
        <HostListView
          hosts={[onlineHost, offlineHost]}
          onConnect={jest.fn()}
          onOpen={onOpen}
          onOpenActions={onOpenActions}
          onOpenLegion={onOpenLegion}
          onRefresh={jest.fn()}
          refreshing={false}
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
    expect(screen.getAllByTestId("list-separator")).toHaveLength(1);
    expect(screen.getByText("old-laptop")).toBeOnTheScreen();

    const officeMacRow = screen.getByRole("button", { name: /office-mac, online · heartbeat/ });
    await fireEvent.press(officeMacRow);
    expect(onOpen).toHaveBeenCalledWith(onlineHost);

    await fireEvent.press(screen.getByRole("button", { name: "Actions for office-mac" }));
    expect(onOpenActions).toHaveBeenCalledWith(onlineHost);
    expect(onOpen).toHaveBeenCalledTimes(1);

    await fireEvent(officeMacRow, "longPress");
    expect(onOpenActions).toHaveBeenCalledTimes(2);

    await fireEvent.press(
      screen.getByRole("button", {
        name: "Fleet overview, 1 online · 1 offline · 6 sessions",
      }),
    );
    expect(onOpenLegion).toHaveBeenCalledTimes(1);
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
