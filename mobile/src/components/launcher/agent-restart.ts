import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import {
  agentConversationGrammar,
  agentLaunchCommand,
  agentResumeCommand,
  agentRunCommand,
  sessionAgent,
} from "@/data/selectors/agent";
import type { AgentDef, Session } from "@/data/types/domain";
import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import type { AgentTranscriptQuery, AgentTranscriptReport } from "@/terminal/transport/types";

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
 *
 * Whether that thread exists yet: Claude Code writes nothing until the first
 * message, so a window that has not had one — a fresh launch, or a window
 * just moved to another host, which starts a new conversation there — names
 * an id with no transcript behind it, and `--resume` of it stops at "No
 * conversation found". Where the host can look (`agent.transcripts`) and
 * finds no record of the id, the agent starts afresh under that same id
 * instead (`--session-id`); where it cannot say, the restart resumes.
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
 * Whether the host keeps a record of this conversation, from its answer to
 * `agent.transcripts` for the id: true when it names the conversation's own
 * transcript, false when it looked everywhere the agent writes and found
 * none, null when it cannot say — no answer, a store the daemon cannot
 * reach, or a search cut short before it got there.
 */
export function conversationOnRecord(
  report: Pick<AgentTranscriptReport, "supported" | "transcripts" | "truncated"> | null,
  conversationId: string,
): boolean | null {
  if (!report?.supported) return null;
  const found = report.transcripts.some(
    (file) => file.role === "conversation" && file.conversation_id === conversationId,
  );
  if (found) return true;
  return report.truncated ? null : false;
}

/**
 * What a restart of this window means: a bare shell, or an agent and the
 * command that brings it back — resuming its conversation where the CLI can,
 * relaunching plainly where it cannot (`resumes` says which, so the UI can be
 * honest about it). `live` is the host's answer for the window, when it gave
 * one (`restartConversation`); `onRecord` is whether the host keeps a record
 * of that conversation (`conversationOnRecord`). Only a definite "no" changes
 * anything: an agent SPAWN D launches under an id then starts a fresh
 * conversation under the same one, since there is nothing to resume.
 */
export function planAgentRestart(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id">,
  agents: readonly AgentDef[],
  live: ConversationInspection | null = null,
  onRecord: boolean | null = null,
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  const conversationId = restartConversation(agent, session, live);
  if (conversationId && onRecord === false && launchesUnderId(agent)) {
    return {
      kind: "agent",
      agent,
      command: agentLaunchCommand(agent, conversationId),
      resumes: false,
    };
  }
  const resume = agentResumeCommand(agent, conversationId);
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
  transcripts,
  doneAsking,
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
  /** The host's records of a conversation (`agent.transcripts`), null when it
   *  cannot say. Asked only for an agent SPAWN D launches under an id, about
   *  the id the restart is about to resume. Omitted, the restart resumes. */
  transcripts?: (query: AgentTranscriptQuery) => Promise<AgentTranscriptReport | null>;
  /** Called once the restart has nothing more to ask the host, before the
   *  restart itself, so whatever the questions opened can be let go. */
  doneAsking?: () => void;
  /** Writes a conversation the host named back to the window's record
   *  (`agent_session_id`), so the next restart, the transcripts sheet and
   *  the other devices agree. Best effort, and only for an agent SPAWN D
   *  launches under an id. */
  recordConversation?: (conversationId: string) => Promise<unknown>;
}): Promise<AgentRestartResult> {
  const agent = sessionAgent(session, agents);
  let live: ConversationInspection | null = null;
  let onRecord: boolean | null = null;
  let conversationId: string | null = null;
  try {
    live = agent && inspect ? await inspect().catch(() => null) : null;
    conversationId = agent ? restartConversation(agent, session, live) : null;
    // A conversation with no transcript yet cannot be resumed. Only the id
    // about to be resumed is looked for, and only where the agent can be
    // started afresh under it.
    if (agent && conversationId && transcripts && launchesUnderId(agent)) {
      const report = await transcripts({
        agentKind: agent.kind,
        conversationId,
        cwd: session.cwd,
      }).catch(() => null);
      onRecord = conversationOnRecord(report, conversationId);
    }
  } finally {
    doneAsking?.();
  }
  // Only an id the host just named is written back, and only where a later
  // restart reads the record: never the recorded id it replaced, never one
  // for a CLI that names its own conversations.
  if (
    agent &&
    launchesUnderId(agent) &&
    conversationId &&
    conversationId !== (session.agent_session_id ?? null)
  ) {
    await recordConversation?.(conversationId).catch(() => undefined);
  }
  const plan = planAgentRestart(session, agents, live, onRecord);
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
