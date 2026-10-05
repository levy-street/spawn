/**
 * A conversation id as SPAWN D will put it on a command line, lower-case, or
 * null when the value is not one: a canonical UUID and nothing else, so a
 * value the server or a host hands back (`--dangerously-skip-permissions`
 * after `--resume`) can never be read as a flag. The server is not trusted
 * with what a device types (docs/TRUST.md).
 *
 * One rule, kept in the relaunch module that composes every agent line
 * (`@/data/selectors/agent-relaunch`, which the browser carries byte for
 * byte): the host's answers, transcript queries and Restart read ids through
 * it here.
 */
export { canonicalConversationId } from "@/data/selectors/agent-relaunch";
