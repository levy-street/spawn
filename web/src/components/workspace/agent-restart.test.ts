import { describe, expect, mock, test } from "bun:test";
import {
  ConversationElsewhereError,
  conversationElsewhereMessage,
  planAgentRestart,
  restartConversation,
  restartSessionAgent,
} from "@/components/workspace/agent-restart";
import { pendingLaunch } from "@/components/workspace/pending-launch";
import type { Agent, Session } from "@/lib/api";
import type { ConversationInspection } from "@/lib/conversation";

const claude: Agent = {
  id: "11111111-1111-4111-8111-111111111111",
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
const hermes: Agent = {
  ...claude,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Hermes",
  kind: "hermes",
  command: "hermes",
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: null,
    host_id: "44444444-4444-4444-8444-444444444444",
    host_name: "box",
    cwd: "/repo",
    status: "running",
    started_at: "2026-09-22T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "idle",
    activity_label: "Idle",
    foreground_command: "claude",
    agent_id: claude.id,
    agent_session_id: "3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    ...overrides,
  } as Session;
}

describe("planAgentRestart", () => {
  test("a Claude Code window comes back into its recorded conversation", () => {
    expect(planAgentRestart(session(), [claude])).toEqual({
      kind: "agent",
      agent: claude,
      command: "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
      resumes: true,
    });
  });

  test("a window whose conversation was never recorded continues the latest one", () => {
    const plan = planAgentRestart(session({ agent_session_id: null }), [claude]);
    expect(plan.kind === "agent" ? plan.command : null).toBe("claude --continue");
  });

  test("an agent with no way to resume is relaunched plainly, and says so", () => {
    expect(
      planAgentRestart(session({ agent_id: hermes.id, foreground_command: "python3" }), [
        claude,
        hermes,
      ]),
    ).toEqual({ kind: "agent", agent: hermes, command: "hermes", resumes: false });
  });

  test("a bare shell window is just a shell", () => {
    expect(
      planAgentRestart(session({ agent_id: null, foreground_command: "zsh" }), [claude]),
    ).toEqual({ kind: "shell" });
  });
});

describe("restartSessionAgent", () => {
  test("restarts the session with the resume command queued for the fresh shell", async () => {
    const restart = mock(async () => session({ status: "starting" }));
    const result = await restartSessionAgent({ session: session(), agents: [claude], restart });
    expect(result.plan.kind).toBe("agent");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(pendingLaunch.take(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
  });

  test("queues before restarting, so the new shell cannot open ahead of its command", async () => {
    const seen = { queuedAtRestart: null as boolean | null };
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => {
        seen.queuedAtRestart = pendingLaunch.has(session().id);
        return session({ status: "starting" });
      },
    });
    expect(seen.queuedAtRestart).toBe(true);
    pendingLaunch.clear(session().id);
  });

  test("a restart the server refused leaves nothing queued", async () => {
    await expect(
      restartSessionAgent({
        session: session({ status: "exited" }),
        agents: [claude],
        restart: async () => {
          throw new Error("host daemon is offline");
        },
      }),
    ).rejects.toThrow("host daemon is offline");
    expect(pendingLaunch.has(session().id)).toBe(false);
  });

  test("a shell window restarts without touching the queue", async () => {
    const restart = mock(async () => session({ status: "starting" }));
    const result = await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      restart,
    });
    expect(result).toEqual({ plan: { kind: "shell" } });
    expect(pendingLaunch.has(session().id)).toBe(false);
  });
});

const recorded = "3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10";
const moved = "4e0b4642-0972-40ac-9a18-61d542276b76";

function live(overrides: Partial<ConversationInspection> = {}): ConversationInspection {
  return {
    agent: "claude-code",
    conversation_id: moved,
    state: "idle",
    cli_version: "2.1.288",
    live_elsewhere: false,
    source: "registry",
    ...overrides,
  };
}

describe("restartConversation", () => {
  test("the host's answer wins over the recorded id", () => {
    expect(restartConversation(claude, session(), live())).toBe(moved);
  });

  test("without an answer, or with one about another program, the recorded id stands", () => {
    expect(restartConversation(claude, session(), null)).toBe(recorded);
    expect(restartConversation(claude, session(), live({ agent: "codex" }))).toBe(recorded);
    expect(restartConversation(claude, session(), live({ agent: null }))).toBe(recorded);
    expect(restartConversation(claude, session(), live({ conversation_id: null }))).toBe(recorded);
  });

  test("a conversation held outside the window is refused, naming its host", () => {
    expect(() =>
      restartConversation(claude, session(), live({ live_elsewhere: true, conversation_id: null })),
    ).toThrow("This conversation is running in the background on box. Stop it there first.");
    expect(() =>
      restartConversation(claude, session({ host_name: null }), live({ live_elsewhere: true })),
    ).toThrow(ConversationElsewhereError);
    expect(conversationElsewhereMessage("dream")).toBe(
      "This conversation is running in the background on dream. Stop it there first.",
    );
  });
});

describe("restartSessionAgent with the host's answer", () => {
  test("resumes the conversation the window is in, and writes it back first", async () => {
    const order: string[] = [];
    const restart = mock(async () => {
      order.push("restart");
      return session({ status: "starting" });
    });
    const recordConversation = mock(async (id: string) => {
      order.push(`record ${id}`);
    });
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart,
      inspect: async () => live(),
      recordConversation,
    });
    expect(result.plan).toEqual({
      kind: "agent",
      agent: claude,
      command: `claude --resume ${moved}`,
      resumes: true,
    });
    expect(order).toEqual([`record ${moved}`, "restart"]);
    expect(pendingLaunch.take(session().id)).toBe(`claude --resume ${moved}`);
  });

  test("an unchanged conversation is not written back", async () => {
    const recordConversation = mock(async () => undefined);
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      inspect: async () => live({ conversation_id: recorded }),
      recordConversation,
    });
    expect(recordConversation).not.toHaveBeenCalled();
    pendingLaunch.clear(session().id);
  });

  test("a host that cannot answer, or a write-back that fails, still restarts as before", async () => {
    for (const inspect of [async () => null, async () => Promise.reject(new Error("offline"))]) {
      await restartSessionAgent({
        session: session(),
        agents: [claude],
        restart: async () => session({ status: "starting" }),
        inspect,
      });
      expect(pendingLaunch.take(session().id)).toBe(`claude --resume ${recorded}`);
    }
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      inspect: async () => live(),
      recordConversation: async () => Promise.reject(new Error("server down")),
    });
    expect(pendingLaunch.take(session().id)).toBe(`claude --resume ${moved}`);
  });

  test("refuses before restarting anything while the conversation is held elsewhere", async () => {
    const restart = mock(async () => session({ status: "starting" }));
    await expect(
      restartSessionAgent({
        session: session(),
        agents: [claude],
        restart,
        inspect: async () => live({ live_elsewhere: true, source: "parked" }),
      }),
    ).rejects.toBeInstanceOf(ConversationElsewhereError);
    expect(restart).not.toHaveBeenCalled();
    expect(pendingLaunch.has(session().id)).toBe(false);
  });

  test("a shell window never asks the host", async () => {
    const inspect = mock(async () => live());
    await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      inspect,
    });
    expect(inspect).not.toHaveBeenCalled();
  });
});
