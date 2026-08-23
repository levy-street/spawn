import { useEffect, useRef } from "react";

interface TabNavigator {
  navigate: (name: string) => void;
}

let current: TabNavigator | null = null;

/**
 * A one-line bridge from the nav bar to the tab navigator.
 *
 * The bar cannot live inside the tab navigator: it is portalled to window level
 * so it survives a detail screen being pushed over the tabs, and react-native-screens
 * detaches the view hierarchy of any stack screen below the top one — which took
 * the bar with it. But a nav tap still has to be a *tab jump*. Routing to the
 * destination's href from outside appends a card to the root stack instead, which
 * is what made a nav tap slide the new page in over the old one.
 *
 * The registration has to come from the tab bar slot, not from the layout body:
 * `useNavigation()` inside a layout returns the navigation of the screen that
 * layout is rendered in — the parent stack — so navigating with it pushed a card
 * instead of switching tabs. The `tabBar` callback is handed the tab navigator
 * itself, and it keeps rendering while a detail screen covers the tabs, so the
 * registration survives.
 */
export function registerTabNavigator(navigator: TabNavigator): () => void {
  current = navigator;
  return () => {
    if (current === navigator) current = null;
  };
}

export function switchToTab(name: string, fallback: () => void): void {
  if (current === null) {
    fallback();
    return;
  }
  current.navigate(name);
}

/**
 * Rendered in the tab navigator's `tabBar` slot purely to hand its navigation
 * object to `switchToTab`. It draws nothing: the visible bar is mounted once at
 * app level so it outlives any card pushed over the tabs.
 */
export function useRegisteredTabNavigator(navigator: TabNavigator): void {
  // The caller passes a fresh object every render, so what gets registered is a
  // stable shim that reads the latest one — otherwise the registration would be
  // torn down and rebuilt on every frame the navigator re-renders.
  const latest = useRef(navigator);
  latest.current = navigator;

  useEffect(() => registerTabNavigator({ navigate: (name) => latest.current.navigate(name) }), []);
}
