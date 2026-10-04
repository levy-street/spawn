/**
 * What brings Claude Code back on the source when a move is put back.
 *
 * Whoever puts a move back — the device that moved the window, or any other
 * device resolving it — leaves the window running its agent again: the
 * conversation that was moving, resumed with an explicit `--permission-mode`
 * like every line SPAWN D types after a move, never the mode its record ran
 * in. The mode is the one a fresh window of this agent starts in there
 * (`defaultPermissionMode`): bypass permissions for a yolo window, else the
 * source's own `permissions.defaultMode`, else manual mode. The line is
 * spelled for the source's login shell. The phone composes the same line
 * (mobile `move-facts.ts`, `putBackLine`).
 */

import { type RelaunchAgent, relaunchLine, shellFamily } from "@/lib/agent-relaunch";
import { type CarrierClient, probeConversation } from "./conv";
import { defaultPermissionMode, readTargetSettings } from "./permission-modes";

/** What the source says about itself, for the line: either may be unknown. */
export interface PutBackFacts {
  /** Its login shell (`conv.probe`), which spells the line. */
  loginShell: string | null;
  /** Its Claude Code settings file, for `permissions.defaultMode`. */
  settings: string | null;
}

export const NO_PUT_BACK_FACTS: PutBackFacts = { loginShell: null, settings: null };

/**
 * The line that resumes `conversationId` on the source, or null when it
 * cannot be said with a mode (an agent with no permission-mode flag) — the
 * caller then restarts the ordinary way.
 */
export function putBackLine(
  agent: RelaunchAgent,
  conversationId: string,
  facts: PutBackFacts,
): string | null {
  return relaunchLine(
    agent,
    { resume: conversationId },
    {
      shell: shellFamily(facts.loginShell),
      permissionMode: defaultPermissionMode(agent, facts.settings),
    },
  );
}

/**
 * Ask the source for its shell and settings. Never throws: a source that
 * cannot answer leaves a POSIX line in the agent's default mode.
 */
export async function readPutBackFacts(
  source: CarrierClient | null,
  query: { conversationId: string; cwd: string },
  readText?: (client: CarrierClient, path: string, limit: number) => Promise<string | null>,
): Promise<PutBackFacts> {
  if (!source) return NO_PUT_BACK_FACTS;
  try {
    const probe = await probeConversation(source, query);
    const settings = await readTargetSettings(probe.store, (path, limit) =>
      readText ? readText(source, path, limit) : Promise.resolve(null),
    );
    return { loginShell: probe.loginShell, settings };
  } catch {
    return NO_PUT_BACK_FACTS;
  }
}
