export const SETUP_PROGRESS_LABELS = ["Command copied", "Approved", "Online"] as const;

export const SETUP_PROGRESS_ACTIVE_LABELS = [
  "Copy the command",
  "Waiting for approval…",
  "Connecting…",
] as const;

export type SetupProgressStep = 1 | 2 | 3;

export interface SetupProgressState {
  completed: readonly [boolean, boolean, boolean];
  current: SetupProgressStep | null;
}

/**
 * The milestones worth drawing, in order.
 *
 * Copying the command is a step this browser can only witness when it happened
 * here. Arriving on a machine's own approval link — the terminal-first path,
 * where the command was run before this account existed — the ceremony is
 * already past it, and the row can never tick: an unchecked chore, above two
 * checked ones, for work that was finished in another window.
 */
export function visibleSetupSteps(state: SetupProgressState): readonly SetupProgressStep[] {
  if (state.completed[0] || state.current === 1) return [1, 2, 3];
  return [2, 3];
}

/** Derive the onboarding milestones from facts the browser can observe. */
export function deriveSetupProgress(input: {
  commandCopied: boolean;
  locallyApproved: boolean;
  resumeApprovedHost: boolean;
  onlineHost: boolean;
}): SetupProgressState {
  const approved = input.locallyApproved || input.resumeApprovedHost || input.onlineHost;
  return {
    completed: [input.commandCopied, approved, input.onlineHost],
    current: input.onlineHost ? null : approved ? 3 : input.commandCopied ? 2 : 1,
  };
}

/** Exact shared hint for a machine that has stayed unchanged for 60 seconds. */
export function setupProgressStalledHint(
  state: SetupProgressState,
  elapsedMs: number,
): string | null {
  if (elapsedMs < 60_000 || state.current === null) return null;
  return "Having trouble? Re-run the install command — it's safe to repeat.";
}
