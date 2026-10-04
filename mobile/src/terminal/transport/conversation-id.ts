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
 * optionally. The web app holds the same rule (`web/src/lib/conversation.ts`).
 */
export function canonicalConversationId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
