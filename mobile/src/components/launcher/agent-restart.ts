import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import {
  type HandoffSession,
  runInShell,
  type ShellCommandSink,
  type ShellHandoffResult,
  sessionAtShell,
} from "@/components/launcher/shell-handoff";
import { agentResumeCommand, agentRunCommand, sessionAgent } from "@/data/selectors/agent";
import type { AgentDef, Session } from "@/data/types/domain";

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
 *    back, and the resume command is typed at it — the terminal never
 *    disconnects and the new process starts on whatever binary the old one
 *    installed. Only from the open terminal, which is the one place with a
 *    keyboard to type at.
 * 2. A fresh shell. When the window has no shell to type into (it exited),
 *    the agent will not hand the prompt back, or the restart is asked for
 *    from a workspace with no terminal open, the session is restarted and the
 *    resume command queued for the terminal to type the moment the new shell
 *    connects — the same durable queue a launch uses.
 */

/**
 * How long the agent gets to quit before a fresh shell is started instead:
 * polls at the handoff's cadence, so roughly twenty-five seconds. Generous
 * on purpose. Claude Code on a fast machine is gone within a second of the
 * Ctrl-C pair, but an older build on a Raspberry Pi with a monitor running
 * took longer than the ten seconds this used to allow, and the fallback —
 * killing the shell, reconnecting, replaying — is the slower, heavier road
 * that a few more seconds of patience avoids.
 */
export const AGENT_RESTART_ATTEMPTS = 30;

/** Where a restart is, for the control that started it. */
export type AgentRestartPhase =
  /** Waiting for the agent to hand the prompt back. */
  | "stopping"
  /** The resume command has been typed into the shell the window had. */
  | "resuming"
  /** A fresh shell is being started; the command waits for it. */
  | "restarting";

/** What the restart control says while a phase is under way. */
export function restartPhaseLabel(phase: AgentRestartPhase | null, agentName: string): string {
  switch (phase) {
    case "stopping":
      return `Stopping ${agentName}…`;
    case "resuming":
      return `Starting ${agentName}…`;
    case "restarting":
      return "Restarting the shell…";
    default:
      return "Restarting…";
  }
}

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: AgentDef; command: string; resumes: boolean };

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
  agents: readonly AgentDef[],
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  const resume = agentResumeCommand(agent, session.agent_session_id ?? null);
  return resume
    ? { kind: "agent", agent, command: resume, resumes: true }
    : { kind: "agent", agent, command: agentRunCommand(agent), resumes: false };
}

export type AgentRestartHandoff = (input: {
  session: HandoffSession;
  terminal: ShellCommandSink;
  command: string;
  purpose: string;
  getSession(sessionId: string): Promise<HandoffSession>;
  onSession?: (session: HandoffSession) => void;
  attempts: number;
}) => Promise<ShellHandoffResult>;

export async function restartSessionAgent({
  session,
  agents,
  terminal,
  restart,
  pending,
  getSession,
  onSession,
  onPhase,
  handoff = runInShell,
  purpose = "Restarting",
}: {
  session: Session;
  agents: readonly AgentDef[];
  /** The open terminal's keyboard, when the restart is asked for from one. */
  terminal: ShellCommandSink | null;
  /** `POST /api/sessions/{id}/restart`. */
  restart: (sessionId: string) => Promise<Session>;
  /** Where a command waits for the fresh shell. */
  pending: Pick<PendingLaunchStore, "persist" | "clear">;
  getSession(sessionId: string): Promise<Session>;
  /** Fresh session records seen while waiting, for the caller's cache. */
  onSession?: (session: Session) => void;
  /** Each phase as it begins, for the control that started the restart. */
  onPhase?: (phase: AgentRestartPhase) => void;
  handoff?: AgentRestartHandoff;
  /** Sentence-initial, for the handoff's messages. */
  purpose?: string;
}): Promise<AgentRestartResult> {
  const plan = planAgentRestart(session, agents);
  if (plan.kind === "shell") {
    onPhase?.("restarting");
    await restart(session.id);
    return { kind: "restarted", plan };
  }

  if (session.status === "running" && terminal) {
    // A window already at its prompt has nothing to stop; the handoff types
    // straight away, so the phase it is in is the one it ends in.
    const opening: AgentRestartPhase = sessionAtShell(session) ? "resuming" : "stopping";
    onPhase?.(opening);
    const result = await handoff({
      session,
      terminal,
      command: plan.command,
      purpose,
      getSession,
      ...(onSession ? { onSession: onSession as (session: HandoffSession) => void } : {}),
      attempts: AGENT_RESTART_ATTEMPTS,
    });
    if (result === "sent") {
      if (opening !== "resuming") onPhase?.("resuming");
      return { kind: "resumed", plan };
    }
  }

  // Queued before the restart so the new shell's first keystrokes are the
  // command; forgotten again if the restart never happened.
  onPhase?.("restarting");
  await pending.persist(session.id, plan.command);
  try {
    await restart(session.id);
  } catch (error) {
    await pending.clear(session.id).catch(() => undefined);
    throw error;
  }
  return { kind: "restarted", plan };
}
