import { sessionAgent } from "@/data/selectors/agent";
import type { AgentDef, Session } from "@/data/types/domain";
import type {
  AgentTranscriptFile,
  AgentTranscriptQuery,
  AgentTranscriptReport,
} from "@/terminal/transport/types";

/**
 * An agent's own record of a window's conversation: the files the harness
 * writes on the host as it goes — Claude Code's `.jsonl` under
 * `~/.claude/projects`, a Codex rollout, aider's chat history. The daemon
 * locates them (`agent.transcripts`) and the phone reads them like any other
 * host file, so the server never sees a line. This module is the pure half:
 * what to ask for, and what to say about the answer.
 */

/** What to ask the daemon for, or null when the window runs no agent. */
export function transcriptQueryFor(
  session: Pick<Session, "foreground_command" | "agent_id" | "agent_session_id" | "cwd">,
  agents: readonly AgentDef[],
): { agent: AgentDef; query: AgentTranscriptQuery } | null {
  const agent = sessionAgent(session, agents);
  if (!agent) return null;
  return {
    agent,
    query: {
      agentKind: agent.kind,
      conversationId: session.agent_session_id ?? null,
      cwd: session.cwd,
    },
  };
}

export function transcriptRoleLabel(role: AgentTranscriptFile["role"]): string {
  switch (role) {
    case "conversation":
      return "Conversation";
    case "subagent":
      return "Subagent";
    case "input":
      return "Prompt history";
  }
}

/** One title and one sentence for a sheet with nothing to list. */
export interface TranscriptNotice {
  title: string;
  body: string;
}

/**
 * Why there is nothing to show, or null when there is something. An
 * unsupported harness and an empty search are different facts and get
 * different sentences: one is a limit of SPAWN D, the other is the agent not
 * having written anything yet.
 */
export function transcriptEmptyState(
  report: AgentTranscriptReport,
  agentName: string,
  hostName: string,
): TranscriptNotice | null {
  if (!report.supported) {
    return {
      title: `No transcript for ${agentName}`,
      body: `SPAWN D doesn't know where ${agentName} keeps its conversations on ${hostName}.`,
    };
  }
  if (report.transcripts.length > 0) return null;
  const where = report.searched.length > 0 ? ` Looked in ${report.searched.join(", ")}.` : "";
  return {
    title: "No transcript yet",
    body: `${agentName} hasn't written a conversation for this window on ${hostName}.${where}`,
  };
}

/** The daemon on this host predates transcripts. */
export function transcriptsUnavailable(hostName: string): TranscriptNotice {
  return {
    title: "Update spawnd on this host",
    body: `The spawnd daemon on ${hostName} is too old to find agent transcripts. Update it and try again.`,
  };
}

/** A shell window has no agent, so nothing wrote a transcript for it. */
export function transcriptsNeedAnAgent(): TranscriptNotice {
  return {
    title: "This window runs a shell",
    body: "Transcripts come from an agent. Start one here and its conversation shows up.",
  };
}
