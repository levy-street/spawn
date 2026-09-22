import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import { agentResumeCommand, agentRunCommand, sessionAgent } from "@/data/selectors/agent";
import type { AgentDef, Session } from "@/data/types/domain";

/**
 * Restart a window as what it was opened as.
 *
 * For a plain shell that is the login shell respawned in its folder. For an
 * agent window it is the agent brought back into the same conversation on
 * whatever binary the old process installed — the thing a person wants when
 * the agent says "Update installed · Restart to update".
 *
 * One road, always: the session is restarted — the daemon ends the worker,
 * the process tree goes with its PTY, a fresh login shell starts — and the
 * agent's resume command is queued, durably, for the terminal to type the
 * moment that shell's transport opens. No interrupting the agent and waiting
 * for it to hand the prompt back: that depended on how fast the agent felt
 * like quitting, and an older build on a slow machine took long enough that
 * the tap read as stuck. A kill is a few seconds, every time. Claude Code
 * writes its transcript as it goes, so `--resume` lands in the same thread.
 */

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: AgentDef; command: string; resumes: boolean };

export type AgentRestartResult = { plan: AgentRestartPlan };

/**
 * What a restart of this window means: a bare shell, or an agent and the
 * command that brings it back — resuming its conversation where the CLI can,
 * relaunching plainly where it cannot (`resumes` says which, so the UI can be
 * honest about it).
 */
export function planAgentRestart(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id">,
  agents: readonly AgentDef[],
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  const resume = agentResumeCommand(agent, session.agent_session_id ?? null);
  return resume
    ? { kind: "agent", agent, command: resume, resumes: true }
    : { kind: "agent", agent, command: agentRunCommand(agent), resumes: false };
}

export async function restartSessionAgent({
  session,
  agents,
  restart,
  pending,
}: {
  session: Session;
  agents: readonly AgentDef[];
  /** `POST /api/sessions/{id}/restart`. */
  restart: (sessionId: string) => Promise<Session>;
  /** Where a command waits for the fresh shell. */
  pending: Pick<PendingLaunchStore, "persist" | "clear">;
}): Promise<AgentRestartResult> {
  const plan = planAgentRestart(session, agents);
  // Queued before the restart so the new shell's first keystrokes are the
  // command; forgotten again if the restart never happened.
  if (plan.kind === "agent") await pending.persist(session.id, plan.command);
  try {
    await restart(session.id);
  } catch (error) {
    if (plan.kind === "agent") await pending.clear(session.id).catch(() => undefined);
    throw error;
  }
  return { plan };
}
