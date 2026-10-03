import type { Agent, Session } from "@/lib/api";
import type { ConversationInspection } from "@/lib/conversation";
import { sessionAgent } from "@/lib/sessions";
import { agentResumeCommand, agentRunCommand } from "./agent-command";
import { pendingLaunch } from "./pending-launch";

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
 * agent's resume command is queued for the pane to type the moment that
 * shell's transport opens. No interrupting the agent and waiting for it to
 * hand the prompt back: that depended on how fast the agent felt like
 * quitting, and an older build on a slow machine took long enough that the
 * click read as stuck. A kill is a few seconds, every time. Claude Code
 * writes its transcript as it goes, so `--resume` lands in the same thread.
 *
 * Which thread: the one the window is actually in. The recorded
 * `agent_session_id` is the id SPAWN D handed the agent at launch, and Claude
 * moves on from it (`/clear`, `/branch`, `/resume`, agent view). Where the
 * host answers `conv.inspect`, its answer wins and is written back to the
 * record; where it cannot answer, the recorded id is resumed as before.
 */

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: Agent; command: string; resumes: boolean };

export type AgentRestartResult = { plan: AgentRestartPlan };

/** What Restart says when the window's conversation is held outside it. The
 *  phone says the same words. */
export function conversationElsewhereMessage(hostName: string): string {
  return `This conversation is running in the background on ${hostName}. Stop it there first.`;
}

/** A restart refused because resuming would be a second writer on the
 *  conversation: something the restart does not stop still holds it. */
export class ConversationElsewhereError extends Error {
  constructor(hostName: string) {
    super(conversationElsewhereMessage(hostName));
    this.name = "ConversationElsewhereError";
  }
}

/**
 * The conversation a restart brings the agent back into: the one the host
 * names for this window, when it names one for this agent, else the recorded
 * one. Throws `ConversationElsewhereError` while the host says a process the
 * restart would not stop — a background session, an attach target, another
 * window — holds it.
 */
export function restartConversation(
  agent: Pick<Agent, "kind">,
  session: Pick<Session, "agent_session_id" | "host_name">,
  live: ConversationInspection | null,
): string | null {
  const recorded = session.agent_session_id ?? null;
  // An answer about another program says nothing about this agent's thread.
  if (!live || live.agent !== agent.kind.trim().toLowerCase()) return recorded;
  if (live.live_elsewhere) throw new ConversationElsewhereError(session.host_name ?? "this host");
  return live.conversation_id ?? recorded;
}

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

export async function restartSessionAgent({
  session,
  agents,
  restart,
  inspect,
  recordConversation,
}: {
  session: Session;
  agents: readonly Agent[];
  /** `POST /api/sessions/{id}/restart`, as the caller's mutation. */
  restart: () => Promise<Session>;
  /** The host's own answer for this window (`conv.inspect`), null when it
   *  has none. Omitted, the recorded conversation is resumed. */
  inspect?: () => Promise<ConversationInspection | null>;
  /** Writes a conversation the host named back to the window's record
   *  (`agent_session_id`), so the next restart, the transcripts view and the
   *  other devices agree. Best effort. */
  recordConversation?: (conversationId: string) => Promise<unknown>;
}): Promise<AgentRestartResult> {
  const agent = sessionAgent(session, agents);
  let conversationId = session.agent_session_id ?? null;
  if (agent && inspect) {
    const live = await inspect().catch(() => null);
    conversationId = restartConversation(agent, session, live);
    if (conversationId && conversationId !== (session.agent_session_id ?? null)) {
      await recordConversation?.(conversationId).catch(() => undefined);
    }
  }
  const plan = planAgentRestart({ ...session, agent_session_id: conversationId }, agents);
  // Queued before the restart so the new shell's first keystrokes are the
  // command; forgotten again if the restart never happened.
  if (plan.kind === "agent") pendingLaunch.set(session.id, plan.command);
  try {
    await restart();
  } catch (error) {
    pendingLaunch.clear(session.id);
    throw error;
  }
  return { plan };
}
