import { describe, expect, test } from "bun:test";

import type { Session, Workspace } from "@/lib/api";
import type { Tile } from "@/lib/grid";
import {
  defaultWorkspaceName,
  workspaceAttentionCount,
  workspaceRecency,
  workspaceSessionIds,
  workspaceTileCount,
} from "./workspaces";

const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";
const S3 = "00000000-0000-4000-8000-000000000003";

function makeWorkspace(tiles: Tile[], overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    name: "Workspace 1",
    layout: { version: 2, tiles },
    position: 0,
    created_at: "2026-08-19T00:00:00Z",
    updated_at: "2026-08-19T00:00:00Z",
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: null,
    host_id: "11111111-2222-4333-8444-555555555555",
    host_name: "laptop",
    cwd: "/home/me",
    status: "running",
    started_at: "2026-08-19T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: null,
    ...overrides,
  };
}

describe("defaultWorkspaceName", () => {
  test("fills the first unused Workspace N", () => {
    expect(defaultWorkspaceName([])).toBe("Workspace 1");
    expect(defaultWorkspaceName([makeWorkspace([], { name: "Workspace 1" })])).toBe("Workspace 2");
    expect(
      defaultWorkspaceName([
        makeWorkspace([], { name: "Workspace 2" }),
        makeWorkspace([], { name: "custom" }),
      ]),
    ).toBe("Workspace 3");
  });
});

describe("workspaceSessionIds", () => {
  test("returns tile session ids in reading order", () => {
    const workspace = makeWorkspace([
      { session_id: S3, x: 0, y: 6, w: 12, h: 6 },
      { session_id: S2, x: 6, y: 0, w: 6, h: 6 },
      { session_id: S1, x: 0, y: 0, w: 6, h: 6 },
    ]);
    expect(workspaceSessionIds(workspace)).toEqual([S1, S2, S3]);
    expect(workspaceTileCount(workspace)).toBe(3);
  });
});

describe("workspaceAttentionCount", () => {
  test("counts waiting and dead sessions, ignoring unknown ids", () => {
    const workspace = makeWorkspace([
      { session_id: S1, x: 0, y: 0, w: 6, h: 12 },
      { session_id: S2, x: 6, y: 0, w: 6, h: 6 },
      { session_id: S3, x: 6, y: 6, w: 6, h: 6 },
    ]);
    const sessionsById = new Map<string, Session>([
      [S1, makeSession(S1, { activity_state: "waiting" })],
      [S2, makeSession(S2, { status: "exited" })],
      // S3 unknown (still loading) — must not count or throw.
    ]);
    expect(workspaceAttentionCount(workspace, sessionsById)).toBe(2);
    expect(workspaceAttentionCount(makeWorkspace([]), sessionsById)).toBe(0);
  });
});

describe("workspaceRecency", () => {
  test("uses the newest session input, falling back to updated_at", () => {
    const workspace = makeWorkspace(
      [
        { session_id: S1, x: 0, y: 0, w: 6, h: 12 },
        { session_id: S2, x: 6, y: 0, w: 6, h: 12 },
      ],
      { updated_at: "2026-08-19T10:00:00Z" },
    );
    const newest = "2026-08-19T12:34:56Z";
    const sessionsById = new Map<string, Session>([
      [S1, makeSession(S1, { last_input_at: "2026-08-19T11:00:00Z" })],
      [S2, makeSession(S2, { last_input_at: newest })],
    ]);
    expect(workspaceRecency(workspace, sessionsById)).toBe(Date.parse(newest));
    expect(workspaceRecency(workspace, new Map())).toBe(Date.parse("2026-08-19T10:00:00Z"));
    expect(
      workspaceRecency(makeWorkspace([], { updated_at: "garbage" }), new Map()),
    ).toBe(0);
  });
});
