/**
 * Every word a move with its conversation says, in one place: the dialog,
 * its checks and warnings, the progress sheet, the toasts, the banners over
 * the terminal it lands in, the failures, Resolve, and what another device
 * shows while it moves. The browser says the same things in the same words
 * (web/src/lib/move/copy.ts): `__tests__/move-copy.test.ts` here and the
 * browser's `copy.test.ts` pin the same names to the same sentences, so a
 * change to one is a change to both in the same commit. Only what one
 * platform alone does has words of its own here (the app going to the
 * background, the progress sheet put away, the mode sheet's message).
 *
 * The agent that carries its conversation is always Claude Code, by that
 * name — never its definition's slug. Host names and folders come in as the
 * caller has them; the product is SPAWN D; no daemon or server code is ever
 * shown to a person.
 */

import { formatFileSize } from "@/components/files/format";
import { MOVING_STATUS_LABEL } from "@/data/selectors/session";

/** The one agent whose conversation travels, as people read its name. */
export const CLAUDE_CODE = "Claude Code";
/** A host whose name is not known: the source, and the target. */
export const MOVE_ANOTHER_HOST = "another host";
/** The target, when a device resolving the move cannot name it. */
export const MOVE_HOST_IT_WAS_GOING_TO = "the host it was going to";

// ---- choosing where ---------------------------------------------------------

/** The place picker, for a window whose agent's conversation can travel. */
export const MOVE_PICKER_CARRY_MESSAGE = "Claude Code's conversation comes with it where it can.";

// ---- the dialog -------------------------------------------------------------

export const moveChecking = (from: string, to: string) => `Checking ${from} and ${to}…`;
export const moveTitle = (to: string) => `Move Claude Code to ${to}?`;

/** `bytes` is the conversation's size, said in the files' own units. */
export function moveBody({
  from,
  to,
  cwd,
  bytes,
}: {
  from: string;
  to: string;
  cwd: string;
  bytes: number | null;
}): string {
  const size = bytes !== null ? ` (${formatFileSize(bytes)})` : "";
  return `Claude Code stops on ${from} and continues this conversation on ${to}, in ${cwd}. The conversation comes with it${size}; the files it was working on don't, so ${cwd} on ${to} needs your latest work.`;
}

export function moveStateLine(state: "running" | "blocked" | "idle", to: string): string {
  if (state === "running") {
    return `Claude Code is working right now. On ${to} it will be told about the move and carry on.`;
  }
  if (state === "blocked") {
    return `Claude Code is waiting for an answer. On ${to} it will be told about the move and ask again.`;
  }
  return `On ${to}, your next message will start with a note about the move.`;
}

/** The folders agree: "Both are on main at 1a2b3c4." */
export const moveBothOn = (branch: string | null, short: string) =>
  branch ? `Both are on ${branch} at ${short}.` : `Both are at ${short}.`;
/** One folder's head as the warning names it: "main at 1a2b3c4". */
export function moveHeadLabel(branch: string | null, short: string | null): string {
  if (branch && short) return `${branch} at ${short}`;
  return branch ?? short ?? "no commit";
}
export const moveHeadsDiffer = (from: string, fromHead: string, to: string, toHead: string) =>
  `${from} is on ${fromHead}; ${to} is on ${toHead}.`;
export const moveNotARepository = (to: string, cwd: string) =>
  `${cwd} on ${to} isn't a git repository, so SPAWN D can't compare it with the one here.`;
export const moveEstimate = (duration: string) =>
  `This will take about ${duration}. Keep SPAWN D open until it finishes.`;
export const moveOlderAgent = (to: string, toVersion: string, from: string, fromVersion: string) =>
  `Claude Code on ${to} (${toVersion}) is older than on ${from} (${fromVersion}).`;
export const moveAgentNotFound = (to: string) => `SPAWN D couldn't find Claude Code on ${to}.`;
export const moveDuplicateSetAside = (to: string) =>
  `An older copy of this conversation on ${to} will be set aside.`;
export const MOVE_SWITCHED_CONVERSATION =
  "This window had switched conversations; SPAWN D will move the one it's in now.";
export const MOVE_UNCONFIRMED_CONVERSATION =
  "SPAWN D couldn't confirm which conversation this window is in now. It will bring back the one it started with.";

/** The permission-mode picker: every resumed conversation names its mode. */
export const MOVE_MODE_PICKER_TITLE = "Starts in";
export const moveStartsIn = (mode: string) => `${MOVE_MODE_PICKER_TITLE} ${mode}`;
export const moveModePickerMessage = (to: string) =>
  `The mode Claude Code starts in on ${to}. The conversation never brings back a mode of its own.`;

export const MOVE_CANCEL = "Cancel";
export const MOVE_START_FRESH = "Start fresh instead";
export const MOVE_WITH_CONVERSATION = "Move with conversation";
export const moveStartFreshOn = (to: string) => `Start fresh on ${to}`;
export const MOVE_TRY_AGAIN = "Try again";
export const moveResumeOn = (from: string) => `Resume on ${from}`;
export const MOVE_CLOSE = "Close";
export const MOVE_DISMISS = "Dismiss";

// ---- why a move cannot carry ------------------------------------------------

export const moveLiveElsewhere = (from: string) =>
  `This conversation is also open in another window or in the background on ${from}. Close it there first.`;
export const moveLiveHere = (to: string) =>
  `This conversation is open in Claude Code on ${to}. Close it there first.`;
export const moveStoreNotReady = (to: string) =>
  `Claude Code hasn't been set up on ${to} yet. Run claude there once and sign in, then move.`;
export const moveFolderMissing = (to: string, cwd: string) =>
  `${cwd} doesn't exist on ${to}. Create it there, or start fresh — a new conversation creates the folder.`;
export const MOVE_NO_CONVERSATION =
  "SPAWN D couldn't tell which conversation this window is in, so it can't come along.";
/** A file over the per-file cap a bundle carries (512 MiB): the one size
 *  the dialog refuses before anything stops. Anything else too large for a
 *  bundle is the source's own refusal (`MOVE_REFUSED_TOO_LARGE`). */
export const MOVE_TOO_LARGE =
  "This conversation has a file over 512 MB, more than a move can carry.";
export const moveSourceOffline = (from: string, to: string) =>
  `${from} is offline, so this conversation can't come along. Start a new one on ${to} instead?`;
export const moveNotConnected = (host: string) =>
  `${host} isn't connected to this device right now, so the conversation can't come along.`;
export const moveCheckFailed = (host: string) =>
  `SPAWN D couldn't check ${host}. Try again in a moment.`;
/** Hosts without the carrier (all of them, joined with "and"). */
export const moveCarrierMissing = (hosts: string, to: string) =>
  `SPAWN D on ${hosts} can't carry conversations yet, so Claude Code starts a new one on ${to}.`;
/** Codex, aider, opencode and the rest: the window moves, the conversation
 *  does not. `agent` is the agent's display name ("Codex"). */
export const moveAgentStartsFresh = (cwd: string, host: string, agent: string) =>
  `The window moves to ${cwd} on ${host}, and what runs in it here stops. ${agent} can't bring its conversation to another host yet, so it starts a new one on ${host}.`;

// ---- progress ---------------------------------------------------------------

export const moveProgressTitle = (to: string) => `Moving to ${to}…`;
export const moveStopping = (from: string) => `Stopping Claude Code on ${from}…`;
export const MOVE_COPYING = "Copying the conversation";
/** `done` and `total` already in the total's unit: "3.1" of "12.4 MB". */
export const moveCopying = (done: string, total: string) => `${MOVE_COPYING} · ${done} of ${total}`;
export const moveStarting = (to: string) => `Starting on ${to}…`;
export const movePuttingBack = (from: string) => `Putting the conversation back on ${from}…`;
export const MOVE_RESUMING = "Resuming the conversation…";
export const MOVE_KEEP_OPEN = "Keep SPAWN D open until the move finishes.";
/** On the notice a progress sheet leaves when it is put away mid-move. */
export const MOVE_SHOW = "Show";

// ---- done -------------------------------------------------------------------

export const moveDoneWorking = (to: string) => `Moved to ${to} — Claude Code is carrying on.`;
export const moveDoneIdle = (to: string) =>
  `Moved to ${to} — your next message starts with a note about the move.`;
export const moveDoneArchived = (to: string) =>
  `Moved to ${to}. Its workspace is archived, so it starts when you restore it.`;
export const moveWindowClosed = (to: string) =>
  `The conversation moved to ${to}, but this window was closed meanwhile.`;
/** The move finished, but not by this device's commit: nothing is typed here. */
export const moveLanded = (to: string) => `Moved to ${to}.`;
export const moveCancelled = (from: string) =>
  `Move cancelled. Nothing was lost — it's still on ${from}.`;
export const moveBackOn = (from: string) => `Back on ${from} — nothing was lost.`;

// ---- in the terminal it lands in -------------------------------------------

export const arrivalTrust = (to: string, cwd: string) =>
  `Claude Code on ${to} is asking whether to trust ${cwd}. Answer in the terminal to continue.`;
export const arrivalBypass = (to: string) =>
  `Claude Code on ${to} is asking you to confirm Bypass Permissions mode. Answer in the terminal to continue.`;
export const arrivalQuestion = (to: string) =>
  `Claude Code on ${to} is asking a question. Answer in the terminal to continue.`;
export const ARRIVAL_RESUME_SUMMARY =
  "Claude Code is asking how to pick this long conversation back up. Choose in the terminal.";
export const arrivalLogin = (to: string) =>
  `Claude Code on ${to} isn't signed in. Sign in in the terminal.`;
export const arrivalNotFound = (to: string) =>
  `Claude Code on ${to} couldn't find the conversation.`;
export const arrivalMissing = (to: string) => `Claude Code isn't installed on ${to}.`;
export const ARRIVAL_NOTE_FAILED = "SPAWN D couldn't add the move note to Claude Code's prompt.";
export const ARRIVAL_USE_TERMINAL = "Use the terminal now";
export const ARRIVAL_COPY_NOTE = "Copy note";
export const ARRIVAL_NOTE_COPIED = "Copied the move note.";

// ---- failures ---------------------------------------------------------------

const nothingLost = (from: string) => `Nothing was lost — it's still on ${from}.`;

/** The server refused the begin, before anything was asked of a host. */
export const MOVE_IN_PROGRESS =
  "This window is moving to another host. Finish or cancel the move first.";
export const MOVE_CONFLICT_RESTART = "This window moved to another host meanwhile.";
export const MOVE_WORKSPACE_ARCHIVED = "This window's workspace is archived. Restore it first.";
export const MOVE_WINDOW_GONE = "This window no longer exists.";
export const MOVE_BEGIN_FAILED = "SPAWN D couldn't start the move. Nothing changed.";

/** The source refused to hand the conversation over: nothing was moved. */
export const moveRefusedLiveElsewhere = (from: string) =>
  `This conversation is also open in another window or in the background on ${from}, so nothing was moved. Close it there first.`;
export const moveRefusedChanged = (from: string) =>
  `This window switched to another conversation on ${from}, so nothing was moved. Try again.`;
export const moveRefusedNoStop = (from: string) =>
  `${from} didn't confirm that Claude Code stopped, so nothing was moved.`;
export const moveRefusedRestarted = (from: string) =>
  `This window was restarted on ${from} while it was moving, so the move was cancelled.`;
export const moveRefusedUnavailable = (from: string) =>
  `${from} hasn't picked this window up yet, so nothing was moved. Try again in a moment.`;
export const moveRefusedUnresolved = (from: string) =>
  `Another move of this conversation hasn't finished. Resolve it on ${from}'s page first.`;
/** The source's own refusal: a file over its 512 MB cap, or more than a
 *  move carries in all. Refused before anything stopped. */
export const MOVE_REFUSED_TOO_LARGE =
  "This conversation is more than a move can carry, so nothing was moved.";
export const moveRefusedBusy = (from: string) =>
  `${from} is busy. Try again in a moment. Nothing was moved.`;
export const moveRefusedOther = (from: string) =>
  `${from} couldn't hand the conversation over, so nothing was moved.`;
export const moveStillRunning = (from: string) =>
  `Nothing was lost — Claude Code is still running on ${from}.`;

/** The target could not take it in; the source still holds it, held for Try again. */
export const moveHeldLiveHere = (to: string, from: string) =>
  `Claude Code on ${to} has this conversation open. Close it there, then try again. ${nothingLost(from)}`;
export const moveHeldFolderMissing = (to: string, cwd: string, from: string) =>
  `${cwd} doesn't exist on ${to}. Create it there, then try again. ${nothingLost(from)}`;
export const moveHeldStoreMissing = (to: string, from: string) =>
  `Claude Code hasn't been set up on ${to} yet. Run claude there once and sign in, then try again. ${nothingLost(from)}`;
export const moveHeldNoRoom = (to: string, from: string) =>
  `${to} doesn't have room for this conversation. ${nothingLost(from)}`;
export const moveHeldTooMany = (to: string, from: string) =>
  `${to} is holding too many unfinished moves. Resolve them on its page, then try again. ${nothingLost(from)}`;
export const moveHeldMismatch = (to: string, from: string) =>
  `The copy on ${to} didn't match the original, so it was discarded. Try again. ${nothingLost(from)}`;
export const moveHeldChanged = (from: string) =>
  `The conversation changed on ${from} while it was copied. Try again. ${nothingLost(from)}`;
export const moveHeldConnection = (to: string, from: string) =>
  `The conversation couldn't be copied to ${to} (connection lost). ${nothingLost(from)}`;
export const moveHeldCopyFailed = (to: string, from: string) =>
  `The conversation couldn't be copied to ${to}. ${nothingLost(from)}`;
export const moveBackground = (from: string) =>
  `The move was interrupted when SPAWN D went to the background. ${nothingLost(from)}`;
/** Interrupted after the target took the conversation: it only goes forward. */
export const moveBackgroundCommitted = (to: string) =>
  `The move to ${to} was interrupted when SPAWN D went to the background. Try again to finish it — nothing was lost.`;
/** The server would not take the move off this window yet. */
export const moveAbortFailed = (from: string) =>
  `SPAWN D couldn't put this window back on ${from} yet. Try again — nothing was lost.`;

/** After the target committed: the move only goes forward. */
export const moveCommitOffline = (to: string) =>
  `${to} went offline before the move finished. Try again when it's back — nothing was lost.`;
export const MOVE_COMMIT_FAILED = "SPAWN D couldn't finish the move. Try again — nothing was lost.";
/** The conversation arrived and the window could not follow by the carried
 *  commit (put back underneath the carry, and not to be begun again): the
 *  window can follow it there. */
export const moveConversationThere = (to: string) =>
  `The conversation is on ${to} now, but this window isn't. Take the window to ${to} to carry on there.`;
export const moveTakeThere = (to: string) => `Take the window to ${to}`;
export const MOVE_CONFLICT_SETTLED =
  "The move already finished or was cancelled from another device.";

/** A host did not answer while the move was being put back. */
export const moveUnresolvedTarget = (to: string) =>
  `${to} can't be reached, so the move can't be put back yet. The window stays “Moving” until you resolve it.`;
export const moveUnresolvedSource = (from: string) =>
  `${from} can't be reached, so the conversation can't be put back yet. The window stays “Moving” until you resolve it.`;
export const moveConflicts = (from: string) =>
  `Some of this conversation's files couldn't be put back on ${from} because files with those names are there. Sort them out by hand in Claude Code's projects folder on ${from}.`;

// ---- what other devices see, and resolving ---------------------------------

/** Lists, the host page and the fleet: the server's own word. */
export const MOVE_MOVING_LABEL = "Moving";
/** A pane and its terminal: the target cannot be named before the commit. */
export const MOVE_MOVING_STATUS = MOVING_STATUS_LABEL;
export const MOVE_RESOLVE = "Resolve";
export const MOVE_RESOLVE_TITLE = "Finish or put back this move?";
export const moveResolveBody = (from: string) =>
  `This window started moving from ${from} and didn't finish. SPAWN D will ask ${from} and the host it was going to where the conversation is, then finish the move or put it back.`;
export const moveResolving = (from: string) => `Checking ${from}…`;
export const MOVE_GIVE_UP = "Give up the move";
/**
 * Giving up when a host cannot answer: the server's move ends and neither
 * host is touched, so the conversation stays wherever it is now. `to` is
 * null where this device does not know where it was going.
 */
export const moveGiveUpBody = (from: string, to: string | null) =>
  `The window stops on ${from}. Its conversation stays where it is now — set aside on ${from}, or already on ${to ?? MOVE_HOST_IT_WAS_GOING_TO} — until you resolve the move from ${from}'s page.`;
/** What giving up left: the window back on its source, the rest to Resolve. */
export const moveGivenUp = (from: string) =>
  `The move was given up and the window is back on ${from}. Resolve its conversation from ${from}'s page once both hosts can be reached.`;
export const moveResolvedFinished = (to: string) => `Moved to ${to}.`;
export const moveResolveSourceOffline = (from: string) =>
  `${from} is offline, so this move can't be finished or put back until it's back.`;
/** `to` is null where this device cannot name the host it was going to. */
export const moveResolveTargetOffline = (to: string | null) =>
  `${to ?? "The host it was going to"} can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.`;
/** The source answers, lists no move of the window, and no longer holds the
 *  conversation where Claude Code looks: it may have arrived elsewhere. */
export const moveResolveUnconfirmed = (from: string) =>
  `${from} lists no unfinished move of this window and no longer holds its conversation, so it may already be on the host it was going to. SPAWN D left the move as it is.`;
export const MOVE_RESOLVE_FAILED = "SPAWN D couldn't resolve the move. Try again in a moment.";

// ---- the host's page ----------------------------------------------------------

export const MOVE_UNFINISHED_TITLE = "Unfinished moves";
export const moveOutgoingRow = (conversation: string, to: string) =>
  `Conversation ${conversation} moving to ${to}`;
export const moveIncomingRow = (conversation: string, from: string) =>
  `Conversation ${conversation} arriving from ${from}`;
export const moveStrandedRow = (conversation: string) =>
  `Conversation ${conversation} couldn't be put back whole`;
export const moveMovingWindowRow = (window: string) => `${window} · ${MOVE_MOVING_STATUS}`;
/** A conversation id as rows show it: its first eight characters. */
export const moveShortConversation = (id: string | null) => (id ? id.slice(0, 8) : "unknown");
