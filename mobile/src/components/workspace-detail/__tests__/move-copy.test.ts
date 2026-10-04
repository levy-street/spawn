import * as copy from "@/components/workspace-detail/move-copy";
import { formatCarryProgress } from "@/data/selectors/move-facts";

/**
 * What a move says, rendered for a fixed set of names: the strings the
 * browser's copy module renders for the same inputs (web/src/lib/move/copy.ts)
 * must read the same, so a parity review diffs this list against its own.
 * Nothing here may carry a daemon or server code, a definition's slug, or the
 * product named any way but SPAWN D.
 */

const from = "dream";
const to = "mac";
const cwd = "~/code/spawn";

const RENDERED: Record<string, string> = {
  checking: copy.moveChecking(from, to),
  title: copy.moveTitle(to),
  body: copy.moveBody({ from, to, cwd, bytes: 13_000_000 }),
  running: copy.moveStateLine("running", to),
  blocked: copy.moveStateLine("blocked", to),
  idle: copy.moveStateLine("idle", to),
  same: copy.moveBothOn("main", "1a2b3c4"),
  sameDetached: copy.moveBothOn(null, "1a2b3c4"),
  differ: copy.moveHeadsDiffer(
    from,
    copy.moveHeadLabel("main", "1a2b3c4"),
    to,
    copy.moveHeadLabel("feat", null),
  ),
  notRepo: copy.moveNotARepository(to, cwd),
  estimate: copy.moveEstimate("45 seconds"),
  older: copy.moveOlderAgent(to, "2.1.250", from, "2.1.289"),
  notFound: copy.moveAgentNotFound(to),
  setAside: copy.moveDuplicateSetAside(to),
  liveElsewhere: copy.moveLiveElsewhere(from),
  liveHere: copy.moveLiveHere(to),
  storeNotReady: copy.moveStoreNotReady(to),
  folderMissing: copy.moveFolderMissing(to, cwd),
  noConversation: copy.MOVE_NO_CONVERSATION,
  tooLarge: copy.MOVE_TOO_LARGE,
  refusedTooLarge: copy.MOVE_REFUSED_TOO_LARGE,
  sourceOffline: copy.moveSourceOffline(from, to),
  notConnected: copy.moveNotConnected(to),
  checkFailed: copy.moveCheckFailed(to),
  carrierMissing: copy.moveCarrierMissing(`${from} and ${to}`, to),
  agentFresh: copy.moveAgentStartsFresh(cwd, to, "Codex"),
  progress: copy.moveProgressTitle(to),
  stopping: copy.moveStopping(from),
  copying: (() => {
    const progress = formatCarryProgress(3.1 * 1024 * 1024, 12.4 * 1024 * 1024);
    return copy.moveCopying(progress.done, progress.total);
  })(),
  starting: copy.moveStarting(to),
  puttingBack: copy.movePuttingBack(from),
  doneWorking: copy.moveDoneWorking(to),
  doneIdle: copy.moveDoneIdle(to),
  doneArchived: copy.moveDoneArchived(to),
  closed: copy.moveWindowClosed(to),
  cancelled: copy.moveCancelled(from),
  backOn: copy.moveBackOn(from),
  commitOffline: copy.moveCommitOffline(to),
  unresolvedTarget: copy.moveUnresolvedTarget(to),
  unresolvedSource: copy.moveUnresolvedSource(from),
  conflicts: copy.moveConflicts(from),
  abortFailed: copy.moveAbortFailed(from),
  resolveTitle: copy.MOVE_RESOLVE_TITLE,
  resolveBody: copy.moveResolveBody(from),
  resolving: copy.moveResolving(from),
  giveUp: copy.moveGiveUpBody(from, to),
  giveUpUnknown: copy.moveGiveUpBody(from, null),
  givenUp: copy.moveGivenUp(from),
  resolveSourceOffline: copy.moveResolveSourceOffline(from),
  resolveTargetOffline: copy.moveResolveTargetOffline(to),
  resolveTargetUnknown: copy.moveResolveTargetOffline(null),
  settled: copy.MOVE_CONFLICT_SETTLED,
  gone: copy.MOVE_WINDOW_GONE,
  unfinished: copy.MOVE_UNFINISHED_TITLE,
  outgoing: copy.moveOutgoingRow("6f1c2a9e", to),
  incoming: copy.moveIncomingRow("6f1c2a9e", from),
  stranded: copy.moveStrandedRow("6f1c2a9e"),
  noteCopied: copy.ARRIVAL_NOTE_COPIED,
  resumeWhenOpened: copy.moveResumeWhenOpened(from),
  openWindow: copy.MOVE_OPEN_WINDOW,
};

describe("what a move says", () => {
  it("reads as the browser's copy reads, string for string", () => {
    expect(RENDERED).toEqual({
      checking: "Checking dream and mac…",
      title: "Move Claude Code to mac?",
      body: "Claude Code stops on dream and continues this conversation on mac, in ~/code/spawn. The conversation comes with it (12 MB); the files it was working on don't, so ~/code/spawn on mac needs your latest work.",
      running:
        "Claude Code is working right now. On mac it will be told about the move and carry on.",
      blocked:
        "Claude Code is waiting for an answer. On mac it will be told about the move and ask again.",
      idle: "On mac, your next message will start with a note about the move.",
      same: "Both are on main at 1a2b3c4.",
      sameDetached: "Both are at 1a2b3c4.",
      differ: "dream is on main at 1a2b3c4; mac is on feat.",
      notRepo:
        "~/code/spawn on mac isn't a git repository, so SPAWN D can't compare it with the one here.",
      estimate: "This will take about 45 seconds. Keep SPAWN D open until it finishes.",
      older: "Claude Code on mac (2.1.250) is older than on dream (2.1.289).",
      notFound: "SPAWN D couldn't find Claude Code on mac.",
      setAside: "An older copy of this conversation on mac will be set aside.",
      liveElsewhere:
        "This conversation is also open in another window or in the background on dream. Close it there first.",
      liveHere: "This conversation is open in Claude Code on mac. Close it there first.",
      storeNotReady:
        "Claude Code hasn't been set up on mac yet. Run claude there once and sign in, then move.",
      folderMissing:
        "~/code/spawn doesn't exist on mac. Create it there, or start fresh — a new conversation creates the folder.",
      noConversation:
        "SPAWN D couldn't tell which conversation this window is in, so it can't come along.",
      tooLarge: "This conversation has a file over 512 MB, more than a move can carry.",
      refusedTooLarge: "This conversation is more than a move can carry, so nothing was moved.",
      sourceOffline:
        "dream is offline, so this conversation can't come along. Start a new one on mac instead?",
      notConnected:
        "mac isn't connected to this device right now, so the conversation can't come along.",
      checkFailed: "SPAWN D couldn't check mac. Try again in a moment.",
      carrierMissing:
        "SPAWN D on dream and mac can't carry conversations yet, so Claude Code starts a new one on mac.",
      agentFresh:
        "The window moves to ~/code/spawn on mac, and what runs in it here stops. Codex can't bring its conversation to another host yet, so it starts a new one on mac.",
      progress: "Moving to mac…",
      stopping: "Stopping Claude Code on dream…",
      copying: "Copying the conversation · 3.1 of 12.4 MB",
      starting: "Starting on mac…",
      puttingBack: "Putting the conversation back on dream…",
      doneWorking: "Moved to mac — Claude Code is carrying on.",
      doneIdle: "Moved to mac — your next message starts with a note about the move.",
      doneArchived: "Moved to mac. Its workspace is archived, so it starts when you restore it.",
      closed: "The conversation moved to mac, but this window was closed meanwhile.",
      cancelled: "Move cancelled. Nothing was lost — it's still on dream.",
      backOn: "Back on dream — nothing was lost.",
      commitOffline:
        "mac went offline before the move finished. Try again when it's back — nothing was lost.",
      unresolvedTarget:
        "mac can't be reached, so the move can't be put back yet. The window stays “Moving” until you resolve it.",
      unresolvedSource:
        "dream can't be reached, so the conversation can't be put back yet. The window stays “Moving” until you resolve it.",
      conflicts:
        "Some of this conversation's files couldn't be put back on dream because files with those names are there. Sort them out by hand in Claude Code's projects folder on dream.",
      abortFailed:
        "SPAWN D couldn't put this window back on dream yet. Try again — nothing was lost.",
      resolveTitle: "Finish or put back this move?",
      resolveBody:
        "This window started moving from dream and didn't finish. SPAWN D will ask dream and the host it was going to where the conversation is, then finish the move or put it back.",
      resolving: "Checking dream…",
      giveUp:
        "The window stops on dream. Its conversation stays where it is now — set aside on dream, or already on mac — until you resolve the move from dream's page.",
      giveUpUnknown:
        "The window stops on dream. Its conversation stays where it is now — set aside on dream, or already on the host it was going to — until you resolve the move from dream's page.",
      givenUp:
        "The move was given up and the window is back on dream. Resolve its conversation from dream's page once both hosts can be reached.",
      resolveSourceOffline:
        "dream is offline, so this move can't be finished or put back until it's back.",
      resolveTargetOffline:
        "mac can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.",
      resolveTargetUnknown:
        "The host it was going to can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.",
      settled: "The move already finished or was cancelled from another device.",
      gone: "This window no longer exists.",
      unfinished: "Unfinished moves",
      outgoing: "Conversation 6f1c2a9e moving to mac",
      incoming: "Conversation 6f1c2a9e arriving from dream",
      stranded: "Conversation 6f1c2a9e couldn't be put back whole",
      noteCopied: "Copied the move note.",
      resumeWhenOpened: "Claude Code resumes on dream when you open the window.",
      openWindow: "Open window",
    });
  });

  it("never says a code, a slug, or the product any way but SPAWN D", () => {
    for (const line of Object.values(RENDERED)) {
      expect(line).not.toMatch(/claude-code|[a-z]+_[a-z]+|(?<!\/)\bspawn\b|Spawn D|SPAWN D\./);
    }
  });
});
