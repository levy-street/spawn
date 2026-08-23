import type { AgentOut } from "@/data/api/schemas/agents";

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AgentYolo = {
  yolo?: boolean;
  yolo_args?: string | null;
  yolo_env?: Record<string, string> | null;
};

export function shellQuote(value: string): string {
  if (value !== "" && SAFE_WORD.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function envPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join("");
}

export function agentYoloAvailable(agent: AgentYolo): boolean {
  return Boolean(agent.yolo_args?.trim()) || Object.keys(agent.yolo_env ?? {}).length > 0;
}

export function agentRunCommand(agent: Pick<AgentOut, "command" | "env"> & AgentYolo): string {
  const useYolo = agent.yolo === true && agentYoloAvailable(agent);
  const env = useYolo ? { ...agent.env, ...(agent.yolo_env ?? {}) } : agent.env;
  const args = useYolo ? agent.yolo_args?.trim() : "";
  return `${envPrefix(env)}${agent.command}${args ? ` ${args}` : ""}`;
}

export function agentInstallAndRunCommand(
  agent: Pick<AgentOut, "command" | "env" | "install"> & AgentYolo,
): string | null {
  const install = agent.install?.trim();
  return install ? `${install} && ${agentRunCommand(agent)}` : null;
}

export function sortAgents(agents: readonly AgentOut[]): AgentOut[] {
  return [...agents].sort((left, right) => {
    const ownership = Number(left.owner_user_id !== null) - Number(right.owner_user_id !== null);
    return ownership || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}
