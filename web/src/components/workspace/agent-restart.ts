import type { TerminalHandle } from "@/components/terminal/Terminal";
import type { Agent, Session } from "@/lib/api";
import { sessionAgent } from "@/lib/sessions";
import { agentResumeCommand, agentRunCommand } from "./agent-command";
import { pendingLaunch } from "./pending-launch";
import type { ShellHandoffResult } from "./shell-handoff";

/**
 * Restart a window as what it was opened as.
 *
 * For a plain shell that is the login shell respawned in its folder. For an
 * agent window it is the agent brought back into the same conversation — the
 * thing a person wants when the agent says "Update installed · Restart to
 * update", and what the old restart never did: it handed back a bare prompt
 * and left the relaunch and the resume to be typed by hand.
 *
 * Two roads to the same place, tried in order:
 *
 * 1. In the shell it already has. The agent is interrupted, the prompt comes
 *    back, and the resume command is typed at it — the pane never
 *    disconnects, background jobs in that shell survive, and the new process
 *    starts on whatever binary the old one installed.
 * 2. A fresh shell. When the window has no shell to type into (it exited) or
 *    the agent will not hand the prompt back, the session is restarted and
 *    the resume command queued for the pane to type the moment the new shell
 *    connects.
 */

/** How long the agent gets to quit before a fresh shell is started instead:
 *  polls at the handoff's cadence, so roughly ten seconds. */
export const AGENT_RESTART_ATTEMPTS = 14;

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: Agent; command: string; resumes: boolean };

export type AgentRestartResult =
  /** Typed into the shell the window already had: no reconnect happened. */
  | { kind: "resumed"; plan: AgentRestartPlan }
  /** The session was restarted; an agent command, if any, waits for the new shell. */
  | { kind: "restarted"; plan: AgentRestartPlan };

/**
 * What a restart of this window means: a bare shell, or an agent and the
 * command that brings it back — resuming its conversation where the CLI can,
 * relaunching plainly where it cannot (`resumes` says which, so the UI can be
 * honest about it).
 */
export function planAgentRestart(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id">,
  agents: readonly Agent[],
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  const resume = agentResumeCommand(agent, session.agent_session_id ?? null);
  return resume
    ? { kind: "agent", agent, command: resume, resumes: true }
    : { kind: "agent", agent, command: agentRunCommand(agent), resumes: false };
}

/** The shell handoff, as `shell-handoff.ts` spells it — injected so the plan
 *  can be exercised without a dialog module behind it. */
export type ShellHandoff = (input: {
  session: Session;
  handle: TerminalHandle;
  command: string;
  purpose: string;
  onSession?: (session: Session) => void;
  confirmed: true;
  attempts: number;
}) => Promise<ShellHandoffResult>;

export async function restartSessionAgent({
  session,
  agents,
  handle,
  handoff,
  restart,
  purpose = "Restarting",
  onSession,
}: {
  session: Session;
  agents: readonly Agent[];
  /** The window's live terminal, when it has one on screen. */
  handle: TerminalHandle | null;
  /** `runInShell`, or a stand-in. */
  handoff: ShellHandoff;
  /** `POST /api/sessions/{id}/restart`, as the caller's mutation. */
  restart: () => Promise<Session>;
  /** Sentence-initial, for the handoff's messages. */
  purpose?: string;
  /** Fresh session records seen while waiting, for the caller's cache. */
  onSession?: (session: Session) => void;
}): Promise<AgentRestartResult> {
  const plan = planAgentRestart(session, agents);
  if (plan.kind === "shell") {
    await restart();
    return { kind: "restarted", plan };
  }

  if (session.status === "running" && handle) {
    const result = await handoff({
      session,
      handle,
      command: plan.command,
      purpose,
      onSession,
      confirmed: true,
      attempts: AGENT_RESTART_ATTEMPTS,
    });
    if (result === "sent") return { kind: "resumed", plan };
  }

  // Queued before the restart so the new shell's first keystrokes are the
  // command; forgotten again if the restart never happened.
  pendingLaunch.set(session.id, plan.command);
  try {
    await restart();
  } catch (error) {
    pendingLaunch.clear(session.id);
    throw error;
  }
  return { kind: "restarted", plan };
}
