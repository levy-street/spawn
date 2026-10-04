import { canonicalConversationId } from "@/terminal/transport/conversation-id";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";

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
 * named, which a restart writes back to the window's `agent_session_id`. The
 * same wire shape the web app reads.
 */

/** The `conv.*` family, one versioned capability for every operation in it. */
export const CONVERSATION_CAPABILITY = "conv.v1";
export const CONVERSATION_INSPECT_OP = "conv.inspect";

export type ConversationState = "running" | "blocked" | "idle" | "unknown";

/** `conv.inspect`'s answer, in its wire shape. */
export interface ConversationInspection {
  /** The agent kind, spelled as agent definitions spell it, or null. */
  readonly agent: string | null;
  readonly conversation_id: string | null;
  readonly state: ConversationState;
  readonly cli_version: string | null;
  /** Another process outside this window holds the conversation: a
   *  background session, an attach target, another window. Restart resumes
   *  it all the same: resuming a running background session attaches to it. */
  readonly live_elsewhere: boolean;
  /** What the daemon read: `registry`, `parked`, `attach`, `open_file`,
   *  `process`, `none`. A hint for diagnostics, never for gating. */
  readonly source: string;
}

const STATES: ReadonlySet<string> = new Set(["running", "blocked", "idle", "unknown"]);
const SHORT_TEXT = /^[\x21-\x7e]{1,64}$/;

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
 * A daemon's answer, checked field by field. A state this client does not
 * know yet reads as `unknown` rather than as malformed, so a newer daemon
 * never breaks an older app; anything else malformed is refused. A
 * conversation id that is not a UUID is malformed; one in upper case is read
 * lower-case.
 */
export function parseConversationInspection(value: unknown): ConversationInspection {
  const invalid = () =>
    new HostControlTransportError(
      "invalid_response",
      "Host returned an invalid conversation report.",
    );
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const agent = nullableText(record["agent"], SHORT_TEXT);
  const conversationId = nullableConversationId(record["conversation_id"]);
  const cliVersion = nullableText(record["cli_version"], SHORT_TEXT);
  const liveElsewhere = record["live_elsewhere"];
  const source = record["source"];
  const state = record["state"];
  if (agent === undefined || conversationId === undefined || cliVersion === undefined) {
    throw invalid();
  }
  if (typeof liveElsewhere !== "boolean" || typeof source !== "string") throw invalid();
  return {
    agent,
    conversation_id: conversationId,
    state:
      typeof state === "string" && STATES.has(state) ? (state as ConversationState) : "unknown",
    cli_version: cliVersion,
    live_elsewhere: liveElsewhere,
    source,
  };
}
