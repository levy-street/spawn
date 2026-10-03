import { ApiError } from "@/lib/api";
import { displayPath } from "@/lib/places";

/**
 * What moving a window to another host says, before and after. The phone
 * says the same (`mobile/src/components/workspace-detail/move-window.ts`).
 *
 * The window is what moves — its tile, name, skills and alert settings stay
 * with it. What ran in it does not: the shell is stopped here and a new one
 * starts there, and an agent's conversation lives on the machine it ran on,
 * so the agent starts a new one. The confirmation says so plainly, because
 * "move" alone reads as if the work came along.
 */
export function moveWindowConfirmation({
  title,
  hostName,
  cwd,
  agent,
}: {
  title: string;
  hostName: string;
  cwd: string;
  /** Whether the window runs an agent, which starts a new conversation. */
  agent: boolean;
}): { title: string; body: string; confirmLabel: string } {
  const after = agent ? "Its agent starts a new conversation there." : "A new shell starts there.";
  return {
    title: `Move ${title} to ${hostName}?`,
    body: `The window moves to ${displayPath(cwd)} on ${hostName}, and what runs in it here stops. ${after}`,
    confirmLabel: "Move window",
  };
}

/** A refused move, in words: the server's codes name the cases a person can act on. */
export function moveWindowError(error: unknown, hostName: string): string {
  const code = error instanceof ApiError ? error.detail : null;
  if (code === "move_conflict") {
    return "This window was moved from another device in the meantime, so it was left where it is now.";
  }
  if (code === "target_offline") {
    return `${hostName} is offline, so the window stayed where it was.`;
  }
  if (code === "same_host") return `This window already runs on ${hostName}.`;
  return error instanceof Error ? error.message : String(error);
}
