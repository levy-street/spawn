import { describe, expect, test } from "bun:test";
import {
  deriveSetupProgress,
  SETUP_PROGRESS_ACTIVE_LABELS,
  SETUP_PROGRESS_LABELS,
  setupProgressStalledHint,
  visibleSetupSteps,
} from "./setup-progress";

describe("deriveSetupProgress", () => {
  test("tracks copied, approved, and online from observable state", () => {
    expect(
      deriveSetupProgress({
        commandCopied: true,
        locallyApproved: false,
        resumeApprovedHost: false,
        onlineHost: false,
      }),
    ).toEqual({ completed: [true, false, false], current: 2 });

    expect(
      deriveSetupProgress({
        commandCopied: true,
        locallyApproved: true,
        resumeApprovedHost: false,
        onlineHost: false,
      }),
    ).toEqual({ completed: [true, true, false], current: 3 });

    expect(
      deriveSetupProgress({
        commandCopied: true,
        locallyApproved: false,
        resumeApprovedHost: false,
        onlineHost: true,
      }),
    ).toEqual({ completed: [true, true, true], current: null });
  });

  test("an earlier approval resumes at the online wait", () => {
    expect(
      deriveSetupProgress({
        commandCopied: false,
        locallyApproved: false,
        resumeApprovedHost: true,
        onlineHost: false,
      }),
    ).toEqual({ completed: [false, true, false], current: 3 });
  });
});

describe("setupProgressStalledHint", () => {
  test("waits 60 seconds and disappears once the host is online", () => {
    const waiting = deriveSetupProgress({
      commandCopied: true,
      locallyApproved: false,
      resumeApprovedHost: false,
      onlineHost: false,
    });
    const online = deriveSetupProgress({
      commandCopied: true,
      locallyApproved: false,
      resumeApprovedHost: false,
      onlineHost: true,
    });
    expect(setupProgressStalledHint(waiting, 59_999)).toBeNull();
    expect(setupProgressStalledHint(waiting, 60_000)).toBe(
      "Having trouble? Re-run the install command — it's safe to repeat.",
    );
    expect(setupProgressStalledHint(online, 120_000)).toBeNull();
  });

  test("keeps active and completed labels aligned", () => {
    expect(SETUP_PROGRESS_ACTIVE_LABELS).toHaveLength(SETUP_PROGRESS_LABELS.length);
  });
});

describe("visibleSetupSteps", () => {
  test("drops a copy step this browser never witnessed", () => {
    // The terminal-first arrival: the command was run before the account
    // existed, so the row can never tick and is not a chore anyone skipped.
    const byLink = deriveSetupProgress({
      commandCopied: false,
      locallyApproved: true,
      resumeApprovedHost: false,
      onlineHost: false,
    });
    expect(visibleSetupSteps(byLink)).toEqual([2, 3]);

    const resumed = deriveSetupProgress({
      commandCopied: false,
      locallyApproved: false,
      resumeApprovedHost: true,
      onlineHost: false,
    });
    expect(visibleSetupSteps(resumed)).toEqual([2, 3]);
  });

  test("keeps all three where the copy is the step being waited on", () => {
    const waiting = deriveSetupProgress({
      commandCopied: false,
      locallyApproved: false,
      resumeApprovedHost: false,
      onlineHost: false,
    });
    expect(visibleSetupSteps(waiting)).toEqual([1, 2, 3]);

    const copied = deriveSetupProgress({
      commandCopied: true,
      locallyApproved: false,
      resumeApprovedHost: false,
      onlineHost: false,
    });
    expect(visibleSetupSteps(copied)).toEqual([1, 2, 3]);
  });
});
