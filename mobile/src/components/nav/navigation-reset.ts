import {
  type NavigationContainerRefWithCurrent,
  type NavigationState,
  type PartialState,
  StackActions,
} from "@react-navigation/native";
import { useSyncExternalStore } from "react";

/**
 * Landing on a root from the nav bar.
 *
 * A nav tap means "take me to that page", and everything between the person
 * and it — a terminal over a workspace over the tabs, a settings page three
 * deep — has to go. `dismissAll` only ever popped the *nearest* stack, so a
 * terminal opened from a workspace left the workspace standing over the tab
 * it was meant to reveal; every stack on the way down is popped here instead.
 *
 * The pops are also played without an animation. The card transition moves the
 * screen underneath as well as the card leaving, so the destination appeared to
 * slide across just as it was being landed on. While a landing is in progress
 * the stacks report `none` as their animation, and cards simply vanish over a
 * page that stays put.
 */
export type CardAnimation = "simple_push" | "none";

let landing = false;
const listeners = new Set<() => void>();

function setLanding(next: boolean): void {
  if (landing === next) return;
  landing = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a card stack should animate with right now. */
export function useCardAnimation(): CardAnimation {
  const instant = useSyncExternalStore(
    subscribe,
    () => landing,
    () => false,
  );
  return instant ? "none" : "simple_push";
}

type AnyNavigationState = NavigationState | PartialState<NavigationState>;

/** Every stack in the tree with something pushed, outermost first. */
export function stackKeysWithHistory(state: AnyNavigationState | undefined): string[] {
  const keys: string[] = [];
  const visit = (node: AnyNavigationState | undefined): void => {
    if (!node) return;
    if (node.type === "stack" && typeof node.key === "string" && node.routes.length > 1) {
      keys.push(node.key);
    }
    for (const route of node.routes) visit(route.state);
  };
  visit(state);
  return keys;
}

export type NavigationContainer = Pick<
  NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
  "dispatch" | "getRootState" | "isReady"
>;

/** Pops every stack in the tree to its first screen. Returns how many were popped. */
export function popEveryStackToTop(container: NavigationContainer): number {
  if (!container.isReady()) return 0;
  const keys = stackKeysWithHistory(container.getRootState());
  for (const key of keys) container.dispatch({ ...StackActions.popToTop(), target: key });
  return keys.length;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Switch to a root and clear everything stacked over it, in one instant cut.
 *
 * The animation switch has to reach the native stacks before the pops do, so
 * the pops wait a frame; the switch is held one more frame after them so the
 * removals are committed under it.
 */
export async function landOnRoot(container: NavigationContainer, switchTab: () => void) {
  setLanding(true);
  try {
    await nextFrame();
    switchTab();
    popEveryStackToTop(container);
    await nextFrame();
    await nextFrame();
  } finally {
    setLanding(false);
  }
}
