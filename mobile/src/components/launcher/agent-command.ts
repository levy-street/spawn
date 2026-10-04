// Every line a launch types is composed by the relaunch module the browser
// carries byte for byte (`@/data/selectors/agent-relaunch`), the same one
// Restart and moves compose theirs with; the agent selectors add what an
// agent definition means around it. Launcher code reads both from here so
// nothing in this directory reaches past its own imports, and nothing here
// spells a line of its own: a launch and a relaunch can never spell an agent
// two ways.
export {
  agentCanResume,
  agentInstallAndLaunchCommand,
  agentInstallAndRunCommand,
  agentLaunchCommand,
  agentResumeCommand,
  newAgentConversationId,
  sortAgents,
} from "@/data/selectors/agent";
export {
  type AgentYolo,
  agentRunCommand,
  agentYoloAvailable,
  envPrefix,
  shellQuote,
} from "@/data/selectors/agent-relaunch";
