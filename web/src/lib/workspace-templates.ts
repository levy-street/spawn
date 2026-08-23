import type { Agent, Session, WorkspaceTemplateSpec } from "@/lib/api";
import { runningAgent } from "@/lib/sessions";
import type { LayoutV3 } from "@/lib/tabs";

/**
 * Capture a workspace's shape as a template spec: tab names, tile geometry,
 * and what each tile runs. Folders and hosts are deliberately absent — they
 * are chosen when a workspace is created from the template.
 *
 * What a session tile "runs" is read from the daemon-reported foreground
 * process: when its basename matches the first word of an installed agent's
 * command, the tile is captured as that agent; anything else is a shell.
 */
export function templateSpecFromWorkspace(
  layout: LayoutV3,
  sessionsById: Map<string, Session>,
  agents: Agent[],
): WorkspaceTemplateSpec {
  return {
    version: 2,
    tabs: layout.tabs.map((tab) => ({
      name: tab.name,
      tiles: tab.layout.tiles.map((tile) => ({
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h,
        run: tile.widget
          ? { kind: "files" as const }
          : (agentRun(sessionsById.get(tile.session_id), agents) ?? { kind: "shell" as const }),
      })),
    })),
  };
}

function agentRun(
  session: Session | undefined,
  agents: Agent[],
): { kind: "agent"; command: string } | null {
  const agent = runningAgent(session, agents);
  return agent ? { kind: "agent", command: agent.command } : null;
}
