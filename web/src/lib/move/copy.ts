/**
 * Everything a move says, in one place. The phone says the same, string for
 * string (`mobile/src/components/workspace-detail/move-copy.ts`): a change
 * here is a change there in the same commit, and `copy.test.ts` pins the
 * same names to the same sentences as the phone's `move-copy.test.ts`. Only
 * what the browser alone does has words of its own here (leaving the tab, a
 * blocked clipboard, the picker's accessible name). Every sentence about a
 * host names it, the product is only ever "SPAWN D", the agent is "Claude
 * Code" (never its definition's slug), no daemon or server code ever reaches
 * a person, and every failure before the target took the conversation says
 * plainly that nothing was lost.
 *
 * Pure and DOM-free.
 */

import { formatSize } from "@/lib/files/format";
import type { MoveFailure } from "./orchestrator";
import type { ResolveOutcome } from "./resolver";
import type { ClaudeScreenState } from "./screen";

/** A host whose name is not known: the source, and the target. */
export const ANOTHER_HOST = "another host";

// ---- the way in ------------------------------------------------------------------

/** The pane menu's item, and the title of the where menu it opens. */
export const MOVE_TO_ANOTHER_HOST_ITEM = "Move to another host…";
export const MOVE_TO_ANOTHER_HOST_TITLE = "Move to another host";
/** Under the where panel's title, for a Claude Code window. */
export const MOVE_PICKER_CARRY_CAPTION = "Claude Code's conversation comes with it where it can.";

// ---- the dialog ------------------------------------------------------------------

export function checkingLine(source: string, target: string): string {
  return `Checking ${source} and ${target}…`;
}

export function moveTitle(target: string): string {
  return `Move Claude Code to ${target}?`;
}

export function moveBody(
  source: string,
  target: string,
  cwd: string,
  bytes: number | null,
): string {
  const size = bytes !== null ? ` (${formatSize(bytes)})` : "";
  return `Claude Code stops on ${source} and continues this conversation on ${target}, in ${cwd}. The conversation comes with it${size}; the files it was working on don't, so ${cwd} on ${target} needs your latest work.`;
}

/** What happens to the agent's turn, by its state when the person confirms. */
export function stateLine(state: string, target: string): string {
  if (state === "running")
    return `Claude Code is working right now. On ${target} it will be told about the move and carry on.`;
  if (state === "blocked")
    return `Claude Code is waiting for an answer. On ${target} it will be told about the move and ask again.`;
  return `On ${target}, your next message will start with a note about the move.`;
}

/** The folder line from `.git/HEAD` on both hosts: branch and commit. */
export function sameCommitLine(branch: string | null, short: string): string {
  return branch ? `Both are on ${branch} at ${short}.` : `Both are at ${short}.`;
}

export function headLabel(branch: string | null, short: string | null): string {
  if (branch && short) return `${branch} at ${short}`;
  return branch ?? short ?? "no commit";
}

export function differentCommitWarning(
  source: string,
  sourceHead: string,
  target: string,
  targetHead: string,
): string {
  return `${source} is on ${sourceHead}; ${target} is on ${targetHead}.`;
}

export function notARepositoryWarning(target: string, cwd: string): string {
  return `${cwd} on ${target} isn't a git repository, so SPAWN D can't compare it with the one here.`;
}

export function folderMissingBlock(target: string, cwd: string): string {
  return `${cwd} doesn't exist on ${target}. Create it there, or start fresh — a new conversation creates the folder.`;
}

export function durationWarning(duration: string): string {
  return `This will take about ${duration}. Keep SPAWN D open until it finishes.`;
}

export function olderClaudeWarning(
  target: string,
  targetVersion: string,
  source: string,
  sourceVersion: string,
): string {
  return `Claude Code on ${target} (${targetVersion}) is older than on ${source} (${sourceVersion}).`;
}

export function duplicateNote(target: string): string {
  return `An older copy of this conversation on ${target} will be set aside.`;
}

export function claudeNotFoundWarning(target: string): string {
  return `SPAWN D couldn't find Claude Code on ${target}.`;
}

/** The window is in another conversation than the one it was opened with. */
export const SWITCHED_CONVERSATION_NOTE =
  "This window had switched conversations; SPAWN D will move the one it's in now.";

/** The host could not name the window's conversation: the recorded one goes. */
export const UNCONFIRMED_CONVERSATION_WARNING =
  "SPAWN D couldn't confirm which conversation this window is in now. It will bring back the one it started with.";

export function liveElsewhereBlock(source: string): string {
  return `This conversation is also open in another window or in the background on ${source}. Close it there first.`;
}

export function liveHereBlock(target: string): string {
  return `This conversation is open in Claude Code on ${target}. Close it there first.`;
}

export function storeNotReadyBlock(target: string): string {
  return `Claude Code hasn't been set up on ${target} yet. Run claude there once and sign in, then move.`;
}

export const TOO_LARGE_BLOCK =
  "This conversation has a file over 512 MB, more than a move can carry.";

export const NO_CONVERSATION_BLOCK =
  "SPAWN D couldn't tell which conversation this window is in, so it can't come along.";

export function notConnectedBlock(host: string): string {
  return `${host} isn't connected to this device right now, so the conversation can't come along.`;
}

export function checkFailedBlock(host: string): string {
  return `SPAWN D couldn't check ${host}. Try again in a moment.`;
}

export function sourceOfflineBody(source: string, target: string): string {
  return `${source} is offline, so this conversation can't come along. Start a new one on ${target} instead?`;
}

export function startFreshOnLabel(target: string): string {
  return `Start fresh on ${target}`;
}

export const START_FRESH_LABEL = "Start fresh instead";
export const MOVE_WITH_CONVERSATION_LABEL = "Move with conversation";
export const CANCEL_LABEL = "Cancel";

/** The permission picker: "Starts in <mode> ▾" — the words before the picker. */
export const STARTS_IN_LABEL = "Starts in";

export function startsInLabel(mode: string): string {
  return `${STARTS_IN_LABEL} ${mode}`;
}

export const PERMISSION_PICKER_LABEL = "Permission mode on arrival";

/** Fresh moves: what an agent without a carried conversation says. */
export function freshAgentLine(agent: string, target: string): string {
  return `${agent} can't bring its conversation to another host yet, so it starts a new one on ${target}.`;
}

export function needsNewerSpawnLine(hosts: string, target: string): string {
  return `SPAWN D on ${hosts} can't carry conversations yet, so Claude Code starts a new one on ${target}.`;
}

// ---- progress over the pane --------------------------------------------------------

export function movingLine(target: string): string {
  return `Moving to ${target}…`;
}

export function stoppingLine(source: string): string {
  return `Stopping Claude Code on ${source}…`;
}

/**
 * "3.1 of 12.4 MB": what the target holds of the conversation, both in the
 * total's unit (1024-based, as every size SPAWN D shows), kilobytes whole and
 * larger units to a tenth.
 */
export function formatProgress(done: number, total: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  if (total < 1024) return `${Math.round(Math.min(done, total))} of ${Math.round(total)} B`;
  let size = 1024;
  let unit = 0;
  while (total >= size * 1024 && unit < units.length - 1) {
    size *= 1024;
    unit += 1;
  }
  const amount = (bytes: number) =>
    unit === 0 ? String(Math.round(bytes / size)) : (bytes / size).toFixed(1);
  return `${amount(Math.min(done, total))} of ${amount(total)} ${units[unit]}`;
}

export function copyingLine(bytes: number, total: number): string {
  return total > 0
    ? `Copying the conversation · ${formatProgress(bytes, total)}`
    : "Copying the conversation";
}

export function startingLine(target: string): string {
  return `Starting on ${target}…`;
}

export const RESUMING_LINE = "Resuming the conversation…";

export function puttingBackLine(source: string): string {
  return `Putting the conversation back on ${source}…`;
}

/** Under every step while one runs. */
export const KEEP_OPEN_LINE = "Keep SPAWN D open until the move finishes.";

/** Asked before a tab running a move is closed (browsers show their own words). */
export const BEFORE_UNLOAD_MOVE = "A move is still running. Leaving now interrupts it.";

// ---- toasts --------------------------------------------------------------------------

export function movedToast(target: string, state: string): string {
  return state === "running" || state === "blocked"
    ? `Moved to ${target} — Claude Code is carrying on.`
    : `Moved to ${target} — your next message starts with a note about the move.`;
}

export function movedArchivedToast(target: string): string {
  return `Moved to ${target}. Its workspace is archived, so it starts when you restore it.`;
}

export function movedGoneToast(target: string): string {
  return `The conversation moved to ${target}, but this window was closed meanwhile.`;
}

export function backOnSourceToast(source: string): string {
  return `Back on ${source} — nothing was lost.`;
}

export const NOTE_COPIED_TOAST = "Copied the move note.";
export const CLIPBOARD_BLOCKED_TOAST = "Your browser blocked the clipboard.";

// ---- banners in the pane, after the move ------------------------------------------

/** What the screen classifier saw, said in the pane. Never answered for the person. */
export function screenBanner(state: ClaudeScreenState, target: string, cwd: string): string | null {
  switch (state) {
    case "trust_prompt":
      return `Claude Code on ${target} is asking whether to trust ${cwd}. Answer in the terminal to continue.`;
    case "bypass_prompt":
      return `Claude Code on ${target} is asking you to confirm Bypass Permissions mode. Answer in the terminal to continue.`;
    case "dialog":
      return `Claude Code on ${target} is asking a question. Answer in the terminal to continue.`;
    case "resume_summary_prompt":
      return "Claude Code is asking how to pick this long conversation back up. Choose in the terminal.";
    case "login_required":
      return `Claude Code on ${target} isn't signed in. Sign in in the terminal.`;
    case "conversation_not_found":
      return `Claude Code on ${target} couldn't find the conversation.`;
    case "agent_missing":
      return `Claude Code isn't installed on ${target}.`;
    default:
      return null;
  }
}

export const NOTE_FAILED_BANNER = "SPAWN D couldn't add the move note to Claude Code's prompt.";
export const COPY_NOTE_LABEL = "Copy note";
export const TRY_AGAIN_LABEL = "Try again";
export const USE_TERMINAL_NOW_LABEL = "Use the terminal now";
export const DISMISS_LABEL = "Dismiss";

// ---- failures ------------------------------------------------------------------------

const NOTHING_LOST = (source: string) => `Nothing was lost — it's still on ${source}.`;

export interface FailureCopy {
  message: string;
  /** A second, dimmer line: the host's own words, where it gave some. */
  detail?: string;
}

/**
 * What a move that stopped says. `cwd` is the folder on the target; `detail`
 * the source's own words about what holds the conversation, shown only where
 * they help (a stale record to remove) and never otherwise: a code or an
 * error's text is not something to show a person.
 */
export function failureCopy(
  failure: MoveFailure,
  names: { source: string; target: string; cwd: string },
  detail: string | null = null,
): FailureCopy {
  const { source, target, cwd } = names;
  switch (failure) {
    case "source_offline":
      return { message: sourceOfflineBody(source, target) };
    case "move_in_progress":
      return { message: "This window is moving to another host. Finish or cancel the move first." };
    case "move_conflict":
      return { message: "This window moved to another host meanwhile." };
    case "workspace_archived":
      return { message: "This window's workspace is archived. Restore it first." };
    case "gone":
      return { message: "This window no longer exists." };
    case "begin_failed":
      return { message: "SPAWN D couldn't start the move. Nothing changed." };
    case "conversation_live_elsewhere":
      return {
        message: `This conversation is also open in another window or in the background on ${source}, so nothing was moved. Close it there first.`,
        ...(detail ? { detail } : {}),
      };
    case "conversation_changed":
      return {
        message: `This window switched to another conversation on ${source}, so nothing was moved. Try again.`,
      };
    case "agent_still_running":
      return {
        message: `${source} didn't confirm that Claude Code stopped, so nothing was moved.`,
      };
    case "window_restarted":
      return {
        message: `This window was restarted on ${source} while it was moving, so the move was cancelled.`,
      };
    case "window_unavailable":
      return {
        message: `${source} hasn't picked this window up yet, so nothing was moved. Try again in a moment.`,
      };
    case "transfer_unresolved":
      return {
        message: `Another move of this conversation hasn't finished. Resolve it on ${source}'s page first.`,
      };
    case "too_large":
      // The source's own refusal: a file over its 512 MB cap, or more than
      // a move carries in all. Refused before anything stopped.
      return {
        message: "This conversation is more than a move can carry, so nothing was moved.",
      };
    case "too_many_tasks":
      return { message: `${source} is busy. Try again in a moment. Nothing was moved.` };
    case "export_failed":
      return { message: `${source} couldn't hand the conversation over, so nothing was moved.` };
    case "conversation_live_here":
      return {
        message: `Claude Code on ${target} has this conversation open. Close it there, then try again. ${NOTHING_LOST(source)}`,
      };
    case "folder_missing":
      return {
        message: `${cwd} doesn't exist on ${target}. Create it there, then try again. ${NOTHING_LOST(source)}`,
      };
    case "store_missing":
      return {
        message: `Claude Code hasn't been set up on ${target} yet. Run claude there once and sign in, then try again. ${NOTHING_LOST(source)}`,
      };
    case "insufficient_space":
      return {
        message: `${target} doesn't have room for this conversation. ${NOTHING_LOST(source)}`,
      };
    case "too_many_transfers":
      return {
        message: `${target} is holding too many unfinished moves. Resolve them on its page, then try again. ${NOTHING_LOST(source)}`,
      };
    case "integrity_mismatch":
      return {
        message: `The copy on ${target} didn't match the original, so it was discarded. Try again. ${NOTHING_LOST(source)}`,
      };
    case "file_changed":
      return {
        message: `The conversation changed on ${source} while it was copied. Try again. ${NOTHING_LOST(source)}`,
      };
    case "connection_lost":
      return {
        message: `The conversation couldn't be copied to ${target} (connection lost). ${NOTHING_LOST(source)}`,
      };
    case "copy_failed":
      return {
        message: `The conversation couldn't be copied to ${target}. ${NOTHING_LOST(source)}`,
      };
    case "cancelled":
      return { message: `Move cancelled. ${NOTHING_LOST(source)}` };
    case "commit_target_offline":
      return {
        message: `${target} went offline before the move finished. Try again when it's back — nothing was lost.`,
      };
    case "commit_failed":
      return { message: "SPAWN D couldn't finish the move. Try again — nothing was lost." };
    case "resolved_elsewhere":
      return { message: "The move already finished or was cancelled from another device." };
    case "conversation_on_target":
      return { message: onTargetLine(target) };
    case "unresolved_target":
      return {
        message: `${target} can't be reached, so the move can't be put back yet. The window stays “Moving” until you resolve it.`,
      };
    case "unresolved_source":
      return {
        message: `${source} can't be reached, so the conversation can't be put back yet. The window stays “Moving” until you resolve it.`,
      };
    case "abort_failed":
      return {
        message: `SPAWN D couldn't put this window back on ${source} yet. Try again — nothing was lost.`,
      };
  }
}

export function conflictsLine(source: string): string {
  return `Some of this conversation's files couldn't be put back on ${source} because files with those names are there. Sort them out by hand in Claude Code's projects folder on ${source}.`;
}

/** The conversation is on the target, the window is not. */
export function onTargetLine(target: string): string {
  return `The conversation is on ${target} now, but this window isn't. Take the window to ${target} to carry on there.`;
}

export function takeThereLabel(target: string): string {
  return `Take the window to ${target}`;
}

export function resumeOnLabel(source: string): string {
  return `Resume on ${source}`;
}

// ---- other devices, and Resolve -----------------------------------------------------

/** A pane on any device while its window moves. The target is named only
 *  where this browser knows it; the server cannot until the commit. */
export function movingElsewhereLine(target: string | null): string {
  return movingLine(target ?? ANOTHER_HOST);
}

export const RESOLVE_LABEL = "Resolve";
export const RESOLVE_TITLE = "Finish or put back this move?";

export function resolveBody(source: string): string {
  return `This window started moving from ${source} and didn't finish. SPAWN D will ask ${source} and the host it was going to where the conversation is, then finish the move or put it back.`;
}

export function resolvingLine(source: string): string {
  return `Checking ${source}…`;
}

export const GIVE_UP_LABEL = "Give up the move";

/**
 * Giving up when a host cannot answer: the server's move ends and neither
 * host is touched, so the conversation stays wherever it is now. `target`
 * is null where this device does not know it.
 */
export function giveUpBody(source: string, target: string | null): string {
  return `The window stops on ${source}. Its conversation stays where it is now — set aside on ${source}, or already on ${target ?? "the host it was going to"} — until you resolve the move from ${source}'s page.`;
}

/**
 * A move settled from a host's page: the window is not on screen here, so the
 * agent the settling device owes it resumes once the window is opened here
 * (opening takes its display, and the queued line is typed).
 */
export function resumeWhenOpenedLine(host: string): string {
  return `Claude Code resumes on ${host} when you open the window.`;
}

export const OPEN_WINDOW_LABEL = "Open window";

export function resolveOutcomeCopy(
  outcome: ResolveOutcome,
  names: { source: string; target: string | null },
): string {
  const target = names.target ?? "the host it was going to";
  switch (outcome.kind) {
    case "finished":
      return outcome.archived ? movedArchivedToast(target) : `Moved to ${target}.`;
    case "put_back":
      return backOnSourceToast(names.source);
    case "source_unreachable":
      return `${names.source} is offline, so this move can't be finished or put back until it's back.`;
    case "target_unreachable":
      return `${names.target ?? "The host it was going to"} can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.`;
    case "given_up":
      return `The move was given up and the window is back on ${names.source}. Resolve its conversation from ${names.source}'s page once both hosts can be reached.`;
    case "source_busy":
      return `${names.source} may still be moving this conversation. Try again in a moment.`;
    case "on_target":
      return onTargetLine(target);
    case "elsewhere":
      return "The move already finished or was cancelled from another device.";
    case "gone":
      return "This window no longer exists.";
    case "failed":
      return "SPAWN D couldn't resolve the move. Try again in a moment.";
  }
}

/** A settled Resolve said as a toast (`resolveToast`). */
export interface ResolveToast {
  message: string;
  detail: string | null;
  /** Stays until dismissed: it carries something to act on. */
  persistent: boolean;
  /** Offer to open the window, where this device's resume for it waits. */
  openWindow: boolean;
}

/**
 * What a host's page says once Resolve settles a move: the row it was
 * pressed on goes with the move, so the outcome is a toast rather than the
 * dialog's line. Null for an outcome the dialog keeps — one that still asks
 * for something (a host to come back, a try again, taking the window to its
 * conversation). `waiting` is whether this device has the window's resume
 * queued, to type when the window is opened here: then the toast says so and
 * offers to open it.
 */
export function resolveToast(
  outcome: ResolveOutcome,
  names: { source: string; target: string | null },
  waiting: boolean,
): ResolveToast | null {
  switch (outcome.kind) {
    case "finished":
    case "put_back":
    case "given_up":
    case "elsewhere":
    case "gone":
      break;
    default:
      return null;
  }
  const message = resolveOutcomeCopy(outcome, names);
  const conflicts =
    outcome.kind === "put_back" && outcome.conflicts ? conflictsLine(names.source) : null;
  const resumes =
    waiting &&
    ((outcome.kind === "finished" && !outcome.archived) ||
      (outcome.kind === "put_back" && outcome.restarted));
  const host =
    outcome.kind === "finished" ? (names.target ?? "the host it was going to") : names.source;
  return {
    message,
    detail: conflicts ?? (resumes ? resumeWhenOpenedLine(host) : null),
    persistent: conflicts !== null || resumes,
    openWindow: resumes,
  };
}

// ---- the host's page ------------------------------------------------------------------

export const UNFINISHED_MOVES_HEADING = "Unfinished moves";

export function outgoingMoveRow(conversation: string, target: string): string {
  return `Conversation ${conversation} moving to ${target}`;
}

export function incomingMoveRow(conversation: string, source: string): string {
  return `Conversation ${conversation} arriving from ${source}`;
}

export function strandedMoveRow(conversation: string): string {
  return `Conversation ${conversation} couldn't be put back whole`;
}

/** A conversation id as rows show it: its first eight characters. */
export function shortConversation(id: string | null): string {
  return id ? id.slice(0, 8) : "unknown";
}

// ---- the estimate --------------------------------------------------------------------

/** "30 seconds", "a minute", "4 minutes", "an hour", "2 hours". */
export function formatDuration(seconds: number): string {
  if (seconds < 55) return `${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 90) return "a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 55) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "an hour" : `${hours} hours`;
}
