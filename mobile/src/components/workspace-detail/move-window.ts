import type { QueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { pendingLaunches } from "@/components/launcher/pending-launch";
import { MOVE_IN_PROGRESS, MOVE_WORKSPACE_ARCHIVED } from "@/components/workspace-detail/move-copy";
import { ApiError } from "@/data/api/client";
import { moveSession } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import { agentLaunchCommand, newAgentConversationId, sessionAgent } from "@/data/selectors/agent";
import { displayPath } from "@/data/selectors/places";
import type { AgentDef, Host, Session } from "@/data/types/domain";

/**
 * What moving a window to another host says, before and after. The browser
 * says the same (`web/src/components/workspace/move-window.ts`).
 *
 * The window is what moves — its place in the tab, name, skills and alert
 * settings stay with it. What ran in it does not: the shell is stopped here
 * and a new one starts there, and an agent's conversation lives on the machine
 * it ran on, so the agent starts a new one. The confirmation says so plainly,
 * because "move" alone reads as if the work came along.
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
}): { title: string; description: string; confirmLabel: string } {
  const after = agent ? "Its agent starts a new conversation there." : "A new shell starts there.";
  return {
    title: `Move ${title} to ${hostName}?`,
    description: `The window moves to ${displayPath(cwd)} on ${hostName}, and what runs in it here stops. ${after}`,
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
  if (code === "move_in_progress") return MOVE_IN_PROGRESS;
  if (code === "workspace_archived") return MOVE_WORKSPACE_ARCHIVED;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Move a pane's window to `cwd` on another host with a new conversation. The
 * window itself moves — the same session — so its tile, name, skills and
 * alert settings stay where they are. What ran in it stops here and starts
 * fresh there: a shell, or the same agent in a new conversation, queued for
 * this device to type when it opens the window over there — into that
 * host's shell only. Nothing changes if the server refuses: a host gone
 * offline, a move from another device that landed first, a carry under way.
 * A Claude Code window on hosts that carry moves with its conversation
 * instead (`move-conversation.ts`); this is its "Start fresh instead".
 */
export async function moveWindowFresh(
  client: QueryClient,
  session: Session,
  host: Host,
  cwd: string,
  agents: readonly AgentDef[],
): Promise<Session> {
  const invalidateSessions = () => client.invalidateQueries({ queryKey: qk.sessions() });
  const agent = sessionAgent(session, agents);
  const conversation = agent ? newAgentConversationId(agent.kind, randomUUID) : null;
  // A read already in flight left the server before the move. Landing
  // after it, it would put the window back on the host it left.
  await Promise.all([
    client.cancelQueries({ queryKey: qk.sessions() }),
    client.cancelQueries({ queryKey: qk.session(session.id), exact: true }),
  ]);
  let moved: Session;
  try {
    moved = await moveSession(session.id, {
      host_id: host.id,
      cwd,
      expected_host_id: session.host_id,
      // The agent it starts over there is what the window is, even when
      // nothing recorded it: someone typed `claude` into a shell.
      ...(agent ? { agent_id: agent.id } : {}),
      agent_session_id: conversation,
    });
  } catch (error) {
    // Refused or not, this screen's picture of the window may be stale.
    await invalidateSessions();
    throw new Error(moveWindowError(error, host.name));
  }

  let launchError: Error | null = null;
  if (agent) {
    try {
      await pendingLaunches.persist(
        moved.id,
        moved.host_id,
        agentLaunchCommand(agent, conversation),
      );
    } catch {
      launchError = new Error(
        `The window moved to ${host.name} as a shell, but ${agent.name} could not be queued.`,
      );
    }
  }
  client.setQueryData(qk.session(moved.id), moved);
  client.setQueryData<Session[]>(qk.sessions(), (current) =>
    current?.map((item) => (item.id === moved.id ? moved : item)),
  );
  await invalidateSessions();
  if (launchError) throw launchError;
  return moved;
}
