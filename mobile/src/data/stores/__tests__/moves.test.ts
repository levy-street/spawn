import type { MovePhase } from "@/components/workspace-detail/move-conversation";
import { holdsWindowMoving, resolvedUnderneath } from "@/data/stores/moves";

const failed = (held: boolean): MovePhase => ({
  step: "failed",
  failure: { message: "m", detail: null, actions: ["resume_source"], held },
});

describe("a move held moving on this device", () => {
  it("is a held failure, and nothing else", () => {
    expect(holdsWindowMoving(failed(true))).toBe(true);
    expect(holdsWindowMoving(failed(false))).toBe(false);
    expect(holdsWindowMoving({ step: "copying", sent: 1, total: 2 })).toBe(false);
    expect(holdsWindowMoving({ step: "restored", message: "m" })).toBe(false);
  });

  it("is let go once the row it held moving was resolved underneath it", () => {
    let state = resolvedUnderneath("w1:t1", true, null);
    expect(state).toEqual({ seen: "w1:t1", dismiss: false });
    state = resolvedUnderneath("w1:t1", false, state.seen);
    expect(state.dismiss).toBe(true);
  });

  it("a row never seen moving decides nothing", () => {
    expect(resolvedUnderneath("w1:t1", false, null)).toEqual({ seen: null, dismiss: false });
    // Seen for an earlier transfer of the window says nothing about this one.
    expect(resolvedUnderneath("w1:t2", false, "w1:t1")).toEqual({ seen: "w1:t1", dismiss: false });
    expect(resolvedUnderneath(null, false, "w1:t1")).toEqual({ seen: null, dismiss: false });
  });
});
