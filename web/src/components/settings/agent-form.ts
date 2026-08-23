import type { Agent, AgentCreateInput } from "@/lib/api";

export type AgentEnvRow = { id: string; key: string; value: string };

export type AgentDraft = {
  name: string;
  kind: string;
  command: string;
  install: string;
  env: AgentEnvRow[];
  /** Arguments appended when this agent is launched in yolo mode. Blank means
   *  the agent has no such mode and its toggle is not offered. */
  yoloArgs: string;
};

export function agentDraft(agent?: Agent): AgentDraft {
  return {
    name: agent?.name ?? "",
    kind: agent?.kind ?? "custom",
    command: agent?.command ?? "",
    install: agent?.install ?? "",
    yoloArgs: agent?.yolo_args ?? "",
    env: Object.entries(agent?.env ?? {}).map(([key, value], index) => ({
      id: `${agent?.id ?? "new"}-${index}`,
      key,
      value,
    })),
  };
}

export function agentDraftToInput(draft: AgentDraft): AgentCreateInput {
  const env: Record<string, string> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (key) env[key] = row.value;
  }
  return {
    name: draft.name.trim(),
    kind: draft.kind.trim(),
    command: draft.command.trim(),
    env,
    install: draft.install.trim() || null,
    yolo_args: draft.yoloArgs.trim() || null,
  };
}
