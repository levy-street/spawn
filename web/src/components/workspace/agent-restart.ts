import {
  agentConversationGrammar,
  agentLaunchCommand,
  agentResumeCommand,
  agentRunCommand,
} from "@/lib/agent-relaunch";
import type { Agent, Session } from "@/lib/api";
import { type ConversationInspection, canonicalConversationId } from "@/lib/conversation";
import type { AgentTranscriptQuery, AgentTranscriptReport } from "@/lib/hostControl";
import { sessionAgent } from "@/lib/sessions";
import { newAgentConversationId } from "./agent-command";
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
 *
 * What goes on the command line: only a UUID (`canonicalConversationId`).
 * The recorded id is the server's to hand back, and the server is not
 * trusted with what a device types; a record that is anything else is
 * neither resumed nor guessed at — the agent starts a new conversation under
 * a new id, written back in its place (`recordRefused`).
 *
 * The line itself comes from the relaunch module (`@/lib/agent-relaunch`)
 * that moves and account switches compose theirs with. A restart asks it for
 * no permission mode and no note: the agent comes back in the mode its own
 * conversation recorded, on the same host, exactly as it always has.
 */

export type AgentRestartPlan =
  | { kind: "shell" }
  | { kind: "agent"; agent: Agent; command: string; resumes: boolean };

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
 *
 * Either way the id is a UUID, lower-case, or there is none: whatever else a
 * record or an answer holds is never handed on to a command line.
 */
export function restartConversation(
  agent: Pick<Agent, "kind">,
  session: Pick<Session, "agent_session_id">,
  live: ConversationInspection | null,
): string | null {
  if (answersFor(agent, live)) return canonicalConversationId(live.conversation_id);
  return launchesUnderId(agent) ? canonicalConversationId(session.agent_session_id) : null;
}

/**
 * Whether the window's record names a conversation no command line may
 * carry — anything but a UUID — where a restart would otherwise read it: an
 * agent SPAWN D launches under an id, with no answer from the host about it.
 * The server wrote that record, and a value like `--dangerously-skip-permissions`
 * typed after `--resume` would be read as a flag. Such a record is not
 * guessed at either (`--continue` would pick whichever conversation was last
 * touched here): the agent starts a new conversation.
 */
export function recordRefused(
  agent: Pick<Agent, "kind">,
  session: Pick<Session, "agent_session_id">,
  live: ConversationInspection | null,
): boolean {
  return (
    !answersFor(agent, live) &&
    launchesUnderId(agent) &&
    session.agent_session_id != null &&
    canonicalConversationId(session.agent_session_id) === null
  );
}

/** Whether the host's answer is about this window's agent, and so decides. */
function answersFor(
  agent: Pick<Agent, "kind">,
  live: ConversationInspection | null,
): live is ConversationInspection {
  return live !== null && live.agent === agent.kind.trim().toLowerCase();
}

/** Whether SPAWN D hands this kind of agent its conversation id at launch: the
 *  only kind whose recorded id a later restart reads back. */
function launchesUnderId(agent: Pick<Agent, "kind">): boolean {
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
 * conversation under the same one, since there is nothing to resume. A record
 * that is not a UUID (`recordRefused`) starts a fresh conversation too; the
 * restart itself replaces it with a new id first, so the planner sees it here
 * only when called alone, and then launches with no id at all.
 */
export function planAgentRestart(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id">,
  agents: readonly Agent[],
  live: ConversationInspection | null = null,
  onRecord: boolean | null = null,
): AgentRestartPlan {
  const agent = sessionAgent(session, agents);
  if (!agent) return { kind: "shell" };
  if (recordRefused(agent, session, live)) {
    return { kind: "agent", agent, command: agentLaunchCommand(agent, null), resumes: false };
  }
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
  inspect,
  transcripts,
  doneAsking,
  recordConversation,
}: {
  session: Session;
  agents: readonly Agent[];
  /** `POST /api/sessions/{id}/restart`, as the caller's mutation. */
  restart: () => Promise<Session>;
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
   *  (`agent_session_id`), so the next restart, the transcripts view and the
   *  other devices agree. Best effort, and only for an agent SPAWN D launches
   *  under an id. */
  recordConversation?: (conversationId: string) => Promise<unknown>;
}): Promise<AgentRestartResult> {
  const agent = sessionAgent(session, agents);
  let live: ConversationInspection | null = null;
  let onRecord: boolean | null = null;
  let conversationId: string | null = null;
  // The window as the restart reads it: as recorded, unless the record is
  // refused (`recordRefused`) and stands replaced by a new id.
  let record: Session = session;
  try {
    live = agent && inspect ? await inspect().catch(() => null) : null;
    // A record no command line may carry is not resumed: the agent starts a
    // new conversation under an id this device chose, written back in the
    // record's place — the road of a conversation the host has no record of.
    if (agent && recordRefused(agent, session, live)) {
      record = { ...session, agent_session_id: newAgentConversationId(agent.kind) };
      onRecord = false;
    }
    conversationId = agent ? restartConversation(agent, record, live) : null;
    // A conversation with no transcript yet cannot be resumed. Only the id
    // about to be resumed is looked for, and only where the agent can be
    // started afresh under it.
    if (agent && conversationId && onRecord === null && transcripts && launchesUnderId(agent)) {
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
  // Only an id the host just named, or the new one standing in for a refused
  // record, is written back, and only where a later restart reads the record:
  // never the recorded id it replaced, never one for a CLI that names its own
  // conversations.
  if (
    agent &&
    launchesUnderId(agent) &&
    conversationId &&
    conversationId !== (session.agent_session_id ?? null)
  ) {
    await recordConversation?.(conversationId).catch(() => undefined);
  }
  const plan = planAgentRestart(record, agents, live, onRecord);
  // Queued before the restart so the new shell's first keystrokes are the
  // command — for the window as it runs here, so a move that lands first
  // drops it rather than resuming the conversation over there; forgotten
  // again if the restart never happened.
  if (plan.kind === "agent") pendingLaunch.set(session.id, session.host_id, plan.command);
  try {
    await restart();
  } catch (error) {
    pendingLaunch.clear(session.id);
    throw error;
  }
  return { plan };
}
