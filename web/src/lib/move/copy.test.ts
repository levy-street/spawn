import { describe, expect, test } from "bun:test";
import {
  backOnSourceToast,
  checkFailedBlock,
  checkingLine,
  claudeNotFoundWarning,
  conflictsLine,
  copyingLine,
  differentCommitWarning,
  duplicateNote,
  durationWarning,
  failureCopy,
  folderMissingBlock,
  formatProgress,
  giveUpBody,
  headLabel,
  incomingMoveRow,
  liveElsewhereBlock,
  liveHereBlock,
  moveBody,
  movedArchivedToast,
  movedGoneToast,
  movedToast,
  moveTitle,
  movingLine,
  NO_CONVERSATION_BLOCK,
  NOTE_COPIED_TOAST,
  needsNewerSpawnLine,
  notARepositoryWarning,
  notConnectedBlock,
  OPEN_WINDOW_LABEL,
  olderClaudeWarning,
  outgoingMoveRow,
  puttingBackLine,
  RESOLVE_TITLE,
  resolveBody,
  resolveOutcomeCopy,
  resolveToast,
  resolvingLine,
  resumeWhenOpenedLine,
  sameCommitLine,
  sourceOfflineBody,
  startingLine,
  stateLine,
  stoppingLine,
  storeNotReadyBlock,
  strandedMoveRow,
  TOO_LARGE_BLOCK,
  UNFINISHED_MOVES_HEADING,
} from "./copy";
import type { MoveFailure } from "./orchestrator";
import type { ResolveOutcome } from "./resolver";

const NAMES = { source: "dream", target: "mac", cwd: "~/code/spawn" };

const FAILURES: MoveFailure[] = [
  "source_offline",
  "move_in_progress",
  "move_conflict",
  "workspace_archived",
  "gone",
  "begin_failed",
  "conversation_live_elsewhere",
  "conversation_changed",
  "agent_still_running",
  "window_restarted",
  "window_unavailable",
  "transfer_unresolved",
  "too_large",
  "too_many_tasks",
  "export_failed",
  "conversation_live_here",
  "folder_missing",
  "store_missing",
  "insufficient_space",
  "too_many_transfers",
  "integrity_mismatch",
  "file_changed",
  "connection_lost",
  "copy_failed",
  "cancelled",
  "commit_target_offline",
  "commit_failed",
  "resolved_elsewhere",
  "conversation_on_target",
  "unresolved_source",
  "unresolved_target",
  "abort_failed",
];

/** A daemon or server code, or an agent's slug: never in front of a person. */
const CODE = /\b[a-z]+(?:_[a-z]+)+\b|claude-code/;

describe("what a move says", () => {
  test("every failure is a sentence, never a code — whatever the host's own words were", () => {
    for (const failure of FAILURES) {
      const copy = failureCopy(failure, NAMES, "conv.export refused (export_failed)");
      expect(copy.message).not.toMatch(CODE);
      if (failure !== "conversation_live_elsewhere") expect(copy.detail).toBeUndefined();
    }
  });

  test("every Resolve outcome is a sentence, never a code", () => {
    const outcomes: ResolveOutcome[] = [
      { kind: "finished", targetHostId: "t", archived: false },
      { kind: "finished", targetHostId: "t", archived: true },
      { kind: "put_back", restarted: true, conflicts: false },
      { kind: "source_unreachable" },
      { kind: "target_unreachable", targetHostId: null },
      { kind: "source_busy" },
      { kind: "given_up" },
      { kind: "on_target", targetHostId: "t", cwd: "~", conversationId: "c" },
      { kind: "elsewhere" },
      { kind: "gone" },
      { kind: "failed" },
    ];
    for (const outcome of outcomes)
      expect(resolveOutcomeCopy(outcome, { source: "dream", target: "mac" })).not.toMatch(CODE);
  });

  test("the copy line counts in the total's unit, 1024-based", () => {
    expect(formatProgress(3.1 * 1024 * 1024, 12.4 * 1024 * 1024)).toBe("3.1 of 12.4 MB");
    expect(formatProgress(16 * 1024, 40 * 1024)).toBe("16 of 40 KB");
    expect(formatProgress(10, 600)).toBe("10 of 600 B");
    expect(formatProgress(900, 600)).toBe("600 of 600 B");
    expect(formatProgress(2 * 1024 ** 3, 3 * 1024 ** 3)).toBe("2.0 of 3.0 GB");
    expect(copyingLine(16 * 1024, 40 * 1024)).toBe("Copying the conversation · 16 of 40 KB");
  });

  test("giving up says where the conversation may still be", () => {
    expect(giveUpBody("dream", "mac")).toBe(
      "The window stops on dream. Its conversation stays where it is now — set aside on dream, or already on mac — until you resolve the move from dream's page.",
    );
    expect(giveUpBody("dream", null)).toContain("the host it was going to");
  });

  test("reads as the phone's copy reads, string for string", () => {
    // The phone pins the same names to the same sentences
    // (mobile/src/components/workspace-detail/__tests__/move-copy.test.ts):
    // a change to one table is a change to the other in the same commit.
    const from = "dream";
    const to = "mac";
    const cwd = "~/code/spawn";
    const names = { source: from, target: to, cwd };
    const failure = (kind: MoveFailure) => failureCopy(kind, names).message;
    const MB = 1024 * 1024;
    expect({
      checking: checkingLine(from, to),
      title: moveTitle(to),
      body: moveBody(from, to, cwd, 13_000_000),
      running: stateLine("running", to),
      blocked: stateLine("blocked", to),
      idle: stateLine("idle", to),
      same: sameCommitLine("main", "1a2b3c4"),
      sameDetached: sameCommitLine(null, "1a2b3c4"),
      differ: differentCommitWarning(
        from,
        headLabel("main", "1a2b3c4"),
        to,
        headLabel("feat", null),
      ),
      notRepo: notARepositoryWarning(to, cwd),
      estimate: durationWarning("45 seconds"),
      older: olderClaudeWarning(to, "2.1.250", from, "2.1.289"),
      notFound: claudeNotFoundWarning(to),
      setAside: duplicateNote(to),
      liveElsewhere: liveElsewhereBlock(from),
      liveHere: liveHereBlock(to),
      storeNotReady: storeNotReadyBlock(to),
      folderMissing: folderMissingBlock(to, cwd),
      noConversation: NO_CONVERSATION_BLOCK,
      tooLarge: TOO_LARGE_BLOCK,
      refusedTooLarge: failure("too_large"),
      sourceOffline: sourceOfflineBody(from, to),
      notConnected: notConnectedBlock(to),
      checkFailed: checkFailedBlock(to),
      carrierMissing: needsNewerSpawnLine(`${from} and ${to}`, to),
      progress: movingLine(to),
      stopping: stoppingLine(from),
      copying: copyingLine(3.1 * MB, 12.4 * MB),
      starting: startingLine(to),
      puttingBack: puttingBackLine(from),
      doneWorking: movedToast(to, "running"),
      doneIdle: movedToast(to, "idle"),
      doneArchived: movedArchivedToast(to),
      closed: movedGoneToast(to),
      cancelled: failure("cancelled"),
      backOn: backOnSourceToast(from),
      commitOffline: failure("commit_target_offline"),
      unresolvedTarget: failure("unresolved_target"),
      unresolvedSource: failure("unresolved_source"),
      conflicts: conflictsLine(from),
      abortFailed: failure("abort_failed"),
      resolveTitle: RESOLVE_TITLE,
      resolveBody: resolveBody(from),
      resolving: resolvingLine(from),
      giveUp: giveUpBody(from, to),
      giveUpUnknown: giveUpBody(from, null),
      givenUp: resolveOutcomeCopy({ kind: "given_up" }, { source: from, target: to }),
      resolveSourceOffline: resolveOutcomeCopy(
        { kind: "source_unreachable" },
        { source: from, target: to },
      ),
      resolveTargetOffline: resolveOutcomeCopy(
        { kind: "target_unreachable", targetHostId: "t" },
        { source: from, target: to },
      ),
      resolveTargetUnknown: resolveOutcomeCopy(
        { kind: "target_unreachable", targetHostId: null },
        { source: from, target: null },
      ),
      settled: failure("resolved_elsewhere"),
      gone: failure("gone"),
      unfinished: UNFINISHED_MOVES_HEADING,
      outgoing: outgoingMoveRow("6f1c2a9e", to),
      incoming: incomingMoveRow("6f1c2a9e", from),
      stranded: strandedMoveRow("6f1c2a9e"),
      noteCopied: NOTE_COPIED_TOAST,
      resumeWhenOpened: resumeWhenOpenedLine(from),
      openWindow: OPEN_WINDOW_LABEL,
    }).toEqual({
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
});

describe("resolveToast", () => {
  const names = { source: "dream", target: "mac" };

  test("a put-back from a host's page says the outcome and offers the window its resume waits in", () => {
    expect(
      resolveToast({ kind: "put_back", restarted: true, conflicts: false }, names, true),
    ).toEqual({
      message: "Back on dream — nothing was lost.",
      detail: "Claude Code resumes on dream when you open the window.",
      persistent: true,
      openWindow: true,
    });
  });

  test("a finished move offers the window on its new host", () => {
    expect(
      resolveToast({ kind: "finished", targetHostId: "t", archived: false }, names, true),
    ).toEqual({
      message: "Moved to mac.",
      detail: "Claude Code resumes on mac when you open the window.",
      persistent: true,
      openWindow: true,
    });
  });

  test("nothing waiting, or nothing to resume, offers nothing", () => {
    expect(
      resolveToast({ kind: "put_back", restarted: true, conflicts: false }, names, false),
    ).toEqual({
      message: "Back on dream — nothing was lost.",
      detail: null,
      persistent: false,
      openWindow: false,
    });
    expect(
      resolveToast({ kind: "put_back", restarted: false, conflicts: false }, names, true)
        ?.openWindow,
    ).toBe(false);
    expect(
      resolveToast({ kind: "finished", targetHostId: "t", archived: true }, names, true)
        ?.openWindow,
    ).toBe(false);
  });

  test("files left over stay on screen, and the window is still offered", () => {
    const toast = resolveToast({ kind: "put_back", restarted: true, conflicts: true }, names, true);
    expect(toast?.detail).toBe(
      "Some of this conversation's files couldn't be put back on dream because files with those names are there. Sort them out by hand in Claude Code's projects folder on dream.",
    );
    expect(toast?.persistent).toBe(true);
    expect(toast?.openWindow).toBe(true);
  });

  test("the outcomes that still ask for something stay in the dialog", () => {
    for (const outcome of [
      { kind: "source_unreachable" },
      { kind: "target_unreachable", targetHostId: null },
      { kind: "source_busy" },
      { kind: "on_target", targetHostId: "t", cwd: "~", conversationId: "c" },
      { kind: "failed" },
    ] as ResolveOutcome[]) {
      expect(resolveToast(outcome, names, true)).toBeNull();
    }
    for (const outcome of [
      { kind: "given_up" },
      { kind: "elsewhere" },
      { kind: "gone" },
    ] as ResolveOutcome[]) {
      expect(resolveToast(outcome, names, false)?.message).toBe(resolveOutcomeCopy(outcome, names));
    }
  });
});
