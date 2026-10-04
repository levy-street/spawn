import { describe, expect, test } from "bun:test";

import type { Session, Workspace } from "@/lib/api";
import {
  folderSubtitle,
  groupHostSessions,
  type HostStatusLine,
  hostFolders,
  hostSessionGroupTitle,
  hostStatusLine,
  hostTabHref,
  hostTabSegment,
  memoryFigure,
  possessedLabel,
  runningHere,
  serverInstant,
} from "./host-cockpit";

const DREAM = "11111111-2222-4333-8444-555555555551";
const MAC = "11111111-2222-4333-8444-555555555552";
const WORK = "22222222-2222-4222-8222-222222222221";
const PLAY = "22222222-2222-4222-8222-222222222222";

let counter = 0;
function session(hostId: string, overrides: Partial<Session> = {}): Session {
  counter += 1;
  return {
    id: `33333333-3333-4333-8333-${String(counter).padStart(12, "0")}`,
    name: null,
    host_id: hostId,
    host_name: null,
    cwd: "/home/me/code/spawn",
    status: "running",
    started_at: "2026-10-01T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: null,
    agent_id: null,
    agent_session_id: null,
    ...overrides,
  };
}

function workspace(
  id: string,
  name: string,
  sessionIds: string[],
  archivedAt: string | null = null,
): Workspace {
  return {
    id,
    name,
    archived_at: archivedAt,
    layout: {
      version: 3,
      active_tab: "tab-1",
      tabs: [
        {
          id: "tab-1",
          name: "Main",
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
  } as unknown as Workspace;
}

describe("host sections", () => {
  test("Overview is the host's own address and the rest sit under it", () => {
    expect(hostTabHref(DREAM, "")).toBe(`/hosts/${DREAM}`);
    expect(hostTabHref(DREAM, "files")).toBe(`/hosts/${DREAM}/files`);
  });

  test("the address names its section, and anything else reads as Overview", () => {
    expect(hostTabSegment(`/hosts/${DREAM}`, DREAM)).toBe("");
    expect(hostTabSegment(`/hosts/${DREAM}/`, DREAM)).toBe("");
    expect(hostTabSegment(`/hosts/${DREAM}/files`, DREAM)).toBe("files");
    expect(hostTabSegment(`/hosts/${DREAM}/sessions/extra`, DREAM)).toBe("sessions");
    expect(hostTabSegment(`/hosts/${MAC}/files`, DREAM)).toBe("");
    expect(hostTabSegment(`/hosts/${DREAM}files`, DREAM)).toBe("");
    expect(hostTabSegment(null, DREAM)).toBe("");
  });
});

describe("hostStatusLine", () => {
  const dream = { name: "dream", status: "online", last_seen_at: "2026-10-03T00:00:00Z" };

  test("names the path this device took, and its round trip", () => {
    const ready = { state: "ready" as const, error: null };
    expect(
      hostStatusLine(dream, { ...ready, info: { kind: "direct", rttMs: 23.6, protocol: null } })
        .text,
    ).toBe("Online · direct · 24 ms");
    expect(
      hostStatusLine(dream, { ...ready, info: { kind: "stun", rttMs: 41, protocol: null } }).text,
    ).toBe("Online · direct · 41 ms");
    expect(
      hostStatusLine(dream, { ...ready, info: { kind: "relay", rttMs: null, protocol: null } })
        .text,
    ).toBe("Online · relayed");
    expect(hostStatusLine(dream, ready).text).toBe("Online");
    expect(hostStatusLine(dream, null)).toEqual({
      text: "Online",
      tone: "active",
      retry: false,
      reason: null,
    });
  });

  test("a host this device lost says so in one fixed word, the reason beside the way back", () => {
    expect(hostStatusLine(dream, { state: "connecting", error: null })).toEqual({
      text: "Reconnecting…",
      tone: "warning",
      retry: true,
      reason: null,
    });
    expect(
      hostStatusLine(dream, { state: "error", error: "Too many views of dream are open." }),
    ).toEqual({
      text: "Reconnecting…",
      tone: "warning",
      retry: true,
      reason: "Too many views of dream are open.",
    });
  });

  test("a changed identity is blocked, not reconnecting, and offers no Retry", () => {
    const blocked: HostStatusLine = {
      text: "Blocked · identity changed",
      tone: "blocked",
      retry: false,
      reason: null,
    };
    // What the connection says while every attempt is refused.
    const refused = { state: "error" as const, error: "Can't reach dream from this device." };
    expect(hostStatusLine(dream, refused, true)).toEqual(blocked);
    expect(hostStatusLine(dream, { state: "connecting", error: null }, true)).toEqual(blocked);
    expect(hostStatusLine({ ...dream, status: "offline" }, null, true)).toEqual(blocked);
    expect(hostStatusLine(dream, refused, false).text).toBe("Reconnecting…");
  });

  test("offline is the server's word, whatever this device holds", () => {
    const offline = { ...dream, status: "offline", last_seen_at: null };
    expect(hostStatusLine(offline, { state: "ready", error: null })).toEqual({
      text: "Offline · never connected",
      tone: "offline",
      retry: false,
      reason: null,
    });
    const seen = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(hostStatusLine({ ...offline, last_seen_at: seen }, null).text).toBe(
      "Offline · last seen 3h ago",
    );
  });
});

describe("memoryFigure", () => {
  test("keeps each amount on one line, so a narrow Right now wraps between them", () => {
    const GB = 1024 ** 3;
    expect(memoryFigure(89 * GB, 125 * GB)).toBe("89\u00a0GB of 125\u00a0GB");
    expect(memoryFigure(0, 16 * GB)).toBe("0\u00a0B of 16\u00a0GB");
    expect(memoryFigure(5 * GB, 0)).toBeNull();
  });
});

describe("what runs here", () => {
  test("Running here is this host's live windows, most urgent first", () => {
    const quiet = session(DREAM, { last_activity_at: "2026-10-02T00:00:00Z" });
    const waiting = session(DREAM, { activity_state: "waiting" });
    const exited = session(DREAM, { status: "exited" });
    const elsewhere = session(MAC, { activity_state: "waiting" });
    const moving = session(DREAM, { status: "moving", activity_state: "moving" });
    expect(
      runningHere([quiet, waiting, exited, elsewhere, moving], DREAM).map((item) => item.id),
    ).toEqual([waiting.id, quiet.id]);
    expect(runningHere([quiet, waiting], DREAM, 1)).toHaveLength(1);
  });

  test("folders are where live windows run, latest first, then home", () => {
    const older = session(DREAM, { cwd: "/srv/old", last_input_at: "2026-10-01T01:00:00Z" });
    const newer = session(DREAM, { cwd: "/srv/new", last_input_at: "2026-10-02T00:00:00Z" });
    const twin = session(DREAM, { cwd: "/srv/old", last_input_at: "2026-09-30T00:00:00Z" });
    const exited = session(DREAM, { cwd: "/srv/gone", status: "exited" });
    const elsewhere = session(MAC, { cwd: "/Users/me" });
    expect(hostFolders([older, newer, twin, exited, elsewhere], DREAM)).toEqual([
      { cwd: "/srv/new", windows: 1 },
      { cwd: "/srv/old", windows: 2 },
      { cwd: "~", windows: 0 },
    ]);
  });

  test("a folder says how many windows run in it; home with none says Home", () => {
    expect(folderSubtitle({ cwd: "/srv/app", windows: 1 })).toBe("1 window here");
    expect(folderSubtitle({ cwd: "/srv/app", windows: 3 })).toBe("3 windows here");
    expect(folderSubtitle({ cwd: "~", windows: 0 })).toBe("Home");
  });

  test("a window open in home stands for home", () => {
    const home = session(MAC, { cwd: "/Users/me" });
    expect(hostFolders([home], MAC)).toEqual([{ cwd: "/Users/me", windows: 1 }]);
    expect(hostFolders([], MAC)).toEqual([{ cwd: "~", windows: 0 }]);
  });

  test("sessions sit under their workspaces, in the sidebar's order, strays last", () => {
    const a = session(DREAM);
    const b = session(DREAM, { activity_state: "waiting" });
    const c = session(DREAM);
    const stray = session(DREAM);
    const groups = groupHostSessions(
      [a, b, c, stray],
      [workspace(PLAY, "play", [c.id]), workspace(WORK, "work", [a.id, b.id])],
    );
    expect(groups.map((group) => group.workspace?.name ?? null)).toEqual(["play", "work", null]);
    expect(groups[1]?.sessions.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(groups[2]?.sessions.map((item) => item.id)).toEqual([stray.id]);
  });

  test("a window in an archived workspace is still in a workspace, listed after the open ones", () => {
    const kept = session(DREAM);
    const shelved = session(DREAM);
    const stray = session(DREAM);
    const groups = groupHostSessions(
      [stray, shelved, kept],
      [
        workspace(PLAY, "play", [shelved.id], "2026-10-02T00:00:00Z"),
        workspace(WORK, "work", [kept.id]),
      ],
    );
    expect(groups.map(hostSessionGroupTitle)).toEqual([
      "work",
      "play · archived",
      "Not in a workspace",
    ]);
    expect(groups[1]?.sessions.map((item) => item.id)).toEqual([shelved.id]);
    expect(groups[2]?.sessions.map((item) => item.id)).toEqual([stray.id]);
  });
});

describe("possessedLabel", () => {
  test("reads a zone-less server timestamp as UTC", () => {
    expect(serverInstant("2026-09-14T23:30:00")).toBe(Date.UTC(2026, 8, 14, 23, 30));
    expect(serverInstant("2026-09-14T23:30:00Z")).toBe(Date.UTC(2026, 8, 14, 23, 30));
    expect(serverInstant("2026-09-14T23:30:00+00:00")).toBe(Date.UTC(2026, 8, 14, 23, 30));
    expect(serverInstant(null)).toBeNull();
    expect(serverInstant("not a date")).toBeNull();
  });

  test("says the day, or nothing when an older server did not", () => {
    expect(possessedLabel("2026-09-14T12:00:00Z", "en-US")).toBe("Possessed September 14, 2026");
    expect(possessedLabel(null)).toBeNull();
  });
});
