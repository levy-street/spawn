import type { ScrollState } from "@/terminal/transport/types";

export type FollowState =
  | { mode: "following"; unread: false }
  | { mode: "reading"; anchorLine: number; unread: boolean }
  | { mode: "selecting"; anchorLine: number; unread: boolean; returnToFollowing: boolean };

export type FollowEvent =
  | { type: "scroll"; scroll: ScrollState }
  | { type: "output-while-away" }
  | { type: "jump-to-latest" }
  | { type: "input-sent" }
  | { type: "enter-selection" }
  | { type: "leave-selection" }
  | { type: "first-paint" };

export const INITIAL_FOLLOW_STATE: FollowState = { mode: "following", unread: false };

export function reduceFollowState(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "first-paint":
    case "jump-to-latest":
    case "input-sent":
      return INITIAL_FOLLOW_STATE;
    case "scroll": {
      if (event.scroll.buffer === "alternate" || event.scroll.atBottom) {
        return state.mode === "selecting" ? state : INITIAL_FOLLOW_STATE;
      }
      if (state.mode === "selecting") {
        return {
          ...state,
          anchorLine: event.scroll.viewportY,
          unread: state.unread || event.scroll.newOutputWhileAway,
        };
      }
      return {
        mode: "reading",
        anchorLine: event.scroll.viewportY,
        unread: state.unread || event.scroll.newOutputWhileAway,
      };
    }
    case "output-while-away":
      return state.mode === "following" ? state : { ...state, unread: true };
    case "enter-selection":
      if (state.mode === "selecting") return state;
      return {
        mode: "selecting",
        anchorLine: state.mode === "reading" ? state.anchorLine : 0,
        unread: state.unread,
        returnToFollowing: state.mode === "following",
      };
    case "leave-selection":
      if (state.mode !== "selecting") return state;
      return state.returnToFollowing
        ? INITIAL_FOLLOW_STATE
        : { mode: "reading", anchorLine: state.anchorLine, unread: state.unread };
  }
}

export function shouldShowJumpToLatest(state: FollowState): boolean {
  return state.mode !== "following";
}
