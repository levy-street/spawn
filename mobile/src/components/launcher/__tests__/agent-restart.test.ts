import { makeAgent } from "@/components/launcher/__tests__/fixtures";
import {
  AGENT_RESTART_ATTEMPTS,
  type AgentRestartHandoff,
  planAgentRestart,
  restartSessionAgent,
} from "@/components/launcher/agent-restart";
import type { Session } from "@/data/types/domain";

const claude = makeAgent({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude Code",
  kind: "claude-code",
  command: "claude",
});
const hermes = makeAgent({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Hermes",
  kind: "hermes",
  command: "hermes",
});

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
  };
}

const terminal = { sendInput: jest.fn(), focus: jest.fn() };

function pendingStore() {
  const queued = new Map<string, string>();
  return {
    queued,
    persist: jest.fn(async (sessionId: string, command: string) => {
      queued.set(sessionId, command);
      return { sessionId, command, createdAt: 0, expiresAt: 0 };
    }),
    clear: jest.fn(async (sessionId: string) => {
      queued.delete(sessionId);
    }),
  };
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
  test("hands the agent's own shell the resume command when it can", async () => {
    const handoff = jest.fn<ReturnType<AgentRestartHandoff>, Parameters<AgentRestartHandoff>>(
      async () => "sent",
    );
    const restart = jest.fn(async () => session());
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      terminal,
      restart,
      pending,
      getSession: async () => session(),
      handoff,
    });
    expect(result.kind).toBe("resumed");
    expect(restart).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]?.[0]).toMatchObject({
      command: "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
      attempts: AGENT_RESTART_ATTEMPTS,
    });
    expect(pending.persist).not.toHaveBeenCalled();
  });

  test("starts a fresh shell with the command queued when the agent will not quit", async () => {
    const handoff = jest.fn(async () => "busy" as const);
    const restart = jest.fn(async () => session({ status: "starting" }));
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      terminal,
      restart,
      pending,
      getSession: async () => session(),
      handoff,
    });
    expect(result.kind).toBe("restarted");
    expect(restart).toHaveBeenCalledWith(session().id);
    expect(pending.queued.get(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
  });

  test("a restart asked for without a terminal goes straight to a fresh shell", async () => {
    const handoff = jest.fn(async () => "sent" as const);
    const restart = jest.fn(async () => session({ status: "starting" }));
    const pending = pendingStore();
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      terminal: null,
      restart,
      pending,
      getSession: async () => session(),
      handoff,
    });
    expect(handoff).not.toHaveBeenCalled();
    expect(pending.queued.get(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
    expect(restart).toHaveBeenCalledTimes(1);
  });

  test("a restart the server refused leaves nothing queued", async () => {
    const pending = pendingStore();
    await expect(
      restartSessionAgent({
        session: session({ status: "exited" }),
        agents: [claude],
        terminal,
        restart: async () => {
          throw new Error("host daemon is offline");
        },
        pending,
        getSession: async () => session(),
        handoff: async () => "busy" as const,
      }),
    ).rejects.toThrow("host daemon is offline");
    expect(pending.clear).toHaveBeenCalledWith(session().id);
    expect(pending.queued.size).toBe(0);
  });

  test("a shell window restarts without touching the queue", async () => {
    const handoff = jest.fn(async () => "sent" as const);
    const restart = jest.fn(async () => session({ status: "starting" }));
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      terminal,
      restart,
      pending,
      getSession: async () => session(),
      handoff,
    });
    expect(result).toEqual({ kind: "restarted", plan: { kind: "shell" } });
    expect(handoff).not.toHaveBeenCalled();
    expect(pending.persist).not.toHaveBeenCalled();
  });
});
