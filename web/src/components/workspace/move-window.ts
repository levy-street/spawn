import type { QueryClient } from "@tanstack/react-query";
import { incarnationKey, openIntent } from "@/components/terminal/incarnation";
import { type Agent, ApiError, type Host, type Session, sessions } from "@/lib/api";
import { failureCopy } from "@/lib/move/copy";
import { displayPath } from "@/lib/places";
import { agentLaunchCommand, newAgentConversationId } from "./agent-command";
import { pendingLaunch } from "./pending-launch";

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
  agentLine,
}: {
  title: string;
  hostName: string;
  cwd: string;
  /** Whether the window runs an agent, which starts a new conversation. */
  agent: boolean;
  /** Why that agent's conversation stays behind, in its own words
   *  (`lib/move/copy.ts`: `freshAgentLine`, `needsNewerSpawnLine`). */
  agentLine?: string;
}): { title: string; body: string; confirmLabel: string } {
  const after =
    agentLine ??
    (agent ? "Its agent starts a new conversation there." : "A new shell starts there.");
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
  // A fresh move is refused while the window moves, and in an archived
  // workspace: said in words, as the phone says them, never as the code.
  if (code === "move_in_progress" || code === "workspace_archived")
    return failureCopy(code, { source: "", target: hostName, cwd: "" }).message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Move a window to `cwd` on `host`, as the device that moves it: this tab
 * takes the display there and types the agent's launch, while every other
 * device's terminal follows the window without taking control.
 *
 * The order is the point.
 * - In-flight reads of the window are cancelled first: one that left the
 *   server before the move, landing after it, would put the window back on
 *   the host it left.
 * - The open intent is marked before the request goes out. This tab can hear
 *   of the move before its own response arrives — a list poll answered after
 *   the server's commit refetches the window's row — and the terminal that
 *   mounts for the new host then must take the display, not follow. A refused
 *   move clears it.
 * - The launch is queued only once the move has happened, for the new host:
 *   typed into the old host's shell it would die with it. It is queued before
 *   the caches hear of the move, because the pane's terminal for the new host
 *   mounts from them and must find it.
 *
 * Resolves with the moved row; rejects with the server's refusal.
 */
export async function moveWindow({
  queryClient,
  session,
  host,
  cwd,
  agent,
  move = sessions.move,
}: {
  queryClient: QueryClient;
  session: Session;
  host: Pick<Host, "id">;
  cwd: string;
  /** The agent the window runs, which starts over there; null for a shell. */
  agent: Agent | null;
  move?: typeof sessions.move;
}): Promise<Session> {
  // A conversation of its own over there: an agent's history lives on the
  // machine it ran on, and nothing of it travels.
  const conversation = agent ? newAgentConversationId(agent.kind) : null;
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ["sessions"] }),
    queryClient.cancelQueries({ queryKey: ["session", session.id], exact: true }),
  ]);
  const intent = incarnationKey(session.id, host.id);
  openIntent.mark(intent);
  let moved: Session;
  try {
    moved = await move(session.id, {
      host_id: host.id,
      cwd,
      expected_host_id: session.host_id,
      // The agent it starts over there is what the window is, even when
      // nothing recorded it: someone typed `claude` into a shell.
      ...(agent && { agent_id: agent.id }),
      agent_session_id: conversation,
    });
  } catch (error) {
    openIntent.clear(intent);
    throw error;
  }
  if (agent) pendingLaunch.set(session.id, moved.host_id, agentLaunchCommand(agent, conversation));
  queryClient.setQueryData(["session", session.id], moved);
  queryClient.setQueryData<Session[]>(["sessions"], (current) =>
    current?.map((item) => (item.id === session.id ? moved : item)),
  );
  return moved;
}
