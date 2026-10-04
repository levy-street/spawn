import { onlineHost, runningSession } from "@/components/hosts/__tests__/fixtures";
import {
  cockpitStatusLine,
  cockpitTab,
  groupSessionsByWorkspace,
  hostFolders,
  runningHere,
  stepCockpitTab,
  windowBlockedReason,
} from "@/components/hosts/cockpit/cockpit-model";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";

function session(id: string, overrides: Partial<SessionOut> = {}): SessionOut {
  return { ...runningSession, id, activity_state: "quiet", ...overrides };
}

function workspace(id: string, name: string, sessionIds: string[], archived = false): WorkspaceOut {
  return {
    id,
    name,
    host_id: null,
    cwd: null,
    layout: {
      version: 3,
      active_tab: "tab",
      tabs: [
        {
          id: "tab",
          name: "Tab",
          host_id: null,
          cwd: null,
          layout: {
            version: 3,
            tiles: sessionIds.map((sessionId, index) => ({
              session_id: sessionId,
              x: index,
              y: 0,
              w: 1,
              h: 1,
            })),
          },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: archived ? "2026-09-01T00:00:00Z" : null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

describe("host cockpit model", () => {
  test("a link's tab opens that tab; anything else opens Overview", () => {
    expect(cockpitTab("sessions")).toBe("sessions");
    expect(cockpitTab(["access", "files"])).toBe("access");
    expect(cockpitTab("agents")).toBe("overview");
    expect(cockpitTab("desktop")).toBe("overview");
    expect(cockpitTab(undefined)).toBe("overview");
  });

  test("a swipe steps one tab and stops at either end", () => {
    expect(stepCockpitTab("overview", 1)).toBe("files");
    expect(stepCockpitTab("files", -1)).toBe("overview");
    expect(stepCockpitTab("overview", -1)).toBeNull();
    expect(stepCockpitTab("access", 1)).toBeNull();
  });

  test("the status line says whether this device can reach the host now", () => {
    const now = Date.parse("2026-08-22T03:00:00Z");
    expect(cockpitStatusLine(onlineHost, { reconnecting: false }, now)).toBe("Online");
    expect(cockpitStatusLine(onlineHost, { reconnecting: true }, now)).toBe("Reconnecting…");
    expect(
      cockpitStatusLine({ ...onlineHost, status: "offline" }, { reconnecting: true }, now),
    ).toBe("Offline · last seen 3h ago");
    expect(
      cockpitStatusLine({ status: "offline", last_seen_at: null }, { reconnecting: false }, now),
    ).toBe("Offline · never connected");
  });

  test("Running here leads with who needs a person, then what is working, and stops at six", () => {
    const sessions = [
      session("quiet-old", { last_activity_at: "2026-08-22T00:00:00Z" }),
      session("ended", { status: "exited", activity_state: "waiting" }),
      session("working", { activity_state: "active" }),
      session("waiting", { activity_state: "waiting" }),
      session("quiet-new", { last_activity_at: "2026-08-22T02:00:00Z" }),
    ];
    expect(runningHere(sessions).map((each) => each.id)).toEqual([
      "waiting",
      "working",
      "quiet-new",
      "quiet-old",
    ]);
    const many = Array.from({ length: 9 }, (_, index) => session(`s${index}`));
    expect(runningHere(many)).toHaveLength(6);
  });

  test("folders are where the live windows run, most recently used first, then home", () => {
    const folders = hostFolders([
      // Busier, but not touched since this morning.
      session("a", { cwd: "/Users/spawn/dev/native", last_activity_at: "2026-08-22T08:00:00Z" }),
      session("b", { cwd: "/Users/spawn/dev/native", last_input_at: "2026-08-22T09:00:00Z" }),
      session("c", { cwd: "/Users/spawn/dev/web", last_activity_at: "2026-08-22T11:00:00Z" }),
      session("gone", {
        cwd: "/Users/spawn/old",
        status: "killed",
        last_activity_at: "2026-08-22T12:00:00Z",
      }),
    ]);
    expect(folders).toEqual([
      { path: "/Users/spawn/dev/web", windows: 1 },
      { path: "/Users/spawn/dev/native", windows: 2 },
      { path: "~", windows: 0 },
    ]);
    // A window already in the home folder is home, said once — however the
    // window names it.
    expect(hostFolders([session("h", { cwd: "~" })])).toEqual([{ path: "~", windows: 1 }]);
    expect(hostFolders([session("h", { cwd: "/Users/spawn" })])).toEqual([
      { path: "/Users/spawn", windows: 1 },
    ]);
    expect(hostFolders([])).toEqual([{ path: "~", windows: 0 }]);
  });

  test("a window can be opened unless the host is offline or its identity changed", () => {
    expect(windowBlockedReason(onlineHost, false)).toBeNull();
    // A host this device holds no key for still takes a window; only browsing
    // its folders needs the key.
    const keyless: typeof onlineHost = { ...onlineHost, host_public_key: null };
    expect(windowBlockedReason(keyless, false)).toBeNull();
    expect(windowBlockedReason({ ...onlineHost, status: "offline" }, false)).toBe(
      `${onlineHost.name} is offline.`,
    );
    expect(windowBlockedReason(onlineHost, true)).toBe(
      "Connections to this host are blocked until it is removed and possessed again.",
    );
  });

  test("windows group under their workspaces, archived ones named, the rest last", () => {
    const groups = groupSessionsByWorkspace(
      [
        session("loose"),
        session("in-a-ended", { status: "exited" }),
        session("in-a"),
        session("in-old"),
        session("in-b"),
      ],
      [
        workspace("a", "Alpha", ["in-a-ended", "in-a"]),
        workspace("b", "Beta", ["in-b"]),
        workspace("empty", "Empty", []),
        workspace("old", "Old", ["in-old"], true),
      ],
    );
    expect(
      groups.map((group) => [group.workspace?.name ?? null, group.sessions.map((each) => each.id)]),
    ).toEqual([
      ["Alpha", ["in-a", "in-a-ended"]],
      ["Beta", ["in-b"]],
      ["Old", ["in-old"]],
      [null, ["loose"]],
    ]);
    expect(groups[2]?.workspace?.archived_at).not.toBeNull();
  });
});
