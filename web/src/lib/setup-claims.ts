export const SETUP_CHECKLIST_LABELS = [
  "Command copied",
  "Machine registered",
  "Approved",
  "Online",
] as const;

/**
 * What each milestone is called while it is the one being waited on.
 *
 * The completed labels are past tense, which is right for a milestone that has
 * happened and wrong for the one that hasn't: a row reading "Online" beside a
 * spinner claims the machine is online while the reader watches it not be.
 * Naming the wait instead — "Connecting…" — says what is going on and turns
 * into the past-tense label the moment it is true.
 */
export const SETUP_CHECKLIST_ACTIVE_LABELS = [
  "Copy the command",
  "Waiting for the machine…",
  "Waiting for approval…",
  "Connecting…",
] as const;

export type SetupClaimStatus = "pending" | "ready" | "approved" | "failed";
export type SetupClaimError = "expired" | "denied" | "key_conflict" | "pin_conflict" | "pin_limit";

export interface SetupClaimState {
  status: SetupClaimStatus;
  approval_ref: string | null;
  host_name: string | null;
  os: string | null;
  host_key_fingerprint: string | null;
  host_id: string | null;
  error: SetupClaimError | null;
  expires_at: string;
}

export type SetupChecklistStep = 1 | 2 | 3 | 4;

export interface SetupChecklistState {
  /** The last completed checklist item; zero means the command is not copied yet. */
  completedThrough: 0 | SetupChecklistStep;
  /** The milestone whose next transition is currently quiet. */
  waitingAfter: SetupChecklistStep;
  failed: SetupClaimError | null;
}

const STALLED_HINTS: Partial<Record<SetupChecklistStep, string>> = {
  1: "Having trouble? Re-run the install command — it's safe to repeat.",
  2: "The machine is waiting for your approval below.",
  3: "Approved. Waiting for the machine to come online — this usually takes a few seconds.",
};

/**
 * Turn claim + host observations into the four visible milestones.
 *
 * A failed claim may still have reached the registered milestone (the server
 * keeps `approval_ref` once a ceremony bound), but failure is terminal and
 * never implies approval.
 */
export function deriveSetupChecklist(input: {
  copied: boolean;
  claim: SetupClaimState | null;
  locallyApproved?: boolean;
  hostOnline: boolean;
}): SetupChecklistState {
  const { copied, claim, locallyApproved = false, hostOnline } = input;
  const registered =
    claim?.status === "ready" ||
    claim?.status === "approved" ||
    (claim?.status === "failed" && claim.approval_ref !== null);
  const approved = claim?.status === "approved" || locallyApproved;

  let completedThrough: SetupChecklistState["completedThrough"] = copied ? 1 : 0;
  if (registered) completedThrough = 2;
  if (approved) completedThrough = 3;
  if (approved && hostOnline) completedThrough = 4;

  return {
    completedThrough,
    waitingAfter: completedThrough === 0 ? 1 : completedThrough === 4 ? 4 : completedThrough,
    failed: claim?.status === "failed" ? claim.error : null,
  };
}

/** Exact shared hint for a milestone that has stayed unchanged for 60 s. */
export function setupChecklistStalledHint(
  state: SetupChecklistState,
  elapsedMs: number,
): string | null {
  if (elapsedMs < 60_000 || state.failed || state.completedThrough === 4) return null;
  return STALLED_HINTS[state.waitingAfter] ?? null;
}
