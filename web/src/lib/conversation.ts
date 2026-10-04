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
const SHORT_TEXT = /^[\x21-\x7e]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A conversation id as SPAWN D will put it on a command line, or null when
 * the value is not one.
 *
 * Every agent that takes an id names its conversations with UUIDs (Claude
 * Code's `--session-id` and `--resume`, Codex's `resume`), and the id is typed
 * into the window's shell after the agent's own flags. So only a canonical
 * UUID, 8-4-4-4-12 hex digits written lower-case, is ever an id; anything
 * else is no id at all. That keeps the id from ever being read as a flag. The
 * server holds `agent_session_id`, and the server is not trusted with what a
 * device types (docs/TRUST.md): `claude --resume --dangerously-skip-permissions`
 * would read the second word as a flag, since `--resume` takes its value
 * optionally. The phone holds the same rule.
 */
export function canonicalConversationId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function nullableText(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** A conversation id from the host: null, a UUID (`canonicalConversationId`),
 *  or undefined when it is something else and the answer is malformed. */
function nullableConversationId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return canonicalConversationId(value) ?? undefined;
}

/**
 * A daemon's answer, checked field by field; null when it is not one. A state
 * this client does not know yet reads as `unknown` rather than as malformed,
 * so a newer daemon never breaks an older tab. A conversation id that is not
 * a UUID makes the answer malformed; one in upper case is read lower-case.
 */
export function parseConversationInspection(value: unknown): ConversationInspection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agent = nullableText(record.agent, SHORT_TEXT);
  const conversationId = nullableConversationId(record.conversation_id);
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
