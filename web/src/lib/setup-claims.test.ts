import { describe, expect, test } from "bun:test";
import {
  deriveSetupChecklist,
  type SetupClaimState,
  setupChecklistStalledHint,
} from "./setup-claims";

const claim = (overrides: Partial<SetupClaimState> = {}): SetupClaimState => ({
  status: "pending",
  approval_ref: null,
  host_name: null,
  os: null,
  host_key_fingerprint: null,
  host_id: null,
  error: null,
  expires_at: "2026-08-25T01:00:00Z",
  ...overrides,
});

describe("deriveSetupChecklist", () => {
  test("moves pending, ready, approved, and online through the four milestones", () => {
    const pending = deriveSetupChecklist({ copied: true, claim: claim(), hostOnline: false });
    expect(pending).toMatchObject({ completedThrough: 1, waitingAfter: 1, failed: null });

    const ready = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "ready", approval_ref: "approval-ref" }),
      hostOnline: false,
    });
    expect(ready).toMatchObject({ completedThrough: 2, waitingAfter: 2, failed: null });

    const approved = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "approved", approval_ref: "approval-ref", host_id: "host-id" }),
      hostOnline: false,
    });
    expect(approved).toMatchObject({ completedThrough: 3, waitingAfter: 3, failed: null });

    expect(
      deriveSetupChecklist({
        copied: true,
        claim: claim({ status: "approved", approval_ref: "approval-ref", host_id: "host-id" }),
        hostOnline: true,
      }).completedThrough,
    ).toBe(4);
  });

  test("does not invent progress for an unbound failed claim", () => {
    const failed = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "failed", error: "expired" }),
      hostOnline: false,
    });
    expect(failed).toEqual({ completedThrough: 1, waitingAfter: 1, failed: "expired" });
  });

  test("keeps a bound failure at registered without implying approval", () => {
    const failed = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "failed", approval_ref: "approval-ref", error: "denied" }),
      hostOnline: false,
    });
    expect(failed).toEqual({ completedThrough: 2, waitingAfter: 2, failed: "denied" });
  });

  test("local approval advances immediately while the dependable claim poll catches up", () => {
    const approved = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "ready", approval_ref: "approval-ref" }),
      locallyApproved: true,
      hostOnline: false,
    });
    expect(approved.completedThrough).toBe(3);
  });
});

describe("setupChecklistStalledHint", () => {
  test("waits 60 seconds, then uses the exact shared hint for each transition", () => {
    const states = [
      deriveSetupChecklist({ copied: true, claim: claim(), hostOnline: false }),
      deriveSetupChecklist({
        copied: true,
        claim: claim({ status: "ready", approval_ref: "approval-ref" }),
        hostOnline: false,
      }),
      deriveSetupChecklist({
        copied: true,
        claim: claim({ status: "approved", approval_ref: "approval-ref" }),
        hostOnline: false,
      }),
    ];
    expect(states.map((state) => setupChecklistStalledHint(state, 59_999))).toEqual([
      null,
      null,
      null,
    ]);
    expect(states.map((state) => setupChecklistStalledHint(state, 60_000))).toEqual([
      "Having trouble? Re-run the install command — it's safe to repeat.",
      "The machine is waiting for your approval below.",
      "Approved. Waiting for the machine to come online — this usually takes a few seconds.",
    ]);
  });

  test("terminal and online states never show a stale waiting hint", () => {
    const failed = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "failed", error: "pin_limit" }),
      hostOnline: false,
    });
    const online = deriveSetupChecklist({
      copied: true,
      claim: claim({ status: "approved" }),
      hostOnline: true,
    });
    expect(setupChecklistStalledHint(failed, 120_000)).toBeNull();
    expect(setupChecklistStalledHint(online, 120_000)).toBeNull();
  });
});
