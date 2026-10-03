import { makeAgent } from "@/components/launcher/__tests__/fixtures";
import {
  conversationOnRecord,
  planAgentRestart,
  restartConversation,
  restartSessionAgent,
} from "@/components/launcher/agent-restart";
import type { Session } from "@/data/types/domain";
import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import type { AgentTranscriptReport } from "@/terminal/transport/types";

const claude = makeAgent({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude Code",
  kind: "claude-code",
  command: "claude",
});
const codex = makeAgent({
  id: "55555555-5555-4555-8555-555555555555",
  name: "Codex",
  kind: "codex",
  command: "codex",
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
  test("restarts the session with the resume command queued for the fresh shell", async () => {
    const restart = jest.fn(async () => session({ status: "starting" }));
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart,
      pending,
    });
    expect(result.plan.kind).toBe("agent");
    expect(restart).toHaveBeenCalledWith(session().id);
    expect(pending.queued.get(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
  });

  test("queues before restarting, so the new shell cannot open ahead of its command", async () => {
    const pending = pendingStore();
    const seen = { queuedAtRestart: null as boolean | null };
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => {
        seen.queuedAtRestart = pending.queued.has(session().id);
        return session({ status: "starting" });
      },
      pending,
    });
    expect(seen.queuedAtRestart).toBe(true);
  });

  test("a restart the server refused leaves nothing queued", async () => {
    const pending = pendingStore();
    await expect(
      restartSessionAgent({
        session: session({ status: "exited" }),
        agents: [claude],
        restart: async () => {
          throw new Error("host daemon is offline");
        },
        pending,
      }),
    ).rejects.toThrow("host daemon is offline");
    expect(pending.clear).toHaveBeenCalledWith(session().id);
    expect(pending.queued.size).toBe(0);
  });

  test("a shell window restarts without touching the queue", async () => {
    const restart = jest.fn(async () => session({ status: "starting" }));
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      restart,
      pending,
    });
    expect(result).toEqual({ plan: { kind: "shell" } });
    expect(pending.persist).not.toHaveBeenCalled();
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

/** A Codex window. Codex names its own conversations; this one's record holds
 *  an id the host once named, since left for another (`/new`). */
const staleCodex = "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09";
const liveCodex = "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a0a";
function codexSession(overrides: Partial<Session> = {}): Session {
  return session({
    agent_id: codex.id,
    foreground_command: "codex",
    agent_session_id: staleCodex,
    ...overrides,
  });
}

describe("restartConversation", () => {
  test("the host's answer wins over the recorded id", () => {
    expect(restartConversation(claude, session(), live())).toBe(moved);
  });

  test("without an answer, or with one about another program, the recorded id stands", () => {
    expect(restartConversation(claude, session(), null)).toBe(recorded);
    expect(restartConversation(claude, session(), live({ agent: "codex" }))).toBe(recorded);
    expect(restartConversation(claude, session(), live({ agent: null }))).toBe(recorded);
  });

  test("a host that answers for the agent and names no conversation is not second-guessed", () => {
    // A parked window whose background job has gone, an attach client: the
    // recorded id is the thread the window left.
    for (const source of ["parked", "attach", "process"]) {
      expect(restartConversation(claude, session(), live({ conversation_id: null, source }))).toBe(
        null,
      );
    }
  });

  test("a conversation also held outside the window is still resumed", () => {
    expect(
      restartConversation(claude, session(), live({ live_elsewhere: true, source: "parked" })),
    ).toBe(moved);
  });

  test("a Codex window never resumes a recorded id, only one the host names", () => {
    expect(restartConversation(codex, codexSession(), null)).toBeNull();
    expect(restartConversation(codex, codexSession(), live({ agent: "claude-code" }))).toBeNull();
    expect(
      restartConversation(
        codex,
        codexSession(),
        live({ agent: "codex", conversation_id: null, source: "process" }),
      ),
    ).toBeNull();
    expect(
      restartConversation(
        codex,
        codexSession(),
        live({ agent: "codex", conversation_id: liveCodex, source: "open_file" }),
      ),
    ).toBe(liveCodex);
  });
});

describe("planAgentRestart with the host's answer", () => {
  test("Codex reopens the latest conversation here unless the host names one", () => {
    const command = (plan: ReturnType<typeof planAgentRestart>) =>
      plan.kind === "agent" ? plan.command : null;
    expect(command(planAgentRestart(codexSession(), [codex]))).toBe("codex resume --last");
    expect(
      command(
        planAgentRestart(
          codexSession(),
          [codex],
          live({ agent: "codex", conversation_id: null, source: "process" }),
        ),
      ),
    ).toBe("codex resume --last");
    expect(
      command(
        planAgentRestart(
          codexSession(),
          [codex],
          live({ agent: "codex", conversation_id: liveCodex, source: "open_file" }),
        ),
      ),
    ).toBe(`codex resume ${liveCodex}`);
  });

  test("Claude Code continues the latest conversation when the host names none", () => {
    const plan = planAgentRestart(
      session(),
      [claude],
      live({ conversation_id: null, live_elsewhere: true, source: "attach" }),
    );
    expect(plan.kind === "agent" ? plan.command : null).toBe("claude --continue");
  });
});

describe("restartSessionAgent with the host's answer", () => {
  test("resumes the conversation the window is in, and writes it back first", async () => {
    const order: string[] = [];
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => {
        order.push("restart");
        return session({ status: "starting" });
      },
      pending,
      inspect: async () => live(),
      recordConversation: async (id) => {
        order.push(`record ${id}`);
      },
    });
    expect(result.plan).toEqual({
      kind: "agent",
      agent: claude,
      command: `claude --resume ${moved}`,
      resumes: true,
    });
    expect(order).toEqual([`record ${moved}`, "restart"]);
    expect(pending.queued.get(session().id)).toBe(`claude --resume ${moved}`);
  });

  test("an unchanged conversation is not written back", async () => {
    const recordConversation = jest.fn(async () => undefined);
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending: pendingStore(),
      inspect: async () => live({ conversation_id: recorded }),
      recordConversation,
    });
    expect(recordConversation).not.toHaveBeenCalled();
  });

  test("a host that cannot answer, or a write-back that fails, still restarts as before", async () => {
    for (const inspect of [async () => null, async () => Promise.reject(new Error("offline"))]) {
      const pending = pendingStore();
      await restartSessionAgent({
        session: session(),
        agents: [claude],
        restart: async () => session({ status: "starting" }),
        pending,
        inspect,
      });
      expect(pending.queued.get(session().id)).toBe(`claude --resume ${recorded}`);
    }
    const pending = pendingStore();
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => live(),
      recordConversation: async () => Promise.reject(new Error("server down")),
    });
    expect(pending.queued.get(session().id)).toBe(`claude --resume ${moved}`);
  });

  test("restarts into a conversation held outside the window, and writes it back", async () => {
    // A window parked in agent view: its background job holds the fork, and
    // resuming that id attaches to it.
    const restart = jest.fn(async () => session({ status: "starting" }));
    const recordConversation = jest.fn(async () => undefined);
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart,
      pending,
      inspect: async () => live({ live_elsewhere: true, source: "parked" }),
      recordConversation,
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(recordConversation).toHaveBeenCalledWith(moved);
    expect(result.plan.kind === "agent" ? result.plan.command : null).toBe(
      `claude --resume ${moved}`,
    );
    expect(pending.queued.get(session().id)).toBe(`claude --resume ${moved}`);
  });

  test("a host that names no conversation writes nothing back", async () => {
    const recordConversation = jest.fn(async () => undefined);
    const pending = pendingStore();
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => live({ conversation_id: null, source: "parked" }),
      recordConversation,
    });
    expect(recordConversation).not.toHaveBeenCalled();
    expect(pending.queued.get(session().id)).toBe("claude --continue");
  });

  test("a Codex window resumes the id the host names and leaves its record alone", async () => {
    const recordConversation = jest.fn(async () => undefined);
    const pending = pendingStore();
    await restartSessionAgent({
      session: codexSession({ agent_session_id: null }),
      agents: [codex],
      restart: async () => codexSession({ status: "starting" }),
      pending,
      inspect: async () =>
        live({ agent: "codex", conversation_id: liveCodex, source: "open_file" }),
      recordConversation,
    });
    expect(recordConversation).not.toHaveBeenCalled();
    expect(pending.queued.get(session().id)).toBe(`codex resume ${liveCodex}`);

    // After `/new` the host sees two conversations open and names neither;
    // a recorded id is not the way back in.
    for (const inspect of [
      async () => live({ agent: "codex", conversation_id: null, source: "process" }),
      async () => null,
    ]) {
      const pending = pendingStore();
      await restartSessionAgent({
        session: codexSession(),
        agents: [codex],
        restart: async () => codexSession({ status: "starting" }),
        pending,
        inspect,
        recordConversation,
      });
      expect(pending.queued.get(session().id)).toBe("codex resume --last");
    }
    expect(recordConversation).not.toHaveBeenCalled();
  });

  test("a shell window never asks the host", async () => {
    const inspect = jest.fn(async () => live());
    await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending: pendingStore(),
      inspect,
    });
    expect(inspect).not.toHaveBeenCalled();
  });
});

/** The host's answer to `agent.transcripts` for one conversation id. */
function records(
  conversationIds: readonly string[],
  overrides: Partial<AgentTranscriptReport> = {},
): AgentTranscriptReport {
  return {
    agent_kind: "claude-code",
    supported: true,
    transcripts: conversationIds.map((id) => ({
      path: `~/.claude/projects/-repo/${id}.jsonl`,
      name: `${id}.jsonl`,
      size: 4096,
      modified_at: 1_790_000_000,
      role: "conversation" as const,
      conversation_id: id,
    })),
    searched: ["~/.claude/projects"],
    truncated: false,
    ...overrides,
  };
}

describe("conversationOnRecord", () => {
  test("a transcript of the conversation is a record of it", () => {
    expect(conversationOnRecord(records([recorded]), recorded)).toBe(true);
    expect(conversationOnRecord(records([recorded], { truncated: true }), recorded)).toBe(true);
  });

  test("a search that looked everywhere and found nothing is no record", () => {
    expect(conversationOnRecord(records([]), recorded)).toBe(false);
    expect(conversationOnRecord(records([moved]), recorded)).toBe(false);
  });

  test("an answer that cannot say is neither", () => {
    expect(conversationOnRecord(null, recorded)).toBeNull();
    expect(conversationOnRecord(records([], { supported: false }), recorded)).toBeNull();
    expect(conversationOnRecord(records([], { truncated: true }), recorded)).toBeNull();
  });
});

describe("planAgentRestart with the host's records", () => {
  test("a conversation the host has no record of starts fresh under the same id", () => {
    expect(planAgentRestart(session(), [claude], null, false)).toEqual({
      kind: "agent",
      agent: claude,
      command: `claude --session-id ${recorded}`,
      resumes: false,
    });
    expect(planAgentRestart(session(), [claude], null, true)).toEqual({
      kind: "agent",
      agent: claude,
      command: `claude --resume ${recorded}`,
      resumes: true,
    });
  });

  test("with no conversation to name, a missing record changes nothing", () => {
    const plan = planAgentRestart(session({ agent_session_id: null }), [claude], null, false);
    expect(plan.kind === "agent" ? plan.command : null).toBe("claude --continue");
    const codexPlan = planAgentRestart(
      codexSession(),
      [codex],
      live({ agent: "codex", conversation_id: liveCodex, source: "open_file" }),
      false,
    );
    expect(codexPlan.kind === "agent" ? codexPlan.command : null).toBe(`codex resume ${liveCodex}`);
  });
});

describe("restartSessionAgent with the host's records", () => {
  test("transcript present: the conversation is resumed", async () => {
    const transcripts = jest.fn(async () => records([recorded]));
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => null,
      transcripts,
    });
    expect(transcripts).toHaveBeenCalledWith({
      agentKind: "claude-code",
      conversationId: recorded,
      cwd: "/repo",
    });
    expect(result.plan.kind === "agent" ? result.plan.resumes : null).toBe(true);
    expect(pending.queued.get(session().id)).toBe(`claude --resume ${recorded}`);
  });

  test("transcript absent: the agent starts fresh under the window's id", async () => {
    const pending = pendingStore();
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => null,
      transcripts: async () => records([]),
    });
    expect(result.plan).toEqual({
      kind: "agent",
      agent: claude,
      command: `claude --session-id ${recorded}`,
      resumes: false,
    });
    expect(pending.queued.get(session().id)).toBe(`claude --session-id ${recorded}`);
  });

  test("transcripts unavailable: the conversation is resumed as before", async () => {
    for (const transcripts of [
      undefined,
      async () => null,
      async () => Promise.reject(new Error("unsupported_operation")),
      async () => records([], { supported: false }),
      async () => records([], { truncated: true }),
    ]) {
      const pending = pendingStore();
      await restartSessionAgent({
        session: session(),
        agents: [claude],
        restart: async () => session({ status: "starting" }),
        pending,
        inspect: async () => null,
        ...(transcripts ? { transcripts } : {}),
      });
      expect(pending.queued.get(session().id)).toBe(`claude --resume ${recorded}`);
    }
  });

  test("the host is asked about the conversation the window is actually in", async () => {
    const transcripts = jest.fn(async () => records([recorded]));
    const recordConversation = jest.fn(async () => undefined);
    const pending = pendingStore();
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => live(),
      transcripts,
      recordConversation,
    });
    expect(transcripts).toHaveBeenCalledWith({
      agentKind: "claude-code",
      conversationId: moved,
      cwd: "/repo",
    });
    expect(recordConversation).toHaveBeenCalledWith(moved);
    expect(pending.queued.get(session().id)).toBe(`claude --session-id ${moved}`);
  });

  test("only an agent launched under an id, with an id to resume, is looked up", async () => {
    const transcripts = jest.fn(async () => records([]));
    const pending = pendingStore();
    await restartSessionAgent({
      session: codexSession(),
      agents: [codex],
      restart: async () => codexSession({ status: "starting" }),
      pending,
      inspect: async () =>
        live({ agent: "codex", conversation_id: liveCodex, source: "open_file" }),
      transcripts,
    });
    expect(pending.queued.get(session().id)).toBe(`codex resume ${liveCodex}`);
    await restartSessionAgent({
      session: session(),
      agents: [claude],
      restart: async () => session({ status: "starting" }),
      pending,
      inspect: async () => live({ conversation_id: null, source: "parked" }),
      transcripts,
    });
    expect(pending.queued.get(session().id)).toBe("claude --continue");
    expect(transcripts).not.toHaveBeenCalled();
  });

  test("the host is let go once, before the restart", async () => {
    const order: string[] = [];
    for (const current of [session(), session({ agent_id: null, foreground_command: "bash" })]) {
      await restartSessionAgent({
        session: current,
        agents: [claude],
        restart: async () => {
          order.push("restart");
          return session({ status: "starting" });
        },
        pending: pendingStore(),
        inspect: async () => {
          order.push("inspect");
          return null;
        },
        transcripts: async () => {
          order.push("transcripts");
          return records([recorded]);
        },
        doneAsking: () => order.push("done asking"),
      });
    }
    expect(order).toEqual([
      "inspect",
      "transcripts",
      "done asking",
      "restart",
      "done asking",
      "restart",
    ]);
  });
});
