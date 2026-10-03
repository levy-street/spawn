"use client";

import { useEffect } from "react";
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { attachedLaunchHost, pendingLaunch } from "@/components/workspace/pending-launch";
import type { DisplayControlState } from "@/lib/ws";

/** How long a queued launch waits for the view's terminal handle: 100 ms
 *  polls, so about five seconds — far longer than a handle ever lags. */
const PENDING_LAUNCH_HANDLE_TRIES = 50;

/**
 * Type the agent queued for this window into it — picked from a "+" menu, or
 * queued by a restart or a move for the shell that replaces the old one — once
 * this view's transport can actually carry the keystrokes.
 *
 * Every time the transport opens, not once per view: a restart closes and
 * reopens it, a move opens it on another host, and the command belongs to the
 * shell on the far side of that reopen. So it waits for the transport to be
 * attached to the host the window runs on now and for this view to hold the
 * display (`canTypePendingLaunch`). Attached there, the view is also evidence
 * of where the window runs, and a command queued for it as it ran on another
 * host is dropped. The handle can lag the transport by a render or two, so the
 * command is only claimed once something can type it; a claim that could not
 * be typed is a launch silently lost.
 */
export function usePendingLaunchDrain({
  sessionId,
  session,
  connInfo,
  displayState,
  getHandle,
}: {
  sessionId: string;
  session: { host_id: string } | undefined;
  connInfo: SessionConnectionInfo | null;
  displayState: DisplayControlState | null;
  getHandle: () => TerminalHandle | null;
}): void {
  const attachedHost = attachedLaunchHost(session, connInfo);
  const owner = displayState?.owner === true;
  useEffect(() => {
    if (attachedHost === null) return;
    pendingLaunch.observe(sessionId, attachedHost);
    if (!owner || !pendingLaunch.has(sessionId, attachedHost)) return;
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const handle = getHandle();
      if (!handle) {
        if (tries++ < PENDING_LAUNCH_HANDLE_TRIES) window.setTimeout(attempt, 100);
        return;
      }
      const command = pendingLaunch.take(sessionId, attachedHost);
      if (!command) return;
      handle.sendInput(`${command}\r`);
      requestAnimationFrame(() => handle.focus());
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [attachedHost, owner, getHandle, sessionId]);
}
