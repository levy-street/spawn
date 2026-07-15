import { agentNeedsAttention } from "@/lib/agents";
import type { Agent, Screen } from "@/lib/api";
import { collectAgentIds } from "@/lib/layout";

/** Agent ids that make up a screen, in tree order. */
export function screenAgentIds(screen: Screen): string[] {
  return collectAgentIds(screen.layout.root ?? null);
}

export function screenPaneCount(screen: Screen): number {
  return screenAgentIds(screen).length;
}

/** Panes on the screen that currently want the operator's attention. */
export function screenAttentionCount(screen: Screen, agentsById: Map<string, Agent>): number {
  return screenAgentIds(screen).filter((id) => {
    const agent = agentsById.get(id);
    return agent && agentNeedsAttention(agent) !== null;
  }).length;
}

/** Recency for sorting the unified Recents list: the newest *input* across
 *  the screen's panes (user-driven, so it doesn't churn while panes stream),
 *  falling back to when the screen layout itself changed. */
export function screenRecency(screen: Screen, agentsById: Map<string, Agent>): number {
  const times = screenAgentIds(screen)
    .map((id) => agentsById.get(id)?.last_input_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const paneMax = times.length > 0 ? Math.max(...times) : 0;
  const updated = Date.parse(screen.updated_at);
  return Math.max(paneMax, Number.isFinite(updated) ? updated : 0);
}

/** Next unused "Screen N" default name. */
export function defaultScreenName(existing: Screen[]): string {
  const names = new Set(existing.map((screen) => screen.name));
  let n = existing.length + 1;
  while (names.has(`Screen ${n}`)) n += 1;
  return `Screen ${n}`;
}
