/**
 * The permission mode Claude Code starts in after a move. Every resume line
 * SPAWN D types after a move names one (`--permission-mode`): `claude
 * --resume` otherwise restores the mode its record carries — auto or accept
 * edits — and a carried record must never bring back a mode the person did
 * not choose on the receiving host.
 *
 * Names are Claude Code's own indicators ("manual mode", "plan mode", …),
 * the words its footer shows, read out of its binary; `default` is written
 * on the line, which every release accepts (`agent-relaunch.ts`). The phone
 * lists the same six with the same words, in the same order, and starts on
 * the same one (mobile `move-facts.ts`).
 */

import { type AgentYolo, agentYoloAvailable } from "@/lib/agent-relaunch";

export interface PermissionModeChoice {
  /** As `--permission-mode` takes it. */
  mode: string;
  /** Claude Code's own indicator for it. */
  label: string;
  /** One line on what it does. */
  description: string;
}

export const PERMISSION_MODES: readonly PermissionModeChoice[] = [
  { mode: "default", label: "manual mode", description: "Asks before edits and commands" },
  { mode: "acceptEdits", label: "accept edits", description: "Edits files without asking" },
  { mode: "plan", label: "plan mode", description: "Plans without changing anything" },
  { mode: "auto", label: "auto mode", description: "Decides for itself what to ask about" },
  { mode: "dontAsk", label: "don't ask", description: "Refuses whatever isn't already allowed" },
  {
    mode: "bypassPermissions",
    label: "bypass permissions",
    description: "Never asks — what a yolo window runs in",
  },
];

export function permissionModeLabel(mode: string): string {
  return PERMISSION_MODES.find((choice) => choice.mode === mode)?.label ?? mode;
}

/** How much of the target's settings file is read: it is small. */
export const SETTINGS_LIMIT_BYTES = 64 * 1024;

/**
 * The target's own Claude Code settings (`<store>/settings.json`), read over
 * this device's channel; null when there is no store or nothing to read.
 */
export async function readTargetSettings(
  store: string | null | undefined,
  read: (path: string, limit: number) => Promise<string | null>,
): Promise<string | null> {
  if (!store) return null;
  const path = `${store.replace(/\/+$/, "")}/settings.json`;
  return read(path, SETTINGS_LIMIT_BYTES).catch(() => null);
}

/**
 * Where the picker starts: what a fresh window of this agent would start in
 * there. A window in yolo mode keeps skipping its prompts (bypass
 * permissions, where its agent has a yolo mode at all); otherwise the
 * target's own default — `permissions.defaultMode` in its settings, the
 * mode the person chose on that host, when it is one of the six ("manual"
 * is `default`) — else Claude Code's default. Never the mode the carried
 * record had, and nothing from the settings file but one of the six names
 * ever reaches the command line.
 */
export function defaultPermissionMode(agent: AgentYolo, targetSettings: string | null): string {
  if (agent.yolo === true && agentYoloAvailable(agent)) return "bypassPermissions";
  if (targetSettings) {
    try {
      const parsed = JSON.parse(targetSettings) as { permissions?: { defaultMode?: unknown } };
      const mode = parsed?.permissions?.defaultMode;
      if (mode === "manual") return "default";
      if (typeof mode === "string" && PERMISSION_MODES.some((choice) => choice.mode === mode))
        return mode;
    } catch {
      // A settings file that is not JSON names no default.
    }
  }
  return "default";
}
