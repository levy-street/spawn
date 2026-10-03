import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { AccessibilityInfo, type ViewabilityConfigCallbackPairs } from "react-native";
import {
  codexAgent,
  offlineHost,
  onlineHost,
  runningSession,
  windowsHost,
} from "@/components/hosts/__tests__/fixtures";
import {
  HostDetailView,
  hostDoctorPresentation,
  hostPinCapacityWarning,
} from "@/components/hosts/host-detail-view";
import { HostsView, hostsSummaryLine, useOnScreenHosts } from "@/components/hosts/hosts-screen";
import { type HostOut, HostOutSchema } from "@/data/api/schemas/hosts";
import { ThemeProvider } from "@/theme";

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock("@/components/hosts/live-capacity-probe", () => ({
  LiveCapacityProbe: jest.fn(() => null),
}));

/** Tell the rendered host list which cards are on screen, as FlatList does on a device. */
async function reportOnScreen(hosts: readonly HostOut[]): Promise<void> {
  const pairs = screen.getByTestId("hosts-list").props[
    "viewabilityConfigCallbackPairs"
  ] as ViewabilityConfigCallbackPairs;
  await act(async () => {
    for (const pair of pairs) {
      pair.onViewableItemsChanged?.({
        changed: [],
        viewableItems: hosts.map((host, index) => ({
          index,
          isViewable: true,
          item: host,
          key: host.id,
        })),
      });
    }
  });
}

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
        <HostsView
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

    // The list is the hosts and nothing else: no bank of fleet totals above
    // the first host, and no row that opens a page of its own to show them.
    expect(screen.queryByText("Fleet overview")).toBeNull();
    // Said once, under the last host: where the exact figures come from.
    expect(
      screen.getByText(
        "Exact figures travel straight from each host to this device. The spawnd server only ever sees a five-level reading every thirty seconds.",
      ),
    ).toBeOnTheScreen();
  });

  test("an empty fleet says what a host is and how to possess one", async () => {
    const onConnect = jest.fn();
    await render(
      <ThemeProvider>
        <HostsView
          hosts={[]}
          onConnect={onConnect}
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          onRefresh={jest.fn()}
          refreshing={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("No hosts yet.")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "A host is a computer your agents run on. Install SPAWN D on it, then run spawnd possess there.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Possess a host" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Exact figures travel/)).toBeNull();
  });

  test("totals the fleet in one line: hosts online, cores, and who needs you", () => {
    const rollup = {
      hosts: 3,
      onlineHosts: 2,
      offlineHosts: 1,
      sessionRows: 9,
      liveSessions: 4,
      runningAgents: 2,
      attention: 1,
    };
    expect(hostsSummaryLine([onlineHost, offlineHost, windowsHost], rollup)).toBe(
      "2 of 3 online · 36 cores · 1 need you",
    );
    expect(
      hostsSummaryLine([{ ...onlineHost, cpu_cores: null }], {
        ...rollup,
        hosts: 1,
        onlineHosts: 1,
        attention: 0,
      }),
    ).toBe("1 of 1 online");
  });

  test("asks only the cards on screen for exact figures, and none while not live", async () => {
    const probe = jest.requireMock("@/components/hosts/live-capacity-probe") as {
      LiveCapacityProbe: jest.Mock;
    };
    // What each card's probe was last told, which is what it is doing now.
    const askingHosts = () => {
      const latest = new Map<string, boolean>();
      for (const [props] of probe.LiveCapacityProbe.mock.calls as [
        { enabled: boolean; hostId: string },
      ][]) {
        latest.set(props.hostId, props.enabled);
      }
      return [...latest]
        .filter(([, enabled]) => enabled)
        .map(([hostId]) => hostId)
        .sort();
    };
    const view = (live: boolean) => (
      <ThemeProvider>
        <HostsView
          hosts={[onlineHost, windowsHost]}
          live={live}
          onConnect={jest.fn()}
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          onRefresh={jest.fn()}
          refreshing={false}
        />
      </ThemeProvider>
    );

    probe.LiveCapacityProbe.mockClear();
    const list = await render(view(true));
    // Nothing has been laid out on screen yet, so nothing is asked.
    expect(askingHosts()).toEqual([]);

    // The list reports one card on screen: that card asks, the other does not.
    await reportOnScreen([onlineHost]);
    expect(askingHosts()).toEqual([onlineHost.id]);

    // Scrolled: the card that left stops asking, the one that came in starts.
    await reportOnScreen([windowsHost]);
    expect(askingHosts()).toEqual([windowsHost.id]);

    // Not live (another tab, or the app in the background): no card asks,
    // even the one still on screen.
    await list.rerender(view(false));
    expect(askingHosts()).toEqual([]);
    await list.rerender(view(true));
    expect(askingHosts()).toEqual([windowsHost.id]);
  });

  test("tracks which hosts' cards are on screen, as the list reports them", async () => {
    const { result } = await renderHook(useOnScreenHosts);
    const report = (hosts: readonly HostOut[]) =>
      act(async () => {
        for (const pair of result.current.viewabilityConfigCallbackPairs) {
          pair.onViewableItemsChanged?.({
            changed: [],
            viewableItems: hosts.map((host, index) => ({
              index,
              isViewable: true,
              item: host,
              key: host.id,
            })),
          });
        }
      });

    expect([...result.current.onScreen]).toEqual([]);
    await report([onlineHost]);
    expect([...result.current.onScreen]).toEqual([onlineHost.id]);
    const unchanged = result.current.onScreen;
    await report([onlineHost]);
    // The same cards are the same set, so no card re-renders for nothing.
    expect(result.current.onScreen).toBe(unchanged);
    await report([windowsHost, offlineHost]);
    expect([...result.current.onScreen].sort()).toEqual([offlineHost.id, windowsHost.id].sort());
    // The list's callbacks are fixed for its lifetime: FlatList refuses new ones.
    const pairs = result.current.viewabilityConfigCallbackPairs;
    await report([]);
    expect(result.current.viewabilityConfigCallbackPairs).toBe(pairs);
    expect([...result.current.onScreen]).toEqual([]);
  });

  test("a host card reads out capacity, spec and what is running", async () => {
    await render(
      <ThemeProvider>
        <HostsView
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
      "macOS · ARM64",
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

  test("formats Windows consistently without changing the generic host UI", async () => {
    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={windowsHost}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Windows · x64")).toBeOnTheScreen();
    expect(screen.getByText("Windows · x64 · daemon 1.4.2")).toBeOnTheScreen();
  });

  test("surfaces daemon update state on host rows and facts", async () => {
    const outdated = {
      ...onlineHost,
      update: {
        state: "available" as const,
        latest_version: "2.0.0",
        error: null,
        requested_at: null,
      },
    };
    const list = await render(
      <ThemeProvider>
        <HostsView
          hosts={[outdated]}
          onConnect={jest.fn()}
          onOpen={jest.fn()}
          onOpenActions={jest.fn()}
          onRefresh={jest.fn()}
          refreshing={false}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("update available")).toBeOnTheScreen();
    await list.unmount();

    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={{ ...outdated, update: { ...outdated.update, state: "updating" } }}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("updating")).toBeOnTheScreen();
  });

  test("a changed host identity blocks the page and offers removal as the only exit", async () => {
    const onRemove = jest.fn();
    const onOpenFiles = jest.fn();
    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={onlineHost}
          identityConflict
          onOpenAgents={jest.fn()}
          onOpenFiles={onOpenFiles}
          onOpenSession={jest.fn()}
          onRemove={onRemove}
          sessions={[]}
        />
      </ThemeProvider>,
    );

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
    expect(
      screen.getByText(
        "If you reinstalled this host yourself, remove it here, then run `spawnd possess` in its terminal — possessing it again is the re-verification.",
      ),
    ).toBeOnTheScreen();
    // One exit, and never a way to accept the new identity in place.
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
    expect(within(panel).queryByText(/trust|accept/i)).toBeNull();
    await fireEvent.press(screen.getByTestId("conflict-remove-host"));
    expect(onRemove).toHaveBeenCalledTimes(1);

    expect(
      screen.getByText(
        "Connections to this host are blocked until it is removed and possessed again.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Files"));
    expect(onOpenFiles).not.toHaveBeenCalled();
  });

  test("a host whose identity checks out shows no conflict and opens its files", async () => {
    const onOpenFiles = jest.fn();
    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={onlineHost}
          onOpenAgents={jest.fn()}
          onOpenFiles={onOpenFiles}
          onOpenSession={jest.fn()}
          onRemove={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("host-identity-conflict")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: /^Files, Browse this host/ }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  test("opens the update dialog from the update chip, as the browser's badge does", async () => {
    const onOpenUpdate = jest.fn();
    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={{
            ...onlineHost,
            update: {
              state: "available",
              latest_version: "2.0.0",
              error: null,
              requested_at: null,
            },
          }}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          onOpenUpdate={onOpenUpdate}
          sessions={[]}
        />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "update available" }));
    expect(onOpenUpdate).toHaveBeenCalledTimes(1);
  });

  test("selects every offline mini-doctor case and collapses it online", () => {
    const now = Date.parse("2026-08-22T02:00:00Z");
    expect(hostDoctorPresentation({ ...offlineHost, last_seen_at: null }, now)).toEqual({
      kind: "never-connected",
      message: "SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor",
      command: "spawnd doctor",
    });
    expect(
      hostDoctorPresentation(
        {
          ...offlineHost,
          last_disconnect: { at: "2026-08-22T01:59:00Z", reason: "auth_rejected" },
        },
        now,
      ),
    ).toEqual({
      kind: "auth-rejected",
      message: "old-laptop can't sign in. On that machine, run: spawnd login",
      command: "spawnd login",
    });
    expect(
      hostDoctorPresentation(
        {
          ...offlineHost,
          update: {
            state: "failed",
            latest_version: "2.0.0",
            error: "update failed",
            requested_at: null,
          },
        },
        now,
      ),
    ).toEqual({
      kind: "stale-version",
      message:
        "old-laptop runs 1.4.2. On it, run: spawnd update (or it will self-update when idle).",
      command: "spawnd update",
    });
    expect(hostDoctorPresentation(offlineHost, now)).toEqual({
      kind: "plain-offline",
      message:
        "Last seen 2h ago (connection dropped). If the machine is on, run spawnd doctor there.",
      command: "spawnd doctor",
    });
    expect(hostDoctorPresentation(onlineHost, now)).toEqual({
      kind: "online",
      message: "Daemon 1.4.2",
      command: null,
    });
  });

  test("accepts older host responses without last_disconnect", () => {
    const parsed = HostOutSchema.parse(offlineHost);
    expect(parsed.last_disconnect).toBeUndefined();
  });

  test("renders the helper only for an offline host", async () => {
    const offline = await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={{ ...offlineHost, last_seen_at: null }}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("Something wrong?")).toBeOnTheScreen();
    expect(screen.getByTestId("host-doctor-never-connected")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy spawnd doctor" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("spawnd doctor");
    await offline.unmount();

    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
          host={onlineHost}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText("Something wrong?")).toBeNull();
    expect(screen.getByText(/daemon 1\.4\.2/i)).toBeOnTheScreen();
  });

  test("warns at 28 approvals and marks a pin the host did not receive", async () => {
    expect(hostPinCapacityWarning({ used: 27, max: 32 })).toBeNull();
    expect(hostPinCapacityWarning({ used: 28, max: 32 })).toBe(
      "This host is close to its limit of approving devices (28 of 32). Remove devices you no longer use under Access.",
    );

    await render(
      <ThemeProvider>
        <HostDetailView
          agents={[]}
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
            capacity: { used: 28, max: 32 },
            pins: [
              {
                browser_device_id: "11111111-1111-4111-8111-111111111111",
                delivered: false,
                undelivered_reason: "invalid_chain",
              },
            ],
          }}
          onOpenAgents={jest.fn()}
          onOpenFiles={jest.fn()}
          onOpenSession={jest.fn()}
          sessions={[]}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Approving devices · 28 of 32")).toBeOnTheScreen();
    expect(screen.getByText("Not delivered")).toBeOnTheScreen();
    expect(screen.getByTestId("host-device-capacity-warning")).toBeOnTheScreen();
  });
});
