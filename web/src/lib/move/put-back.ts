/**
 * What brings Claude Code back on the source when a move is put back.
 *
 * Whoever puts a move back — the device that moved the window, or any other
 * device resolving it — leaves the window running its agent again: the
 * conversation that was moving, resumed on the host it never left, the way
 * Restart resumes it. The line names no permission mode, so Claude Code
 * comes back in the mode the conversation's own record carries there — the
 * mode the window ran in before the move (auto mode, say, when that is where
 * the person left it), never a default a device guessed for the source.
 *
 * A carried resume says its mode outright so that a record cannot bring a
 * mode onto a host where nobody chose it (`agent-relaunch.ts`, `planRelaunch`).
 * A put-back carries nothing: the target never committed, the source's
 * retire put the files back where they were, and the record is the one that
 * host wrote. The line is spelled for the source's login shell. The phone
 * composes the same line (mobile `move-facts.ts`, `putBackLine`).
 */

import { type RelaunchAgent, relaunchLine, shellFamily } from "@/lib/agent-relaunch";
import { type CarrierClient, probeConversation } from "./conv";

/** What the source says about itself, for the line: unknown when it cannot say. */
export interface PutBackFacts {
  /** Its login shell (`conv.probe`), which spells the line. */
  loginShell: string | null;
}

export const NO_PUT_BACK_FACTS: PutBackFacts = { loginShell: null };

/**
 * The line that resumes `conversationId` on the source in the mode its
 * record carries, or null when the agent cannot be resumed — the caller
 * then restarts the ordinary way.
 */
export function putBackLine(
  agent: RelaunchAgent,
  conversationId: string,
  facts: PutBackFacts,
): string | null {
  return relaunchLine(agent, { resume: conversationId }, { shell: shellFamily(facts.loginShell) });
}

/**
 * Ask the source for its shell. Never throws: a source that cannot answer
 * leaves a POSIX line.
 */
export async function readPutBackFacts(
  source: CarrierClient | null,
  query: { conversationId: string; cwd: string },
): Promise<PutBackFacts> {
  if (!source) return NO_PUT_BACK_FACTS;
  try {
    const probe = await probeConversation(source, query);
    return { loginShell: probe.loginShell };
  } catch {
    return NO_PUT_BACK_FACTS;
  }
}
