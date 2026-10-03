import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import {
  agentConversationGrammar,
  agentResumeCommand,
  agentRunCommand,
  sessionAgent,
} from "@/data/selectors/agent";
import type { AgentDef, Session } from "@/data/types/domain";
import type { ConversationInspection } from "@/terminal/transport/conversation-codec";

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
 *
 * Which thread: the one the window is actually in. The recorded
 * `agent_session_id` is the id SPAWN D handed the agent at launch, and Claude
 * moves on from it (`/clear`, `/branch`, `/resume`, agent view). Where the
 * host answers `conv.inspect` for this window's agent, its answer is the
 * word on it; where it cannot answer, a restart does what it always did.
 */

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: AgentDef; command: string; resumes: boolean };

export type AgentRestartResult = { plan: AgentRestartPlan };

/**
 * The conversation a restart brings the agent back into, or null for "the
 * latest one here".
 *
 * An answer from the host about this window's agent decides it: the id the
 * host names, or none when it deliberately names none (a Codex holding several
 * conversations open, a parked window whose background job has gone, an
 * attach client). The recorded id is never offered in its place: in each of
 * those cases it can be a thread the window has already left.
 *
 * Without such an answer — a daemon without `conv.v1`, no connection to the
 * host, a timeout, an answer about another program — the recorded id stands,
 * but only for a CLI that SPAWN D launches under an id it chose (Claude
 * Code). A CLI that names its own conversations (Codex) has no recorded id
 * worth trusting and reopens the latest one here, as it always has.
 *
 * A conversation that something outside the window also holds is resumed all
 * the same: on the same host `claude --resume <id>` of a running background
 * session attaches to it rather than becoming a second writer.
 */
export function restartConversation(
  agent: Pick<AgentDef, "kind">,
  session: Pick<Session, "agent_session_id">,
  live: ConversationInspection | null,
): string | null {
  if (live && live.agent === agent.kind.trim().toLowerCase()) return live.conversation_id;
  return launchesUnderId(agent) ? (session.agent_session_id ?? null) : null;
}

/** Whether SPAWN D hands this kind of agent its conversation id at launch: the
 *  only kind whose recorded id a later restart reads back. */
function launchesUnderId(agent: Pick<AgentDef, "kind">): boolean {
  return Boolean(agentConversationGrammar(agent.kind)?.launch);
}

/**
 * What a restart of this window means: a bare shell, or an agent and the
 * command that brings it back — resuming its conversation where the CLI can,
 * relaunching plainly where it cannot (`resumes` says which, so the UI can be
 * honest about it). `live` is the host's answer for the window, when it gave
 * one (`restartConversation`).
 */
export function planAgentRestart(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id">,
  agents: readonly AgentDef[],
  live: ConversationInspection | null = null,
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  const resume = agentResumeCommand(agent, restartConversation(agent, session, live));
  return resume
    ? { kind: "agent", agent, command: resume, resumes: true }
    : { kind: "agent", agent, command: agentRunCommand(agent), resumes: false };
}

export async function restartSessionAgent({
  session,
  agents,
  restart,
  pending,
  inspect,
  recordConversation,
}: {
  session: Session;
  agents: readonly AgentDef[];
  /** `POST /api/sessions/{id}/restart`. */
  restart: (sessionId: string) => Promise<Session>;
  /** Where a command waits for the fresh shell. */
  pending: Pick<PendingLaunchStore, "persist" | "clear">;
  /** The host's own answer for this window (`conv.inspect`), null when it
   *  has none. Omitted, the restart goes without it (`restartConversation`). */
  inspect?: () => Promise<ConversationInspection | null>;
  /** Writes a conversation the host named back to the window's record
   *  (`agent_session_id`), so the next restart, the transcripts sheet and
   *  the other devices agree. Best effort, and only for an agent SPAWN D
   *  launches under an id. */
  recordConversation?: (conversationId: string) => Promise<unknown>;
}): Promise<AgentRestartResult> {
  const agent = sessionAgent(session, agents);
  const live = agent && inspect ? await inspect().catch(() => null) : null;
  // Only an id the host just named is written back, and only where a later
  // restart reads the record: never the recorded id it replaced, never one
  // for a CLI that names its own conversations.
  const conversationId = agent ? restartConversation(agent, session, live) : null;
  if (
    agent &&
    launchesUnderId(agent) &&
    conversationId &&
    conversationId !== (session.agent_session_id ?? null)
  ) {
    await recordConversation?.(conversationId).catch(() => undefined);
  }
  const plan = planAgentRestart(session, agents, live);
  // Queued before the restart so the new shell's first keystrokes are the
  // command — for the window as it runs here, so a move that lands first
  // drops it rather than resuming the conversation over there; forgotten
  // again if the restart never happened.
  if (plan.kind === "agent") await pending.persist(session.id, session.host_id, plan.command);
  try {
    await restart(session.id);
  } catch (error) {
    if (plan.kind === "agent") await pending.clear(session.id).catch(() => undefined);
    throw error;
  }
  return { plan };
}
