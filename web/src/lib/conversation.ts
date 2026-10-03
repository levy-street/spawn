/**
 * The conversation a window is actually in, as its host sees it.
 *
 * The server's `agent_session_id` is the id SPAWN D handed the agent at
 * launch, and Claude Code moves on from it: `/clear` and `/branch` start
 * another conversation, `/resume` adopts one, agent view forks the window's
 * conversation into a background job. The daemon answers `conv.inspect` from
 * the window's own processes and the agent's live-session registry, over the
 * device's host channel; the server never sees the question or the answer.
 * The one thing that reaches it is a Claude Code conversation id the host
 * named, which a restart writes back to the window's `agent_session_id`.
 */

/** The `conv.*` family, one versioned capability for every operation in it. */
export const CONVERSATION_CAPABILITY = "conv.v1";
export const CONVERSATION_INSPECT_OP = "conv.inspect";

export type ConversationState = "running" | "blocked" | "idle" | "unknown";

/** `conv.inspect`'s answer, in its wire shape. */
export interface ConversationInspection {
  /** The agent kind, spelled as agent definitions spell it, or null. */
  agent: string | null;
  conversation_id: string | null;
  state: ConversationState;
  cli_version: string | null;
  /** Another process outside this window holds the conversation: a
   *  background session, an attach target, another window. Restart resumes
   *  it all the same: resuming a running background session attaches to it. */
  live_elsewhere: boolean;
  /** What the daemon read: `registry`, `parked`, `attach`, `open_file`,
   *  `process`, `none`. A hint for diagnostics, never for gating. */
  source: string;
}

const STATES: ReadonlySet<string> = new Set(["running", "blocked", "idle", "unknown"]);
/** The server's own rule for a conversation id (`AGENT_SESSION_ID_PATTERN`). */
const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SHORT_TEXT = /^[\x21-\x7e]{1,64}$/;

function nullableText(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * A daemon's answer, checked field by field; null when it is not one. A state
 * this client does not know yet reads as `unknown` rather than as malformed,
 * so a newer daemon never breaks an older tab.
 */
export function parseConversationInspection(value: unknown): ConversationInspection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agent = nullableText(record.agent, SHORT_TEXT);
  const conversationId = nullableText(record.conversation_id, CONVERSATION_ID);
  const cliVersion = nullableText(record.cli_version, SHORT_TEXT);
  if (agent === undefined || conversationId === undefined || cliVersion === undefined) return null;
  if (typeof record.live_elsewhere !== "boolean" || typeof record.source !== "string") return null;
  const state = typeof record.state === "string" && STATES.has(record.state) ? record.state : null;
  return {
    agent,
    conversation_id: conversationId,
    state: (state ?? "unknown") as ConversationState,
    cli_version: cliVersion,
    live_elsewhere: record.live_elsewhere,
    source: record.source,
  };
}
