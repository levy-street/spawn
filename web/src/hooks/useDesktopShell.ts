"use client";

import { useEffect, useState } from "react";
import { isDesktopShell } from "@/lib/platform";

/**
 * Whether this page is running inside SPAWN D's macOS app rather than a
 * browser tab — read from the webview's user agent, which is the one signal
 * that survives every navigation the product makes.
 *
 * Answered in an effect, never during render: the server has no agent to read,
 * so a component that answered `true` on its first client render would not
 * match the HTML it is hydrating. The first paint is therefore the browser's
 * paint, and the chrome that leads out of the app is dropped a frame later.
 */
export function useDesktopShell(): boolean {
  const [inShell, setInShell] = useState(false);

  useEffect(() => {
    setInShell(isDesktopShell(window.navigator.userAgent));
  }, []);

  return inShell;
}
