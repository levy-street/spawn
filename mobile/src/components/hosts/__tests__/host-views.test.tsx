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
    await render(
      <ThemeProvider>
        <HostListView
          hosts={[onlineHost, offlineHost]}
          onConnect={jest.fn()}
          onOpen={onOpen}
          onOpenActions={jest.fn()}
          onOpenLegion={jest.fn()}
          onRefresh={jest.fn()}
          refreshing={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("office-mac")).toBeOnTheScreen();
    expect(screen.getByText("macOS/arm64 · daemon 1.4.2")).toBeOnTheScreen();
    expect(screen.getAllByText("3 sessions")).toHaveLength(2);
    expect(screen.getByText("old-laptop")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "office-mac, online" }));
    expect(onOpen).toHaveBeenCalledWith(onlineHost);
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
