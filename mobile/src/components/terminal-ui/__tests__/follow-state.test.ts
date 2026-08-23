import {
  INITIAL_FOLLOW_STATE,
  reduceFollowState,
  shouldShowJumpToLatest,
} from "@/components/terminal-ui/follow-state";

const away = {
  atBottom: false,
  viewportY: 41,
  baseY: 90,
  buffer: "normal" as const,
  newOutputWhileAway: false,
};

describe("terminal follow state", () => {
  test("scrolling away suppresses follow and preserves the anchor", () => {
    const reading = reduceFollowState(INITIAL_FOLLOW_STATE, { type: "scroll", scroll: away });
    expect(reading).toEqual({ mode: "reading", anchorLine: 41, unread: false });
    expect(shouldShowJumpToLatest(reading)).toBe(true);
  });

  test("output while reading marks unread without moving the anchor", () => {
    const reading = { mode: "reading", anchorLine: 41, unread: false } as const;
    expect(reduceFollowState(reading, { type: "output-while-away" })).toEqual({
      mode: "reading",
      anchorLine: 41,
      unread: true,
    });
  });

  test.each(["jump-to-latest", "input-sent"] as const)(
    "%s restores follow and clears unread",
    (type) => {
      const reading = { mode: "reading", anchorLine: 41, unread: true } as const;
      expect(reduceFollowState(reading, { type })).toEqual(INITIAL_FOLLOW_STATE);
    },
  );

  test("manual arrival at bottom restores follow", () => {
    const reading = { mode: "reading", anchorLine: 41, unread: true } as const;
    const bottom = { ...away, atBottom: true, viewportY: 90 };
    expect(reduceFollowState(reading, { type: "scroll", scroll: bottom })).toEqual(
      INITIAL_FOLLOW_STATE,
    );
  });

  test("selection freezes follow then restores the prior reading state", () => {
    const reading = { mode: "reading", anchorLine: 41, unread: true } as const;
    const selecting = reduceFollowState(reading, { type: "enter-selection" });
    expect(selecting).toEqual({
      mode: "selecting",
      anchorLine: 41,
      unread: true,
      returnToFollowing: false,
    });
    expect(reduceFollowState(selecting, { type: "leave-selection" })).toEqual(reading);
  });

  test("alternate screen does not expose normal scrollback", () => {
    const reading = { mode: "reading", anchorLine: 41, unread: true } as const;
    expect(
      reduceFollowState(reading, {
        type: "scroll",
        scroll: { ...away, buffer: "alternate" },
      }),
    ).toEqual(INITIAL_FOLLOW_STATE);
  });
});
