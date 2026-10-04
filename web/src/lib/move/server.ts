/**
 * The server's side of a move once the target has committed the
 * conversation: from there the move may only finish (the M6 contract: "once
 * the target has answered stream.committed, never abort").
 *
 * A carried commit refused with `move_conflict` or `move_in_progress` does
 * not by itself mean that someone else finished the move. A resolver on
 * another device can have aborted the server's move underneath a carry that
 * was still at work — it found no transfer record on the source yet, since
 * the source writes it only once the window has stopped — and put the window
 * back on the source, while the conversation went on to the target all the
 * same. So the window's row is read again and the move is finished from
 * there: never reported as settled elsewhere without looking.
 *
 * Pure of React and the network: the server is a port, as in the
 * orchestrator.
 */

export interface MoveRow {
  host_id: string;
  status: string;
}

/** The server's move routes, and the two reads a finished carry needs. */
export interface MoveServerPort {
  begin(sessionId: string, expectedHostId: string): Promise<{ status: string }>;
  commit(
    sessionId: string,
    body: {
      host_id: string;
      cwd: string;
      expected_host_id: string;
      agent_session_id: string;
      carried: true;
    },
  ): Promise<{ status: string }>;
  abort(sessionId: string, expectedHostId: string): Promise<{ status: string }>;
  /** The window's row as the server has it now. */
  get(sessionId: string): Promise<MoveRow>;
  /** A fresh move (`/move` without `carried`): the window runs on `host_id`
   *  in the conversation `agent_session_id` names. */
  fresh(
    sessionId: string,
    body: { host_id: string; cwd: string; expected_host_id: string; agent_session_id: string },
  ): Promise<{ status: string }>;
}

/** The server's code for a refused request: its `detail`, `not_found` for a
 *  404, `network` when no answer came. */
export function serverCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    const status = (error as { status?: unknown }).status;
    if (status === 404) return "not_found";
  }
  return "network";
}

/**
 * Where the window stands after a carried commit was refused, the target
 * having committed:
 *
 * - `arrived`: the row names the target — the move is finished, by another
 *   device or by an earlier commit of this one whose answer was lost.
 * - `rebegun`: the row was put back on the source underneath the carry and
 *   is no longer moving; the move was begun again there, so the same
 *   carried commit can go again — the target committed, so it may only
 *   finish.
 * - `stranded`: the conversation is on the target and the window is not,
 *   and it cannot be begun again (another move under way, the source
 *   offline, an archived workspace, or another host): the person is told
 *   plainly and offered to take the window there.
 * - `gone`: the window was closed.
 * - `unknown`: the server could not be asked; try again.
 */
export type CommitConflictReading = "arrived" | "rebegun" | "stranded" | "gone" | "unknown";

export async function readAfterCommitConflict(
  server: MoveServerPort,
  ids: { sessionId: string; sourceHostId: string; targetHostId: string },
): Promise<CommitConflictReading> {
  let row: MoveRow;
  try {
    row = await server.get(ids.sessionId);
  } catch (error) {
    return serverCode(error) === "not_found" ? "gone" : "unknown";
  }
  if (row.host_id === ids.targetHostId) return "arrived";
  if (row.host_id !== ids.sourceHostId || row.status === "moving") return "stranded";
  try {
    await server.begin(ids.sessionId, ids.sourceHostId);
    return "rebegun";
  } catch (error) {
    const code = serverCode(error);
    if (code === "not_found") return "gone";
    if (code === "move_conflict" || code === "network") return "unknown";
    return "stranded";
  }
}

/** How taking the window to the conversation went. */
export type TakeThereResult =
  /** The window runs there now, its relaunch queued. */
  | "moved"
  /** It was there already: someone else took it; nothing is typed. */
  | "arrived"
  | "gone"
  | "move_in_progress"
  | "workspace_archived"
  | "target_offline"
  | "failed";

/**
 * The conversation is on the target and the window is not: move the window
 * there (a fresh `/move` naming the conversation), with its relaunch queued
 * before the commit as a carried move queues it.
 */
export async function takeWindowThere(
  server: MoveServerPort,
  launch: { prepare(): Promise<void>; abandon(): void },
  ids: { sessionId: string; targetHostId: string; cwd: string; conversationId: string },
): Promise<TakeThereResult> {
  let row: MoveRow;
  try {
    row = await server.get(ids.sessionId);
  } catch (error) {
    return serverCode(error) === "not_found" ? "gone" : "failed";
  }
  if (row.host_id === ids.targetHostId) return "arrived";
  await launch.prepare();
  try {
    await server.fresh(ids.sessionId, {
      host_id: ids.targetHostId,
      cwd: ids.cwd,
      expected_host_id: row.host_id,
      agent_session_id: ids.conversationId,
    });
    return "moved";
  } catch (error) {
    launch.abandon();
    const code = serverCode(error);
    if (code === "not_found") return "gone";
    if (code === "move_in_progress" || code === "workspace_archived" || code === "target_offline")
      return code;
    return "failed";
  }
}
