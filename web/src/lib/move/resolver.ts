/**
 * Settle a move that did not finish — from any device, whoever started it
 * (proto/README.md, "The conversation carrier"; the M6 contract's RESOLVE).
 *
 * The hosts hold the truth, not the server: the source's `conv.transfers`
 * names the move's outgoing transfer and the host it went to, and that
 * host's `conv.import.status` says whether it committed.
 *
 * - Committed there: the move is finished — the source's retire committed,
 *   then the server's carried commit, and the relaunch typed by this device.
 * - Anything else: cancelled there first, and only once that host says
 *   `cancelled` is the source's retire aborted (files back where they were,
 *   never over anything), then the server's move aborted and the window
 *   restarted where the retire stopped it.
 * - The host it went to cannot be reached: nothing is guessed. The move
 *   stays unresolved, since the target may have committed.
 * - No transfer on the source: either the move never got as far as the
 *   retire — the server's abort is all there is, and its answer says whether
 *   to restart — or a retire is under way on another device's behalf: the
 *   source writes its record only once it has stopped the window, which
 *   takes seconds. One empty listing never decides it. The source is asked
 *   whether it runs the window (`conv.inspect`), the listing is read again
 *   after the stop has had time to finish, and the window asked again: only
 *   when nothing changed and still nothing is listed does the source confirm
 *   that nothing is moving, and the server's move is aborted. Otherwise the
 *   source is left to settle and the person is asked to try again.
 * - The target committed and the server's carried commit is refused as
 *   settled: the row is read again (`server.ts`), as the mover reads it.
 *
 * The server keeps no time for when a move began, so Resolve is offered at
 * once; a mover still at work in this browser hides it (`move-hub.ts`).
 * Where a host cannot answer at all, the person may give the move up
 * (`giveUpMove`): the server's move ends and neither host is touched.
 */

import {
  canonicalConversationId,
  planRelaunch,
  type RelaunchAgent,
  type RelaunchPlan,
} from "@/lib/agent-relaunch";
import type { ConversationState } from "@/lib/conversation";
import {
  abortRetire,
  type CarrierClient,
  cancelImport,
  commitRetire,
  errorCode,
  importStatus,
  listTransfers,
  type OutgoingTransfer,
  probeConversation,
  windowRuns,
} from "./conv";
import { defaultPermissionMode, readTargetSettings } from "./permission-modes";
import { putBackLine, readPutBackFacts } from "./put-back";
import {
  type MoveServerPort,
  readAfterCommitConflict,
  serverCode,
  takeWindowThere,
} from "./server";

export interface ResolveHost {
  hostId: string;
  name: string;
  os: string | null;
}

export interface ResolveRequest {
  sessionId: string;
  /** Where the window's row says it runs: the source, while it moves. */
  source: ResolveHost;
  /** The host the move went to, as the server names hosts. */
  hostById: (hostId: string) => ResolveHost | null;
  /** The window's folder: where it continues when this browser does not
   *  know the folder the mover picked. */
  cwd: string;
  /** The folder the mover picked on the target, when this browser knows it. */
  targetCwd?: string | null;
  agent: RelaunchAgent;
  /** The conversation the window's row names, for a put-back with no
   *  transfer to name it. */
  conversationId?: string | null;
  /** Whether the server still has the window moving: false settles the hosts only. */
  serverMoving: boolean;
  /** Only this transfer (the host cockpit's list); otherwise the window's newest. */
  transferId?: string;
  /** The window a transfer names, as the server has it now: a host's page
   *  resolving a transfer finds its window this way. */
  windowOf?: (sessionId: string) => { cwd: string; moving: boolean } | null;
}

export interface ResolvePorts {
  server: MoveServerPort;
  /** A ready client for a host, or a rejection when it cannot be reached. */
  host(hostId: string): Promise<CarrierClient>;
  /** Reads at most `limit` bytes of a file on a host as text (`fs.read`). */
  readText?(client: CarrierClient, path: string, limit: number): Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  launcher: {
    prepareOn(hostId: string, plan: RelaunchPlan | null): Promise<void>;
    abandon(): void;
    /** Restart the window on the source, `line` queued for this device to
     *  type there (it takes the window's display to do it); with no line,
     *  the ordinary restart. */
    restartOnSource(line: string | null): Promise<void>;
    refetch(): void;
  };
}

export type ResolveOutcome =
  | { kind: "finished"; targetHostId: string; archived: boolean }
  | { kind: "put_back"; restarted: boolean; conflicts: boolean }
  | { kind: "source_unreachable" }
  | { kind: "target_unreachable"; targetHostId: string | null }
  /** The source did not confirm that nothing is moving: a retire may be
   *  under way. Nothing was touched; try again in a moment. */
  | { kind: "source_busy" }
  /** The conversation is on the target and the window is not: offered to
   *  take the window there, into `conversationId`, in `cwd`. */
  | { kind: "on_target"; targetHostId: string; cwd: string; conversationId: string }
  /** Given up without the host that could not answer: the server's move
   *  ended, and neither host was touched. */
  | { kind: "given_up" }
  | { kind: "elsewhere" }
  | { kind: "gone" }
  | { kind: "failed" };

/**
 * How long the source is given to finish stopping a window before its
 * empty listing is believed: a retire stops the window's worker (TERM, then
 * KILL), then the window's own Claude processes (3 s, then 2 s), and only
 * then writes its record.
 */
export const SOURCE_SETTLE_WAITS_MS = [2_000, 3_000, 5_000];

async function abortOnServer(
  request: ResolveRequest,
  ports: ResolvePorts,
  retireRan: boolean,
  conflicts: boolean,
  put: { source: CarrierClient; conversationId: string | null },
): Promise<ResolveOutcome> {
  if (!request.serverMoving) return { kind: "put_back", restarted: false, conflicts };
  let status: string;
  try {
    status = (await ports.server.abort(request.sessionId, request.source.hostId)).status;
  } catch (error) {
    ports.launcher.refetch();
    const code = serverCode(error);
    if (code === "move_conflict") return { kind: "elsewhere" };
    if (code === "not_found") return { kind: "gone" };
    return { kind: "failed" };
  }
  ports.launcher.refetch();
  const restart = status === "killed" || retireRan;
  if (restart) {
    try {
      await ports.launcher.restartOnSource(await resumeLine(request, ports, put));
    } catch {
      // The stopped pane offers Restart itself.
    }
  }
  return { kind: "put_back", restarted: restart, conflicts };
}

/**
 * Whoever puts a move back leaves the window running its agent: the line
 * that resumes the conversation on the source, its mode explicit
 * (`put-back.ts`). Null when there is no conversation to name — the
 * restart then goes the ordinary way.
 */
async function resumeLine(
  request: ResolveRequest,
  ports: ResolvePorts,
  put: { source: CarrierClient; conversationId: string | null },
): Promise<string | null> {
  const conversationId = canonicalConversationId(
    put.conversationId ?? request.conversationId ?? null,
  );
  if (!conversationId) return null;
  const facts = await readPutBackFacts(
    put.source,
    { conversationId, cwd: request.cwd },
    ports.readText,
  );
  return putBackLine(request.agent, conversationId, facts);
}

/** The folder a resolver starts the window in on the target when it was
 *  not the mover: the source folder, home-relative, which is where a move
 *  most often lands (the phone guesses the same: `guessTargetCwd`). */
export function guessTargetCwd(sourceCwd: string, sourceHome: string | null): string {
  if (sourceHome && (sourceCwd === sourceHome || sourceCwd.startsWith(`${sourceHome}/`)))
    return `~${sourceCwd.slice(sourceHome.length)}`;
  return sourceCwd;
}

async function finish(
  request: ResolveRequest,
  ports: ResolvePorts,
  source: CarrierClient,
  target: CarrierClient,
  outgoing: OutgoingTransfer,
  targetHost: ResolveHost,
): Promise<ResolveOutcome> {
  if (outgoing.length !== null && outgoing.sha256) {
    try {
      await commitRetire(source, {
        transferId: outgoing.transferId,
        length: outgoing.length,
        sha256: outgoing.sha256,
      });
    } catch {
      // Committed already by someone, or left aside for a later Resolve:
      // the window's move goes on either way.
    }
  }
  if (!request.serverMoving)
    return { kind: "finished", targetHostId: targetHost.hostId, archived: false };
  const conversationId = outgoing.conversationId;
  if (!conversationId) return { kind: "failed" };
  let cwd = request.targetCwd ?? null;
  if (!cwd) {
    const home = await probeConversation(source, { conversationId: null, cwd: request.cwd })
      .then((probe) => probe.home)
      .catch(() => null);
    cwd = guessTargetCwd(request.cwd, home);
  }
  let memory: string | null = null;
  let shell: string | null = null;
  let landed: string | null = null;
  let settings: string | null = null;
  try {
    const probe = await probeConversation(target, { conversationId, cwd });
    memory = probe.memory;
    shell = probe.loginShell;
    landed = probe.cwd;
    settings = await readTargetSettings(probe.store, (path, limit) =>
      ports.readText ? ports.readText(target, path, limit) : Promise.resolve(null),
    );
  } catch {
    // The note goes without the memory sentence; the line as for POSIX.
  }
  // The state when it moved is not known here: the note is the idle one,
  // typed for the person's next message and never sent.
  const state: ConversationState = "unknown";
  const plan = planRelaunch({
    agent: request.agent,
    conversation: { resume: conversationId },
    permissionMode: defaultPermissionMode(request.agent, settings),
    shell,
    note: {
      from: { name: request.source.name, os: request.source.os },
      to: { name: targetHost.name, os: targetHost.os },
      cwd: landed ?? cwd,
      memoryPath: memory,
      state,
    },
  });
  return commitCarried(request, ports, plan, conversationId, cwd, targetHost);
}

/** The carried commit, read again when it is refused as settled. */
async function commitCarried(
  request: ResolveRequest,
  ports: ResolvePorts,
  plan: RelaunchPlan | null,
  conversationId: string,
  cwd: string,
  targetHost: ResolveHost,
): Promise<ResolveOutcome> {
  for (let rebegun = 0; ; rebegun += 1) {
    await ports.launcher.prepareOn(targetHost.hostId, plan);
    let status: string;
    try {
      status = (
        await ports.server.commit(request.sessionId, {
          host_id: targetHost.hostId,
          cwd,
          expected_host_id: request.source.hostId,
          agent_session_id: conversationId,
          carried: true,
        })
      ).status;
    } catch (error) {
      ports.launcher.abandon();
      ports.launcher.refetch();
      const code = serverCode(error);
      if (code === "not_found") return { kind: "gone" };
      if (code === "target_offline")
        return { kind: "target_unreachable", targetHostId: targetHost.hostId };
      if (code !== "move_conflict" && code !== "move_in_progress") return { kind: "failed" };
      const reading = await readAfterCommitConflict(ports.server, {
        sessionId: request.sessionId,
        sourceHostId: request.source.hostId,
        targetHostId: targetHost.hostId,
      });
      if (reading === "arrived")
        return { kind: "finished", targetHostId: targetHost.hostId, archived: false };
      if (reading === "rebegun" && rebegun < 3) continue;
      if (reading === "gone") return { kind: "gone" };
      if (reading === "unknown") return { kind: "failed" };
      return { kind: "on_target", targetHostId: targetHost.hostId, cwd, conversationId };
    }
    ports.launcher.refetch();
    if (status === "killed") ports.launcher.abandon();
    return { kind: "finished", targetHostId: targetHost.hostId, archived: status === "killed" };
  }
}

/**
 * The conversation is on the target and the window is not: take the window
 * there into it. The resume is queued for it as for a finished move.
 */
export async function takeWindowToConversation(
  request: Pick<ResolveRequest, "sessionId" | "source" | "agent"> & {
    target: ResolveHost;
    cwd: string;
    conversationId: string;
  },
  ports: Pick<ResolvePorts, "server" | "launcher">,
): Promise<ResolveOutcome> {
  const plan = planRelaunch({
    agent: request.agent,
    conversation: { resume: request.conversationId },
    permissionMode: defaultPermissionMode(request.agent, null),
    shell: null,
    note: {
      from: { name: request.source.name, os: request.source.os },
      to: { name: request.target.name, os: request.target.os },
      cwd: request.cwd,
      memoryPath: null,
      state: "unknown",
    },
  });
  const result = await takeWindowThere(
    ports.server,
    {
      prepare: () => ports.launcher.prepareOn(request.target.hostId, plan),
      abandon: () => ports.launcher.abandon(),
    },
    {
      sessionId: request.sessionId,
      targetHostId: request.target.hostId,
      cwd: request.cwd,
      conversationId: request.conversationId,
    },
  );
  ports.launcher.refetch();
  if (result === "moved" || result === "arrived")
    return { kind: "finished", targetHostId: request.target.hostId, archived: false };
  if (result === "gone") return { kind: "gone" };
  if (result === "target_offline")
    return { kind: "target_unreachable", targetHostId: request.target.hostId };
  return {
    kind: "on_target",
    targetHostId: request.target.hostId,
    cwd: request.cwd,
    conversationId: request.conversationId,
  };
}

/** Settle one unfinished move. Never throws; the outcome says what happened. */
export async function resolveMove(
  given: ResolveRequest,
  ports: ResolvePorts,
): Promise<ResolveOutcome> {
  let request = given;
  let source: CarrierClient;
  try {
    source = await ports.host(request.source.hostId);
  } catch {
    return { kind: "source_unreachable" };
  }
  const find = async (): Promise<OutgoingTransfer | undefined> => {
    const transfers = await listTransfers(source);
    const mine = transfers.outgoing.filter((entry) =>
      request.transferId
        ? entry.transferId === request.transferId
        : entry.sessionId === request.sessionId,
    );
    return mine.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  };
  let outgoing: OutgoingTransfer | undefined;
  try {
    outgoing = await find();
  } catch {
    return { kind: "source_unreachable" };
  }
  if (!outgoing) {
    if (!request.serverMoving || !request.sessionId || request.transferId)
      return abortOnServer(request, ports, false, false, { source, conversationId: null });
    // A retire may be under way: its record lands only once the window has
    // stopped. Never decided on one empty listing.
    const sleep = ports.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
    const before = await windowRuns(source, request.sessionId);
    try {
      for (const wait of SOURCE_SETTLE_WAITS_MS) {
        await sleep(wait);
        outgoing = await find();
        if (outgoing) break;
      }
    } catch {
      return { kind: "source_unreachable" };
    }
    if (!outgoing) {
      const after = await windowRuns(source, request.sessionId);
      // The source confirms nothing is moving only when it answered both
      // times and the window neither stopped nor started meanwhile.
      if (before === null || after === null || before !== after) return { kind: "source_busy" };
      return abortOnServer(request, ports, false, false, { source, conversationId: null });
    }
  }
  // A host's page knows the transfer, not the window: the source's record
  // names it, and the server says whether it is still moving.
  const named = outgoing.sessionId ? request.windowOf?.(outgoing.sessionId) : undefined;
  if (named !== undefined && outgoing.sessionId) {
    request = {
      ...request,
      sessionId: outgoing.sessionId,
      cwd: named?.cwd ?? request.cwd,
      serverMoving: named?.moving ?? false,
    };
  }

  // A transfer stranded part-way: only an abort ends it, never a commit.
  if (outgoing.state === "stranded") return putBackFromSource(request, ports, source, outgoing);

  const targetHost = outgoing.toHostId ? request.hostById(outgoing.toHostId) : null;
  if (!outgoing.toHostId || !targetHost)
    return { kind: "target_unreachable", targetHostId: outgoing.toHostId };
  let target: CarrierClient;
  try {
    target = await ports.host(outgoing.toHostId);
  } catch {
    return { kind: "target_unreachable", targetHostId: outgoing.toHostId };
  }
  let committed = false;
  try {
    committed = (await importStatus(target, outgoing.transferId)).state === "committed";
  } catch {
    return { kind: "target_unreachable", targetHostId: outgoing.toHostId };
  }
  if (!committed) {
    // Only the target's own `cancelled` lets the source take its files back.
    try {
      const answer = await cancelImport(target, outgoing.transferId);
      if (answer.state === "committed") committed = true;
      else if (answer.state !== "cancelled")
        return { kind: "target_unreachable", targetHostId: outgoing.toHostId };
    } catch (error) {
      if (errorCode(error) !== "transfer_committed")
        return { kind: "target_unreachable", targetHostId: outgoing.toHostId };
      committed = true;
    }
  }
  if (committed) return finish(request, ports, source, target, outgoing, targetHost);
  return putBackFromSource(request, ports, source, outgoing);
}

async function putBackFromSource(
  request: ResolveRequest,
  ports: ResolvePorts,
  source: CarrierClient,
  outgoing: OutgoingTransfer,
): Promise<ResolveOutcome> {
  let conflicts = false;
  try {
    await abortRetire(source, outgoing.transferId);
  } catch (error) {
    const code = errorCode(error);
    if (code === "already_exists") conflicts = true;
    else if (code !== "transfer_aborted" && code !== "transfer_not_found")
      return { kind: "source_unreachable" };
  }
  // The source listed the transfer: its retire ran, and stopped the window.
  return abortOnServer(request, ports, true, conflicts, {
    source,
    conversationId: outgoing.conversationId,
  });
}

/**
 * Give a move up when a host it needs cannot answer — the source, or the
 * host it was going to, gone for good or only away: the server's move ends
 * and the window reads stopped on the source. Neither host is touched: the
 * conversation stays where it is — set aside on the source, or already on
 * the target — until a Resolve from the source's page reaches both (the
 * page lists the transfer). A retire is never aborted without the target's
 * `cancelled`.
 */
export async function giveUpMove(
  request: Pick<ResolveRequest, "sessionId" | "source">,
  server: MoveServerPort,
): Promise<ResolveOutcome> {
  try {
    await server.abort(request.sessionId, request.source.hostId);
  } catch (error) {
    const code = serverCode(error);
    if (code === "move_conflict") return { kind: "elsewhere" };
    if (code === "not_found") return { kind: "gone" };
    return { kind: "failed" };
  }
  return { kind: "given_up" };
}
