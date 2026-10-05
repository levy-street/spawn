import { type AgentYolo, agentConversationGrammar, agentLaunchCommand } from "@/lib/agent-relaunch";
import type { Agent } from "@/lib/api";

/**
 * Pure command construction for the agent switcher (§5.5). Everything the
 * switcher types into the PTY is built here so it can be unit-tested
 * byte-for-byte: env dicts become `KEY=value ` prefixes with shell-quoted
 * values, and missing agents get a fully visible `install && run` compound.
 *
 * Yolo mode folds in here rather than at each call site, so every way of
 * starting an agent — the switcher, the new-session menus, a template replay —
 * types the same thing.
 *
 * The quoting, the run command and each CLI's conversation grammar live in
 * `@/lib/agent-relaunch`, the module the phone carries byte for byte and
 * Restart and moves compose their lines with; they are re-exported here so a
 * launch and a relaunch can never spell an agent two ways.
 */

export {
  type AgentConversationGrammar,
  type AgentYolo,
  agentCanResume,
  agentConversationGrammar,
  agentLaunchCommand,
  agentResumeCommand,
  agentRunCommand,
  agentYoloAvailable,
  envPrefix,
  shellQuote,
} from "@/lib/agent-relaunch";

/**
 * What picking a missing agent types: the install command, visibly chained
 * into the run command. Null when the agent has no install command (the menu
 * then falls back to the plain run command, letting the shell report
 * command-not-found honestly).
 */
export function agentInstallAndRunCommand(
  agent: Pick<Agent, "command" | "env" | "install"> & Partial<Pick<Agent, "kind">> & AgentYolo,
  conversationId: string | null = null,
): string | null {
  const install = agent.install?.trim();
  if (!install) return null;
  return `${install} && ${agentLaunchCommand(agent, conversationId)}`;
}

/**
 * A fresh conversation id for a launch, or null for a CLI that cannot be
 * handed one. UUIDs: what every agent that takes an id expects, and safe to
 * type at a prompt bare.
 */
export function newAgentConversationId(kind: string | null | undefined): string | null {
  return agentConversationGrammar(kind)?.launch ? crypto.randomUUID() : null;
}
