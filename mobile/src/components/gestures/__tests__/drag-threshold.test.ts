import {
  type DragDecisionInput,
  restingOffset,
  shouldCommitDrag,
} from "@/components/gestures/drag-threshold";

const BASE_INPUT: DragDecisionInput = {
  translation: 0,
  velocity: 0,
  size: 100,
};

describe("shouldCommitDrag", () => {
  it("commits a slow drag past the default threshold in either direction", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 36 })).toBe(true);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -36 })).toBe(true);
  });

  it("commits a fast flick from a short distance", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 10, velocity: 200 })).toBe(true);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -10, velocity: -200 })).toBe(true);
  });

  it("does not commit a slow drag short of the threshold", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 34 })).toBe(false);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -34 })).toBe(false);
  });

  it("lets opposing velocity pull the projected release below threshold", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 40, velocity: -100 })).toBe(false);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -40, velocity: 100 })).toBe(false);
  });

  it("does not reverse-commit when opposing velocity projects across the origin", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 10, velocity: -1000 })).toBe(false);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -10, velocity: 1000 })).toBe(false);
  });

  it("commits exactly at the boundary", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 35 })).toBe(true);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: -35 })).toBe(true);
  });

  it("honours custom threshold and projection windows", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 49, threshold: 0.5 })).toBe(false);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 50, threshold: 0.5 })).toBe(true);
    expect(
      shouldCommitDrag({
        ...BASE_INPUT,
        translation: 10,
        velocity: 100,
        projectionMs: 250,
      }),
    ).toBe(true);
  });

  it("rejects a non-positive dimension", () => {
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 100, size: 0 })).toBe(false);
    expect(shouldCommitDrag({ ...BASE_INPUT, translation: 100, size: -100 })).toBe(false);
  });
});

describe("restingOffset", () => {
  it("returns zero when a drag does not commit", () => {
    expect(restingOffset({ ...BASE_INPUT, translation: 40 }, false)).toBe(0);
  });

  it("returns the signed full dimension when a drag commits", () => {
    expect(restingOffset({ ...BASE_INPUT, translation: 40 }, true)).toBe(100);
    expect(restingOffset({ ...BASE_INPUT, translation: -40 }, true)).toBe(-100);
  });

  it("uses drag direction and falls back to velocity from rest", () => {
    expect(restingOffset({ ...BASE_INPUT, translation: 10, velocity: -500 }, true)).toBe(100);
    expect(restingOffset({ ...BASE_INPUT, translation: -10, velocity: 500 }, true)).toBe(-100);
    expect(restingOffset({ ...BASE_INPUT, velocity: -500 }, true)).toBe(-100);
  });

  it("returns zero for a non-positive dimension", () => {
    expect(restingOffset({ ...BASE_INPUT, translation: 40, size: 0 }, true)).toBe(0);
  });
});
