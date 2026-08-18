import { describe, expect, test } from "bun:test";

import type { Session } from "@/lib/api";
import {
  isShellCommand,
  relativeTime,
  sessionActivityDetail,
  sessionActivityLabel,
  sessionActivityTone,
  sessionAtShell,
  sessionNeedsAttention,
  sessionTitle,
} from "./sessions";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "0f9b2c69-8f5e-4d7a-9c3b-1a2b3c4d5e6f",
    name: null,
    host_id: "11111111-2222-4333-8444-555555555555",
    host_name: "laptop",
    cwd: "/Users/me/projects/spawn",
    status: "running",
    started_at: "2026-08-19T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "unknown",
    activity_label: "Unknown",
    foreground_command: null,
    ...overrides,
  };
}

describe("sessionTitle", () => {
  test("prefers the explicit name", () => {
    expect(sessionTitle(makeSession({ name: "  build box  " }))).toBe("build box");
  });

  test("derives host - folder from the cwd", () => {
    expect(sessionTitle(makeSession())).toBe("laptop - spawn");
    expect(sessionTitle(makeSession({ cwd: "/Users/me/projects/spawn/" }))).toBe("laptop - spawn");
    expect(sessionTitle(makeSession({ cwd: "C:\\Users\\me\\dev" }))).toBe("laptop - dev");
  });

  test("falls back to the folder, then a short id, without a host name", () => {
    expect(sessionTitle(makeSession({ host_name: null }))).toBe("spawn");
    expect(sessionTitle(makeSession({ host_name: null, cwd: "" }))).toBe("0f9b2c69");
  });
});

describe("activity derivation", () => {
  test("label falls back to the uppercase status", () => {
    expect(sessionActivityLabel(makeSession({ activity_label: "" }))).toBe("RUNNING");
    expect(sessionActivityLabel(makeSession({ activity_label: "Working" }))).toBe("Working");
  });

  test("detail appends a relative age when known", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(
      sessionActivityDetail(makeSession({ activity_label: "Working", last_activity_at: recent })),
    ).toBe("Working · 30s ago");
    expect(sessionActivityDetail(makeSession({ activity_label: "Working" }))).toBe("Working");
  });

  test("tone maps activity states onto the --tone-* palette", () => {
    expect(sessionActivityTone(makeSession({ activity_state: "active" }))).toBe("active");
    expect(sessionActivityTone(makeSession({ activity_state: "waiting" }))).toBe("waiting");
    expect(sessionActivityTone(makeSession({ activity_state: "input_sent" }))).toBe("waiting");
    expect(sessionActivityTone(makeSession({ activity_state: "starting" }))).toBe("waiting");
    expect(sessionActivityTone(makeSession({ activity_state: "quiet" }))).toBe("idle");
    expect(sessionActivityTone(makeSession({ activity_state: "unknown" }))).toBe("idle");
    expect(sessionActivityTone(makeSession({ activity_state: "exited", status: "exited" }))).toBe(
      "offline",
    );
  });
});

describe("relativeTime", () => {
  test("buckets ages and rejects garbage", () => {
    expect(relativeTime(null)).toBeNull();
    expect(relativeTime("not-a-date")).toBeNull();
    expect(relativeTime(new Date().toISOString())).toBe("now");
    expect(relativeTime(new Date(Date.now() - 90_000).toISOString())).toBe("1m ago");
    expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3h ago");
    expect(relativeTime(new Date(Date.now() - 49 * 3600_000).toISOString())).toBe("2d ago");
  });
});

describe("sessionNeedsAttention", () => {
  test("dead beats waiting; running-quiet needs nothing", () => {
    expect(sessionNeedsAttention(makeSession({ status: "exited" }))).toBe("dead");
    expect(sessionNeedsAttention(makeSession({ status: "killed" }))).toBe("dead");
    expect(sessionNeedsAttention(makeSession({ activity_state: "waiting" }))).toBe("waiting");
    expect(
      sessionNeedsAttention(makeSession({ status: "exited", activity_state: "waiting" })),
    ).toBe("dead");
    expect(sessionNeedsAttention(makeSession({ activity_state: "quiet" }))).toBeNull();
  });
});

describe("isShellCommand", () => {
  test("matches the shell family, including login-shell dashes", () => {
    for (const shell of ["bash", "zsh", "fish", "sh", "dash"]) {
      expect(isShellCommand(shell)).toBe(true);
      expect(isShellCommand(`-${shell}`)).toBe(true);
      expect(isShellCommand(shell.toUpperCase())).toBe(true);
    }
  });

  test("rejects agents, null, and lookalikes", () => {
    expect(isShellCommand(null)).toBe(false);
    expect(isShellCommand(undefined)).toBe(false);
    expect(isShellCommand("")).toBe(false);
    expect(isShellCommand("claude")).toBe(false);
    expect(isShellCommand("bashful")).toBe(false);
    expect(isShellCommand("ssh")).toBe(false);
    expect(isShellCommand("-")).toBe(false);
  });
});

describe("sessionAtShell", () => {
  test("null foreground (old worker) counts as a shell prompt", () => {
    expect(sessionAtShell(makeSession({ foreground_command: null }))).toBe(true);
    expect(sessionAtShell(makeSession({ foreground_command: "-zsh" }))).toBe(true);
    expect(sessionAtShell(makeSession({ foreground_command: "claude" }))).toBe(false);
  });
});
