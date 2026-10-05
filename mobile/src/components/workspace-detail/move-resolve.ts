import type { MoveArrival } from "@/components/launcher/pending-agent-input";
import {
  type MoveChannel,
  type MoveChannelLease,
  type MoveDeps,
  type MoveHost,
  putBackResume,
} from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import { ApiError } from "@/data/api/client";
import { planRelaunch } from "@/data/selectors/agent-relaunch";
import { defaultPermissionMode, joinHostPath } from "@/data/selectors/move-facts";
import { displayPath } from "@/data/selectors/places";
import type { AgentDef, Session } from "@/data/types/domain";
import {
  CONVERSATION_CARRIER_CAPABILITY,
  type IncomingConversationTransfer,
  type OutgoingConversationTransfer,
} from "@/terminal/transport/conversation-codec";
import { canonicalConversationId } from "@/terminal/transport/conversation-id";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";

/**
 * Finish or undo a move that did not finish — from any device, not only the
 * one that started it (proto/README.md, "The conversation carrier"). The
 * hosts hold the truth: the source lists its unfinished transfers
 * (`conv.transfers`), each naming the host it went to, and only that host is
 * asked how far it got (`conv.import.status`). A committed import finishes
 * the move; anything else is cancelled there and, once that host has
 * answered "cancelled", the source puts its files back.
 *
 * Nothing is decided on an answer this device could not get, nor on one
 * empty listing: a retire writes its record only once it has stopped the
 * window, so a move still at work on another device may not be listed yet.
 * The listing is read again a moment later, and the server's move is ended
 * without a record only when the source confirms nothing is moving — its
 * window runs (a retire stops it before anything else), or the conversation
 * is still where Claude Code looks. A host that cannot answer leaves the
 * move as it is, and the person may give it up on the server alone
 * (`giveUpMove`). The browser resolves the same way
 * (web/src/lib/move/resolver.ts).
 */

type Unreachable = {
  readonly kind: "unreachable";
  readonly message: string;
  readonly giveUp: string | null;
};

export type ResolveOutcome =
  /** The target had committed: the window now runs there, its resume
   *  queued for this device to type. */
  | { readonly kind: "finished"; readonly session: Session; readonly message: string }
  /** Put back on the source and restarted where the retire had stopped it:
   *  `restarted` when it was, its resume queued for this device to type. */
  | {
      readonly kind: "restored";
      readonly session: Session | null;
      readonly message: string;
      readonly restarted: boolean;
    }
  /**
   * A host this needs did not answer, or the source could not confirm that
   * nothing is moving: nothing changed. `giveUp` is what giving the move up
   * would leave, when that is on offer (never once the target committed).
   */
  | Unreachable
  /** The source could not put every file back: they need a person. */
  | { readonly kind: "stranded"; readonly message: string; readonly detail: string | null }
  /** Another device settled it meanwhile, or the window was closed. */
  | { readonly kind: "settled"; readonly message: string }
  /** Given up on the server alone: what is set aside stays where it is. */
  | { readonly kind: "given_up"; readonly session: Session | null; readonly message: string }
  /** The server refused for a reason this device cannot act on. */
  | { readonly kind: "failed"; readonly message: string };

/** A settled Resolve said as a toast (`resolveToast`). */
export interface ResolveToast {
  readonly message: string;
  readonly detail: string | null;
  /** Stays until dismissed: it carries something to act on. */
  readonly persistent: boolean;
  /** The window to offer to open, where this device's resume for it waits. */
  readonly openWindow: Session | null;
}

/**
 * What a settled Resolve says as a toast: null for an outcome the sheet
 * keeps, one that still asks for something. `offerWindow` is for a screen
 * that does not show the window (a host's page): where this device has the
 * window's resume queued — a move it finished, or one it put back and
 * restarted — the toast says the agent resumes when the window is opened and
 * offers to open it, as the browser's host page does (web `resolveToast`).
 */
export function resolveToast(
  outcome: ResolveOutcome,
  hostName: (hostId: string) => string,
  offerWindow: boolean,
): ResolveToast | null {
  if (
    outcome.kind !== "finished" &&
    outcome.kind !== "restored" &&
    outcome.kind !== "settled" &&
    outcome.kind !== "given_up"
  ) {
    return null;
  }
  const window = !offerWindow
    ? null
    : outcome.kind === "finished" && outcome.session.status !== "killed"
      ? outcome.session
      : outcome.kind === "restored" && outcome.restarted
        ? outcome.session
        : null;
  return {
    message: outcome.message,
    detail: window ? copy.moveResumeWhenOpened(hostName(window.host_id)) : null,
    persistent: window !== null,
    openWindow: window,
  };
}

export interface ResolveDeps
  extends Pick<MoveDeps, "channels" | "server" | "launches" | "restart" | "sleep"> {}

export interface ResolveRequest {
  readonly session: Session;
  readonly agent: AgentDef | null;
  readonly hosts: ReadonlyMap<string, MoveHost>;
  /** The folder the mover picked, when this device is the mover. */
  readonly targetCwd?: string | null;
}

const TIMEOUT = { timeoutMs: 15_000 };
/** How long a resolver waits before it reads an empty listing again. */
export const RESOLVE_RECHECK_MS = 3_000;

function codeOf(error: unknown): string | null {
  if (error instanceof HostControlTransportError) return error.code;
  if (error instanceof ApiError)
    return typeof error.detail === "string" ? error.detail : error.code;
  return null;
}

function hostOr(hosts: ReadonlyMap<string, MoveHost>, id: string | null): MoveHost | null {
  return id ? (hosts.get(id) ?? null) : null;
}

function sleepOf(deps: Pick<ResolveDeps, "sleep">): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** The source could not be reached: nothing is decided, and where the move
 *  was going is not known from here. */
function sourceSilent(fromName: string): Unreachable {
  return {
    kind: "unreachable",
    message: copy.moveResolveSourceOffline(fromName),
    giveUp: copy.moveGiveUpBody(fromName, null),
  };
}

/** The target could not say whether it took the conversation in. `toName`
 *  is null for a host this device cannot name. */
function targetSilent(fromName: string, toName: string | null): Unreachable {
  return {
    kind: "unreachable",
    message: copy.moveResolveTargetOffline(toName),
    giveUp: copy.moveGiveUpBody(fromName, toName),
  };
}

/** The folder a resolver starts the window in on the target when it was not
 *  the mover: the source folder, home-relative, which is where a move most
 *  often lands. */
export function guessTargetCwd(sessionCwd: string, sourceHome: string | null): string {
  if (sourceHome && (sessionCwd === sourceHome || sessionCwd.startsWith(`${sourceHome}/`))) {
    return `~${sessionCwd.slice(sourceHome.length)}`;
  }
  return sessionCwd;
}

/**
 * Whether the source confirms nothing of this window is moving, with no
 * transfer record to go by: its window runs — a retire stops it before it
 * does anything else — or it is stopped and its conversation is still where
 * Claude Code looks, so nothing was retired. Null when the source could not
 * say.
 */
async function nothingMoving(channel: MoveChannel, session: Session): Promise<boolean | null> {
  try {
    await channel.inspectConversation(session.id, TIMEOUT);
    return true;
  } catch (error) {
    if (codeOf(error) !== "session_not_found") return null;
  }
  const conversationId = canonicalConversationId(session.agent_session_id);
  if (!conversationId) return false;
  try {
    const probe = await channel.conversationProbe({ conversationId, cwd: session.cwd }, TIMEOUT);
    return probe.duplicates.length > 0;
  } catch {
    return null;
  }
}

/**
 * Resolve the move of `session`, which reads "moving" on the host it would
 * leave. The person has been told what this does and asked first.
 */
export async function resolveMove(
  request: ResolveRequest,
  deps: ResolveDeps,
): Promise<ResolveOutcome> {
  const { session, hosts } = request;
  const from = hostOr(hosts, session.host_id);
  const fromName = from?.name ?? session.host_name ?? copy.MOVE_ANOTHER_HOST;
  let source: MoveChannelLease | null = null;
  try {
    source = from ? await deps.channels.open(from).catch(() => null) : null;
    if (!source) return sourceSilent(fromName);
    const channel = source.channel;
    // A source that cannot carry never retired anything: the move only
    // needs its server mark taken off.
    if (!channel.hasCapability(CONVERSATION_CARRIER_CAPABILITY)) {
      return await undoServer(request, deps, fromName, false, { channel, conversationId: null });
    }
    const listed = async () =>
      (await channel.conversationTransfers(TIMEOUT)).outgoing.filter(
        (transfer) => transfer.sessionId === session.id,
      );
    let mine: OutgoingConversationTransfer[];
    try {
      mine = await listed();
      if (mine.length === 0) {
        // Never decided on one empty read: a retire under way on another
        // device writes its record only once the window has stopped.
        await sleepOf(deps)(RESOLVE_RECHECK_MS);
        mine = await listed();
      }
    } catch {
      return sourceSilent(fromName);
    }
    if (mine.length === 0) {
      const quiet = await nothingMoving(channel, session);
      if (quiet === null) return sourceSilent(fromName);
      if (!quiet) {
        return {
          kind: "unreachable",
          message: copy.moveResolveUnconfirmed(fromName),
          giveUp: copy.moveGiveUpBody(fromName, null),
        };
      }
      return await undoServer(request, deps, fromName, false, { channel, conversationId: null });
    }

    // Newest first: an earlier one for the same window was given up before
    // this one could begin (the source moves one conversation at a time).
    for (const transfer of mine) {
      const outcome = await settleTransfer(request, deps, source, transfer, fromName);
      if (outcome) return outcome;
    }
    return await undoServer(request, deps, fromName, true, {
      channel,
      conversationId: mine[0]?.conversationId ?? null,
    });
  } finally {
    source?.release();
  }
}

/**
 * "Give up the move": the server's move ends and nothing is asked of either
 * host — for a host that is not coming back soon. The window stops where it
 * was; whatever the source set aside, or the target took in, stays there,
 * listed on its page, until a Resolve reaches it (`moveGiveUpBody` says so
 * before, `moveGivenUp` after, as the browser does).
 */
export async function giveUpMove(
  session: Session,
  fromName: string,
  deps: Pick<ResolveDeps, "server">,
): Promise<ResolveOutcome> {
  try {
    const stopped = await deps.server.abort(session.id, session.host_id);
    return { kind: "given_up", session: stopped, message: copy.moveGivenUp(fromName) };
  } catch (error) {
    if (codeOf(error) === "move_conflict") {
      return { kind: "settled", message: copy.MOVE_CONFLICT_SETTLED };
    }
    if (error instanceof ApiError && error.status === 404) {
      return { kind: "settled", message: copy.MOVE_WINDOW_GONE };
    }
    return { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
  }
}

/**
 * The target's answer on one transfer: committed, cancelled now, or no
 * answer. Only "cancelled" lets the source put its files back.
 */
async function askTarget(
  target: MoveChannel,
  transferId: string,
): Promise<"committed" | "cancelled" | null> {
  try {
    const status = await target.conversationImportStatus(transferId, TIMEOUT);
    if (status.state === "committed") return "committed";
    const cancelled = await target.conversationImportCancel(transferId, TIMEOUT);
    return cancelled.state === "committed"
      ? "committed"
      : cancelled.state === "cancelled"
        ? "cancelled"
        : null;
  } catch (error) {
    return codeOf(error) === "transfer_committed" ? "committed" : null;
  }
}

/**
 * One outgoing transfer of the window: finished when its target committed,
 * otherwise cancelled there and put back here. Null when it is settled and
 * the caller goes on.
 */
async function settleTransfer(
  request: ResolveRequest,
  deps: ResolveDeps,
  source: MoveChannelLease,
  transfer: OutgoingConversationTransfer,
  fromName: string,
): Promise<ResolveOutcome | null> {
  const to = hostOr(request.hosts, transfer.toHostId);
  const toName = to?.name ?? null;
  // A stranded transfer never reached a target that could commit it: only
  // the source's abort ends it.
  if (transfer.state !== "stranded") {
    const target = to ? await deps.channels.open(to).catch(() => null) : null;
    if (!target || !to) return targetSilent(fromName, toName);
    try {
      const answer = await askTarget(target.channel, transfer.transferId);
      if (answer === null) return targetSilent(fromName, toName);
      if (answer === "committed") {
        return await finish(request, deps, source, target, transfer, to, fromName);
      }
    } finally {
      target.release();
    }
  }
  try {
    await source.channel.conversationRetireAbort(transfer.transferId, TIMEOUT);
  } catch (error) {
    const reason = codeOf(error);
    if (reason === "already_exists") {
      await undoServer(request, deps, fromName, true, {
        channel: source.channel,
        conversationId: transfer.conversationId,
      }).catch(() => null);
      return {
        kind: "stranded",
        message: copy.moveConflicts(fromName),
        detail:
          error instanceof HostControlTransportError && error.detail && error.detail !== error.code
            ? error.detail
            : null,
      };
    }
    if (reason !== "transfer_not_found" && reason !== "transfer_aborted") {
      return sourceSilent(fromName);
    }
  }
  return null;
}

async function finish(
  request: ResolveRequest,
  deps: ResolveDeps,
  source: MoveChannelLease,
  target: MoveChannelLease,
  transfer: OutgoingConversationTransfer,
  to: MoveHost,
  fromName: string,
): Promise<ResolveOutcome> {
  const { session, agent, hosts } = request;
  if (transfer.length != null && transfer.sha256) {
    await source.channel
      .conversationRetireCommit(
        { transferId: transfer.transferId, length: transfer.length, sha256: transfer.sha256 },
        TIMEOUT,
      )
      .catch(() => undefined);
  }
  const probeSource = await source.channel
    .conversationProbe({ cwd: session.cwd }, TIMEOUT)
    .catch(() => null);
  const cwd = request.targetCwd ?? guessTargetCwd(session.cwd, probeSource?.home ?? null);
  const probe = await target.channel
    .conversationProbe({ conversationId: transfer.conversationId, cwd }, TIMEOUT)
    .catch(() => null);
  let queued = false;
  if (agent) {
    const settings = probe?.store
      ? await target.channel
          .readHead(joinHostPath(probe.store, "settings.json"), 64 * 1024, TIMEOUT)
          .then((head) => new TextDecoder().decode(head.bytes))
          .catch(() => null)
      : null;
    const from = hosts.get(session.host_id);
    // Whether it was mid-turn is not known here: the note waits as a prefix.
    const plan = planRelaunch({
      agent,
      conversation: { resume: transfer.conversationId },
      permissionMode: defaultPermissionMode(agent, settings),
      shell: probe?.loginShell ?? null,
      note: {
        from: { name: fromName, os: from?.os ?? null },
        to: { name: to.name, os: to.os },
        cwd: probe?.cwd ?? null,
        memoryPath: probe?.memory ?? null,
        state: "idle",
      },
    });
    if (plan) {
      const arrival: MoveArrival = {
        version: 1,
        agent: copy.CLAUDE_CODE,
        to: to.name,
        from: fromName,
        cwd: displayPath(cwd),
        note: plan.note,
        line: plan.line,
      };
      // Provisional until the commit answers: nothing is typed for a
      // commit another device beat this one to.
      await deps.launches.queue(session.id, to.id, plan.line, arrival);
      queued = true;
    }
  }
  const drop = () =>
    queued ? deps.launches.discard(session.id, to.id).catch(() => undefined) : undefined;
  let moved: Session;
  try {
    moved = await deps.server.commit(session.id, {
      host_id: to.id,
      cwd,
      expected_host_id: session.host_id,
      ...(agent ? { agent_id: agent.id } : {}),
      agent_session_id: transfer.conversationId,
      carried: true,
    });
  } catch (error) {
    await drop();
    const reason = codeOf(error);
    if (error instanceof ApiError && error.status === 404) {
      return { kind: "settled", message: copy.MOVE_WINDOW_GONE };
    }
    if (reason === "move_conflict" || reason === "move_in_progress") {
      // Committed by the device that was still moving it, most likely: the
      // window is said where it is, and nothing is typed here.
      const row = await deps.server.get(session.id).catch(() => null);
      return {
        kind: "settled",
        message:
          row?.host_id === to.id ? copy.moveResolvedFinished(to.name) : copy.MOVE_CONFLICT_SETTLED,
      };
    }
    // The target took the conversation in: from here the move only goes
    // forward, so nothing is offered that would end it.
    if (reason === "target_offline") {
      return { kind: "unreachable", message: copy.moveCommitOffline(to.name), giveUp: null };
    }
    return { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
  }
  if (moved.status === "killed") {
    await drop();
    return { kind: "finished", session: moved, message: copy.moveDoneArchived(to.name) };
  }
  if (queued) await deps.launches.confirm(session.id, to.id).catch(() => undefined);
  return { kind: "finished", session: moved, message: copy.moveResolvedFinished(to.name) };
}

/** Take the server's mark off and, where the source's retire had stopped
 *  the window, restart it there with its conversation resumed: whoever puts
 *  a move back leaves the window running its agent, the line queued for this
 *  device to type, in the mode its record carries there (`putBackResume`). */
async function undoServer(
  request: ResolveRequest,
  deps: ResolveDeps,
  fromName: string,
  retired: boolean,
  put: { channel: MoveChannel | null; conversationId: string | null },
): Promise<ResolveOutcome> {
  const { session } = request;
  let restored: Session;
  try {
    restored = await deps.server.abort(session.id, session.host_id);
  } catch (error) {
    if (codeOf(error) === "move_conflict") {
      return { kind: "settled", message: copy.MOVE_CONFLICT_SETTLED };
    }
    if (error instanceof ApiError && error.status === 404) {
      return { kind: "settled", message: copy.MOVE_WINDOW_GONE };
    }
    return { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
  }
  const restarted = restored.status === "killed" || retired;
  if (restarted) {
    const line = await putBackResume(
      put.channel,
      request.agent,
      put.conversationId ?? session.agent_session_id,
      session.cwd,
    );
    await deps.restart(restored, line).catch(() => undefined);
  }
  return { kind: "restored", session: restored, message: copy.moveBackOn(fromName), restarted };
}

/**
 * The host page's view of one outgoing transfer whose window no longer
 * reads "moving" from here — a move that committed while its source was
 * away, or one given up without this host: commit the retire when the
 * target has the conversation, otherwise, once the target has answered
 * "cancelled", put the files back.
 */
export async function settleLeftover(
  transfer: OutgoingConversationTransfer,
  source: MoveChannelLease,
  hosts: ReadonlyMap<string, MoveHost>,
  deps: Pick<ResolveDeps, "channels">,
  fromName: string,
): Promise<ResolveOutcome> {
  const to = hostOr(hosts, transfer.toHostId);
  const toName = to?.name ?? null;
  if (transfer.state !== "stranded") {
    const target = to ? await deps.channels.open(to).catch(() => null) : null;
    if (!target) return { ...targetSilent(fromName, toName), giveUp: null };
    try {
      const answer = await askTarget(target.channel, transfer.transferId);
      if (answer === null) return { ...targetSilent(fromName, toName), giveUp: null };
      if (answer === "committed") {
        if (transfer.length != null && transfer.sha256) {
          await source.channel
            .conversationRetireCommit(
              { transferId: transfer.transferId, length: transfer.length, sha256: transfer.sha256 },
              TIMEOUT,
            )
            .catch(() => undefined);
        }
        return {
          kind: "settled",
          message: copy.moveResolvedFinished(toName ?? copy.MOVE_HOST_IT_WAS_GOING_TO),
        };
      }
    } finally {
      target.release();
    }
  }
  try {
    await source.channel.conversationRetireAbort(transfer.transferId, TIMEOUT);
  } catch (error) {
    const reason = codeOf(error);
    if (reason === "already_exists") {
      return {
        kind: "stranded",
        message: copy.moveConflicts(fromName),
        detail:
          error instanceof HostControlTransportError && error.detail && error.detail !== error.code
            ? error.detail
            : null,
      };
    }
    if (reason !== "transfer_aborted" && reason !== "transfer_not_found") {
      return { ...sourceSilent(fromName), giveUp: null };
    }
  }
  return { kind: "restored", session: null, message: copy.moveBackOn(fromName), restarted: false };
}

/**
 * The host page's view of one transfer it is staging for another host: the
 * source decides. A transfer the source still lists is settled from there; one
 * it no longer lists — in a listing it did not cut short — is let go here, its
 * staging cancelled. A source that cannot answer, or a cut-short listing,
 * decides nothing.
 */
export async function settleIncoming(
  transfer: IncomingConversationTransfer,
  target: MoveChannel,
  hosts: ReadonlyMap<string, MoveHost>,
  deps: Pick<ResolveDeps, "channels">,
): Promise<ResolveOutcome> {
  const source = hostOr(hosts, transfer.fromHostId);
  const sourceName = source?.name ?? copy.MOVE_ANOTHER_HOST;
  const lease = source ? await deps.channels.open(source).catch(() => null) : null;
  if (!lease) return { ...sourceSilent(sourceName), giveUp: null };
  try {
    const listing = await lease.channel.conversationTransfers(TIMEOUT).catch(() => null);
    if (!listing) return { ...sourceSilent(sourceName), giveUp: null };
    const outgoing = listing.outgoing.find((item) => item.transferId === transfer.transferId);
    if (outgoing) return await settleLeftover(outgoing, lease, hosts, deps, sourceName);
    // Not named in a listing cut short is not "not listed".
    if (listing.truncated) return { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
    try {
      await target.conversationImportCancel(transfer.transferId, TIMEOUT);
    } catch (error) {
      if (codeOf(error) !== "transfer_committed") {
        return { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
      }
    }
    return {
      kind: "restored",
      session: null,
      message: copy.moveBackOn(sourceName),
      restarted: false,
    };
  } finally {
    lease.release();
  }
}
