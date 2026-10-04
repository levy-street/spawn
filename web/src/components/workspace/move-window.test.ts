import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { incarnationKey, openIntent } from "@/components/terminal/incarnation";
import { type Agent, ApiError, type Session } from "@/lib/api";
import { moveWindow, moveWindowConfirmation, moveWindowError } from "./move-window";
import { pendingLaunch } from "./pending-launch";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

// The phone's move-window tests hold the same strings: a change here is a
// change there, in the same commit.
describe("moveWindowConfirmation", () => {
  test("says an agent window's conversation starts fresh on the new host", () => {
    assert.deepEqual(
      moveWindowConfirmation({
        title: "builder",
        hostName: "mac",
        cwd: "/Users/me/code/spawn",
        agent: true,
      }),
      {
        title: "Move builder to mac?",
        body: "The window moves to ~/code/spawn on mac, and what runs in it here stops. Its agent starts a new conversation there.",
        confirmLabel: "Move window",
      },
    );
  });

  test("says a shell window starts a new shell", () => {
    assert.equal(
      moveWindowConfirmation({
        title: "spawn · Shell",
        hostName: "dream",
        cwd: "/srv",
        agent: false,
      }).body,
      "The window moves to /srv on dream, and what runs in it here stops. A new shell starts there.",
    );
  });
});

describe("moveWindowError", () => {
  const refused = (status: number, detail: string) =>
    new ApiError(status, `http_${status}`, detail, detail);

  test("names the cases a person can act on", () => {
    assert.equal(
      moveWindowError(refused(409, "move_conflict"), "mac"),
      "This window was moved from another device in the meantime, so it was left where it is now.",
    );
    assert.equal(
      moveWindowError(refused(409, "target_offline"), "mac"),
      "mac is offline, so the window stayed where it was.",
    );
    assert.equal(
      moveWindowError(refused(400, "same_host"), "mac"),
      "This window already runs on mac.",
    );
  });

  test("passes anything else through as it was said", () => {
    assert.equal(
      moveWindowError(refused(409, "move_in_progress"), "mac"),
      "This window is moving to another host. Finish or cancel the move first.",
    );
    assert.equal(
      moveWindowError(refused(409, "workspace_archived"), "mac"),
      "This window's workspace is archived. Restore it first.",
    );
    assert.equal(moveWindowError(refused(404, "host not found"), "mac"), "host not found");
    assert.equal(moveWindowError(new Error("Failed to fetch"), "mac"), "Failed to fetch");
  });
});

describe("moveWindow", () => {
  const DREAM = "22222222-2222-4222-8222-222222222222";
  const MAC = "33333333-3333-4333-8333-333333333333";
  const claude: Agent = {
    id: "44444444-4444-4444-8444-444444444444",
    owner_user_id: null,
    name: "Claude Code",
    kind: "claude-code",
    command: "claude",
    env: {},
    install: null,
    yolo_args: "--dangerously-skip-permissions",
    yolo_env: {},
    yolo: false,
  };

  function row(id: string, hostId: string, overrides: Partial<Session> = {}): Session {
    return {
      id,
      name: null,
      host_id: hostId,
      host_name: null,
      cwd: "/repo",
      status: "running",
      started_at: "2026-10-03T00:00:00Z",
      exited_at: null,
      exit_code: null,
      last_output_at: null,
      last_input_at: null,
      last_activity_at: null,
      activity_state: "quiet",
      activity_label: "Quiet",
      // Typed into a shell by hand: nothing recorded it as an agent.
      foreground_command: "claude",
      agent_id: null,
      agent_session_id: null,
      ...overrides,
    };
  }

  function seeded(session: Session): QueryClient {
    const client = new QueryClient();
    client.setQueryData(["session", session.id], session);
    client.setQueryData(["sessions"], [session]);
    return client;
  }

  test("marks this tab's intent before the request leaves, so hearing of the move first still takes control", async () => {
    const session = row("55555555-5555-4555-8555-555555555555", DREAM);
    const key = incarnationKey(session.id, MAC);
    const seen = { intentAtRequest: false, body: null as unknown };
    const moved = await moveWindow({
      queryClient: seeded(session),
      session,
      host: { id: MAC },
      cwd: "/work",
      agent: claude,
      move: async (_id, body) => {
        // A list poll answered after the server's commit can remount this
        // tab's terminal on mac now, before the response below arrives.
        seen.intentAtRequest = openIntent.has(key);
        seen.body = body;
        return row(session.id, MAC, { cwd: "/work", agent_id: claude.id });
      },
    });
    assert.equal(seen.intentAtRequest, true);
    assert.equal(moved.host_id, MAC);
    openIntent.clear(key);
    pendingLaunch.clear(session.id);
  });

  test("types the window as the agent it starts there, and queues that launch for the new host only", async () => {
    const session = row("66666666-6666-4666-8666-666666666666", DREAM);
    const client = seeded(session);
    const bodies: Record<string, unknown>[] = [];
    await moveWindow({
      queryClient: client,
      session,
      host: { id: MAC },
      cwd: "/work",
      agent: claude,
      move: async (_id, body) => {
        bodies.push(body);
        // Nothing is queued while the old host's shell is still the window's.
        assert.equal(pendingLaunch.has(session.id, DREAM), false);
        assert.equal(pendingLaunch.has(session.id, MAC), false);
        return row(session.id, MAC, { cwd: "/work", agent_id: claude.id });
      },
    });
    const body = bodies[0] as { agent_id?: string; agent_session_id?: string | null };
    assert.equal(body.agent_id, claude.id);
    assert.match(String(body.agent_session_id), /^[0-9a-f-]{36}$/);
    const command = pendingLaunch.take(session.id, MAC);
    assert.equal(command, `claude --session-id ${body.agent_session_id}`);
    // Both caches name the new host, so the pane's terminal follows it there.
    assert.equal(client.getQueryData<Session>(["session", session.id])?.host_id, MAC);
    assert.equal(client.getQueryData<Session[]>(["sessions"])?.[0]?.host_id, MAC);
    openIntent.clear(incarnationKey(session.id, MAC));
  });

  test("a record holding a flag is not carried: the agent starts there under a new UUID", async () => {
    const session = row("99999999-9999-4999-8999-999999999999", DREAM, {
      agent_id: claude.id,
      agent_session_id: "--dangerously-skip-permissions",
    });
    const bodies: Record<string, unknown>[] = [];
    await moveWindow({
      queryClient: seeded(session),
      session,
      host: { id: MAC },
      cwd: "/work",
      agent: claude,
      move: async (_id, body) => {
        bodies.push(body);
        return row(session.id, MAC, { cwd: "/work", agent_id: claude.id });
      },
    });
    const conversation = String((bodies[0] as { agent_session_id?: unknown }).agent_session_id);
    assert.match(conversation, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(pendingLaunch.take(session.id, MAC), `claude --session-id ${conversation}`);
    openIntent.clear(incarnationKey(session.id, MAC));
  });

  test("a shell moves as a shell", async () => {
    const session = row("77777777-7777-4777-8777-777777777777", DREAM, {
      foreground_command: "zsh",
    });
    const bodies: Record<string, unknown>[] = [];
    await moveWindow({
      queryClient: seeded(session),
      session,
      host: { id: MAC },
      cwd: "/work",
      agent: null,
      move: async (_id, body) => {
        bodies.push(body);
        return row(session.id, MAC, { foreground_command: null });
      },
    });
    assert.equal("agent_id" in (bodies[0] as object), false);
    assert.equal((bodies[0] as { agent_session_id: unknown }).agent_session_id, null);
    assert.equal(pendingLaunch.has(session.id, MAC), false);
    openIntent.clear(incarnationKey(session.id, MAC));
  });

  test("a refused move leaves no intent, nothing queued, and the caches where they were", async () => {
    const session = row("88888888-8888-4888-8888-888888888888", DREAM);
    const client = seeded(session);
    await assert.rejects(
      moveWindow({
        queryClient: client,
        session,
        host: { id: MAC },
        cwd: "/work",
        agent: claude,
        move: async () => {
          throw new ApiError(409, "http_409", "move_conflict", "move_conflict");
        },
      }),
      (error: unknown) => moveWindowError(error, "mac").startsWith("This window was moved"),
    );
    assert.equal(openIntent.has(incarnationKey(session.id, MAC)), false);
    assert.equal(pendingLaunch.has(session.id, MAC), false);
    assert.equal(client.getQueryData<Session>(["session", session.id])?.host_id, DREAM);
  });
});
