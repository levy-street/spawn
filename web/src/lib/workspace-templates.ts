import type { Agent, Session, WorkspaceTemplateSpec } from "@/lib/api";
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
    version: 1,
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
  const foreground = session?.foreground_command?.trim().toLowerCase();
  if (!foreground) return null;
  const agent = agents.find((item) => {
    const first = item.command.trim().split(/\s+/u)[0] ?? "";
    return (first.split("/").pop() ?? "").toLowerCase() === foreground;
  });
  return agent ? { kind: "agent", command: agent.command } : null;
}
