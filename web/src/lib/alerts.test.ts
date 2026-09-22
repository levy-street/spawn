import { describe, expect, test } from "bun:test";
import type { Session } from "@/lib/api";
import type { AlertEvent } from "./alerts";
import { alertBody, alertKey, alertTitle, alertToastMessage, parseAlertFrame } from "./alerts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "0f9b2c69-8f5e-4d7a-9c3b-1a2b3c4d5e6f",
    name: null,
    host_id: "11111111-2222-4333-8444-555555555555",
    host_name: "laptop",
    cwd: "/Users/me/projects/spawn",
    status: "running",
    started_at: "2026-08-21T00:00:00Z",
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

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    event: "agent.finished",
    session_id: "0f9b2c69-8f5e-4d7a-9c3b-1a2b3c4d5e6f",
    command: "claude",
    exit_code: null,
    signal: null,
    at: "2026-08-21T10:00:00+00:00",
    ...overrides,
  };
}

describe("parseAlertFrame", () => {
  test("accepts a well-formed alert", () => {
    const frame = parseAlertFrame(
      JSON.stringify({
        type: "alert",
        event: "agent.finished",
        session_id: "abc",
        command: "claude",
        at: "2026-08-21T10:00:00+00:00",
      }),
    );
    expect(frame).toEqual({
      type: "alert",
      event: "agent.finished",
      session_id: "abc",
      command: "claude",
      exit_code: null,
      signal: null,
      at: "2026-08-21T10:00:00+00:00",
    });
  });

  test("carries exit detail on a death", () => {
    const frame = parseAlertFrame(
      JSON.stringify({
        type: "alert",
        event: "session.died",
        session_id: "abc",
        command: null,
        exit_code: 137,
        signal: "KILL",
        at: "2026-08-21T10:00:00+00:00",
      }),
    );
    expect(frame).toMatchObject({ event: "session.died", exit_code: 137, signal: "KILL" });
  });

  test("accepts a device-approval knock and its answer", () => {
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "trust",
          event: "device.approval_requested",
          request_id: "req-1",
          browser_device_id: "dev-1",
          label: "iPhone",
          fingerprint: "SHA256:abcdefghijklmnop",
          at: "2026-08-23T00:00:00+00:00",
        }),
      ),
    ).toEqual({
      type: "trust",
      event: "device.approval_requested",
      request_id: "req-1",
      browser_device_id: "dev-1",
      label: "iPhone",
      fingerprint: "SHA256:abcdefghijklmnop",
      status: null,
      at: "2026-08-23T00:00:00+00:00",
    });
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "trust",
          event: "device.approval_resolved",
          request_id: "req-1",
          browser_device_id: "dev-1",
          status: "approved",
        }),
      ),
    ).toMatchObject({ event: "device.approval_resolved", status: "approved" });
  });

  test("accepts a host approval that the daemon could not adopt", () => {
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "trust",
          event: "host.pin_undelivered",
          host_id: "host-id",
          browser_device_id: "browser-device-id",
          reason: "invalid_chain",
          at: "2026-08-25T00:00:00Z",
        }),
      ),
    ).toEqual({
      type: "trust",
      event: "host.pin_undelivered",
      host_id: "host-id",
      browser_device_id: "browser-device-id",
      reason: "invalid_chain",
      at: "2026-08-25T00:00:00Z",
    });
  });

  test("rejects a trust frame this build cannot act on", () => {
    const rejected = [
      JSON.stringify({
        type: "trust",
        event: "device.seized",
        request_id: "r",
        browser_device_id: "d",
      }),
      JSON.stringify({ type: "trust", event: "device.approval_requested", request_id: "" }),
      JSON.stringify({ type: "trust", event: "device.approval_requested", request_id: "r" }),
    ];
    for (const raw of rejected) expect(parseAlertFrame(raw)).toBeNull();
    // An unknown status normalizes away rather than reaching a consumer that
    // would have to guess what it meant.
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "trust",
          event: "device.approval_resolved",
          request_id: "r",
          browser_device_id: "d",
          status: "elevated",
        }),
      ),
    ).toMatchObject({ status: null });
  });

  test("recognizes the keepalive", () => {
    expect(parseAlertFrame(JSON.stringify({ type: "alerts.ping" }))).toEqual({
      type: "alerts.ping",
    });
  });

  test("accepts a data-changed frame, detail and collection alike", () => {
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "data",
          resource: "workspaces",
          id: "w-1",
          origin: "tab-1",
          at: "2026-08-31T00:00:00Z",
        }),
      ),
    ).toEqual({
      type: "data",
      resource: "workspaces",
      id: "w-1",
      origin: "tab-1",
      at: "2026-08-31T00:00:00Z",
    });
    // A collection change carries no id and no origin (a daemon wrote it).
    expect(
      parseAlertFrame(JSON.stringify({ type: "data", resource: "sessions", id: null })),
    ).toMatchObject({ type: "data", resource: "sessions", id: null, origin: null });
  });

  test("rejects a data frame that could not drive an invalidation", () => {
    const rejected = [
      JSON.stringify({ type: "data" }),
      JSON.stringify({ type: "data", resource: "" }),
      JSON.stringify({ type: "data", resource: 7 }),
      JSON.stringify({ type: "data", resource: "x".repeat(65) }),
      JSON.stringify({ type: "data", resource: "workspaces", id: 9 }),
      JSON.stringify({ type: "data", resource: "workspaces", origin: "x".repeat(65) }),
    ];
    for (const raw of rejected) expect(parseAlertFrame(raw)).toBeNull();
  });

  test("rejects malformed, unknown, and hostile frames without throwing", () => {
    const rejected = [
      "not json",
      "null",
      '"a string"',
      JSON.stringify({ type: "alert" }),
      // An event class this build does not know is a future server talking.
      JSON.stringify({ type: "alert", event: "agent.gave_up", session_id: "a", at: "" }),
      JSON.stringify({ type: "alert", event: "agent.finished", session_id: "", at: "" }),
      JSON.stringify({ type: "alert", event: "agent.finished", at: "" }),
      JSON.stringify({ type: "alert", event: "agent.finished", session_id: "a", command: 7 }),
      JSON.stringify({ type: "session.exit" }),
    ];
    for (const raw of rejected) {
      expect(parseAlertFrame(raw)).toBeNull();
    }
  });

  test("a missing command normalizes to null rather than undefined", () => {
    const frame = parseAlertFrame(
      JSON.stringify({ type: "alert", event: "session.died", session_id: "a", at: "t" }),
    );
    expect(frame).toMatchObject({ command: null });
  });
});

describe("alertKey", () => {
  test("is stable for one event across tabs", () => {
    expect(alertKey(makeEvent())).toBe(
      "agent.finished:0f9b2c69-8f5e-4d7a-9c3b-1a2b3c4d5e6f:2026-08-21T10:00:00+00:00",
    );
  });

  test("separates two runs of the same agent in the same session", () => {
    const first = makeEvent({ at: "2026-08-21T10:00:00+00:00" });
    const second = makeEvent({ at: "2026-08-21T10:04:00+00:00" });
    expect(alertKey(first)).not.toBe(alertKey(second));
  });

  test("separates a finish from a death", () => {
    expect(alertKey(makeEvent())).not.toBe(alertKey(makeEvent({ event: "session.died" })));
  });
});

describe("alertTitle", () => {
  test("names a known agent by its brand name", () => {
    expect(alertTitle(makeEvent())).toBe("Claude Code finished");
  });

  test("the brand name beats a slug-shaped built-in definition name", () => {
    // `agents_builtin.py` names these "claude-code" / "aider-sonnet"; a toast
    // saying "claude-code is waiting for you" reads like a log line.
    const agents = [{ command: "claude", name: "claude-code" }];
    expect(alertTitle(makeEvent(), agents)).toBe("Claude Code finished");
  });

  test("a custom agent with no brand falls back to the name its owner gave it", () => {
    const agents = [{ command: "FOO=1 /usr/local/bin/tinker", name: "Tinker" }];
    expect(alertTitle(makeEvent({ command: "tinker" }), agents)).toBe("Tinker finished");
  });

  test("an unknown command with no definition still reads as itself", () => {
    expect(alertTitle(makeEvent({ command: "rustc" }))).toBe("rustc finished");
  });

  test("distinguishes an exit from a kill", () => {
    expect(alertTitle(makeEvent({ event: "session.died", command: null }))).toBe("Session exited");
    expect(alertTitle(makeEvent({ event: "session.died", command: null, signal: "TERM" }))).toBe(
      "Session was killed",
    );
  });

  test("an idle agent is waiting, not finished — it is still running", () => {
    expect(alertTitle(makeEvent({ event: "agent.awaiting_input" }))).toBe(
      "Claude Code is waiting for you",
    );
  });

  test("still names the agent that went down with the session", () => {
    expect(alertTitle(makeEvent({ event: "session.died" }))).toBe("Claude Code exited");
  });
});

describe("alertBody", () => {
  test("names the workspace, then the window", () => {
    expect(alertBody(makeEvent(), makeSession({ name: "build box" }), "Spawnd")).toBe(
      "Spawnd · build box · spawn",
    );
  });

  test("drops the folder when the window name already says it", () => {
    // The default session name is "<host> - <folder>", so appending the folder
    // again is what produced "Laptop - spawn · Laptop · spawn".
    expect(alertBody(makeEvent(), makeSession({ name: "Laptop - spawn" }), "Spawnd")).toBe(
      "Spawnd · Laptop - spawn",
    );
  });

  test("drops the workspace when it is just the window name again", () => {
    expect(alertBody(makeEvent(), makeSession({ name: "spawn" }), "spawn")).toBe("spawn");
  });

  test("works with no workspace known", () => {
    expect(alertBody(makeEvent(), makeSession({ name: "build box" }))).toBe("build box · spawn");
  });

  test("degrades to a short id when the session row is not cached", () => {
    expect(alertBody(makeEvent(), undefined)).toBe("Session 0f9b2c69");
  });

  test("appends the exit code on a death", () => {
    expect(
      alertBody(makeEvent({ event: "session.died", exit_code: 137 }), makeSession({ name: "api" })),
    ).toBe("api · spawn · exit 137");
  });

  test("appends the signal on a kill", () => {
    expect(
      alertBody(makeEvent({ event: "session.died", signal: "TERM" }), makeSession({ name: "api" })),
    ).toBe("api · spawn · TERM");
  });
});

describe("alertToastMessage", () => {
  test("reads as one line", () => {
    expect(alertToastMessage(makeEvent(), makeSession({ name: "api" }), [], "Spawnd")).toBe(
      "Claude Code finished — Spawnd · api · spawn",
    );
  });
});
