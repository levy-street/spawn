import { describe, expect, mock, test } from "bun:test";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  AGENT_RESTART_ATTEMPTS,
  planAgentRestart,
  restartSessionAgent,
  type ShellHandoff,
} from "@/components/workspace/agent-restart";
import { pendingLaunch } from "@/components/workspace/pending-launch";
import type { Agent, Session } from "@/lib/api";

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

const handle = { sendInput: () => {}, focus: () => {} } as unknown as TerminalHandle;

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
    const handoff = mock<ShellHandoff>(async () => "sent");
    const restart = mock(async () => session());
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      handle,
      handoff,
      restart,
    });
    expect(result.kind).toBe("resumed");
    expect(restart).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledTimes(1);
    const input = handoff.mock.calls[0]?.[0];
    expect(input?.command).toBe("claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10");
    expect(input?.confirmed).toBe(true);
    expect(input?.attempts).toBe(AGENT_RESTART_ATTEMPTS);
    expect(pendingLaunch.has(session().id)).toBe(false);
  });

  test("starts a fresh shell with the command queued when the agent will not quit", async () => {
    const handoff = mock(async () => "busy" as const);
    const restart = mock(async () => session({ status: "starting" }));
    const result = await restartSessionAgent({
      session: session(),
      agents: [claude],
      handle,
      handoff,
      restart,
    });
    expect(result.kind).toBe("restarted");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(pendingLaunch.take(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
  });

  test("an exited window skips the handoff: there is no shell to type into", async () => {
    const handoff = mock(async () => "sent" as const);
    const restart = mock(async () => session({ status: "starting" }));
    await restartSessionAgent({
      session: session({ status: "exited", foreground_command: null }),
      agents: [claude],
      handle,
      handoff,
      restart,
    });
    expect(handoff).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(pendingLaunch.take(session().id)).toBe(
      "claude --resume 3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10",
    );
  });

  test("a restart the server refused leaves nothing queued", async () => {
    const restart = mock(async () => {
      throw new Error("host daemon is offline");
    });
    await expect(
      restartSessionAgent({
        session: session({ status: "exited" }),
        agents: [claude],
        handle: null,
        handoff: async () => "busy" as const,
        restart,
      }),
    ).rejects.toThrow("host daemon is offline");
    expect(pendingLaunch.has(session().id)).toBe(false);
  });

  test("a shell window restarts without touching the queue", async () => {
    const handoff = mock(async () => "sent" as const);
    const restart = mock(async () => session({ status: "starting" }));
    const result = await restartSessionAgent({
      session: session({ agent_id: null, foreground_command: "bash" }),
      agents: [claude],
      handle,
      handoff,
      restart,
    });
    expect(result).toEqual({ kind: "restarted", plan: { kind: "shell" } });
    expect(handoff).not.toHaveBeenCalled();
    expect(pendingLaunch.has(session().id)).toBe(false);
  });
});
