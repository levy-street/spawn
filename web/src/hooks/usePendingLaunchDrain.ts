"use client";

import { useEffect, useRef } from "react";
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { deliverQueuedLaunch, refusalWatch } from "@/components/workspace/launch-delivery";
import { attachedLaunchHost, pendingLaunch } from "@/components/workspace/pending-launch";
import type { AgentNotice } from "@/lib/agent-notice";
import type { Session } from "@/lib/api";
import { agentRunning } from "@/lib/conversation";
import { askWindowHost } from "@/lib/conversation-inspect";
import type { DaemonConnection } from "@/lib/daemon-connection";
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
 *
 * A plain Codex launch is typed with `--no-daemon` only where the window's
 * host says, before the launch is claimed, that the window's Codex accepts it
 * (`deliverQueuedLaunch`). The host asks that Codex with the window's own
 * environment, but cannot see an alias or a shell hook; if the Codex that runs
 * refuses the flag anyway, the command is typed again without it, once, under
 * the rules of `retypeAfterRefusal`.
 */
export function usePendingLaunchDrain({
  sessionId,
  session,
  connInfo,
  displayState,
  getHandle,
  connection = null,
  agentNotice = null,
}: {
  sessionId: string;
  session: Pick<Session, "host_id" | "foreground_command"> | undefined;
  connInfo: SessionConnectionInfo | null;
  displayState: DisplayControlState | null;
  getHandle: () => TerminalHandle | null;
  /** The device's connection to the window's host, to ask it about Codex. */
  connection?: DaemonConnection | null;
  /** What the window's screen shows (`detectAgentNotice`). */
  agentNotice?: AgentNotice | null;
}): void {
  const attachedHost = attachedLaunchHost(session, connInfo);
  const owner = displayState?.owner === true;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  // What a refusal is weighed against, as of the moment it is weighed.
  const now = useRef({ attachedHost, owner, foreground: session?.foreground_command ?? null });
  now.current = { attachedHost, owner, foreground: session?.foreground_command ?? null };
  const refusal = useRef(refusalWatch());

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
      const connection = connectionRef.current;
      const questions = connection ? askWindowHost(attachedHost, connection, sessionId) : null;
      void deliverQueuedLaunch({
        peek: () => pendingLaunch.peekLaunch(sessionId, attachedHost),
        take: () => pendingLaunch.takeLaunch(sessionId, attachedHost),
        ask: questions ? questions.codexNoDaemon : null,
        // Still attached and holding the display: this effect is cancelled
        // the moment either changes, and the launch stays queued for the
        // next run of it.
        canType: () => !cancelled && getHandle() !== null,
        type: (command) => {
          const typing = getHandle() ?? handle;
          typing.sendInput(`${command}\r`);
          requestAnimationFrame(() => typing.focus());
        },
      })
        .then((delivered) => {
          if (delivered) refusal.current.arm(delivered, attachedHost);
        })
        .finally(() => questions?.doneAsking());
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [attachedHost, owner, getHandle, sessionId]);

  useEffect(() => {
    if (agentNotice !== "codex_no_daemon_refused") return;
    const moment = now.current;
    const connection = connectionRef.current;
    const questions =
      connection && moment.attachedHost
        ? askWindowHost(moment.attachedHost, connection, sessionId)
        : null;
    void refusal.current
      .refused({
        now: Date.now(),
        attachedHost: moment.attachedHost,
        owner: moment.owner,
        foreground: moment.foreground,
        agentRunning: async () => {
          const inspection = await questions?.inspect();
          return inspection ? agentRunning(inspection) : null;
        },
      })
      .then((command) => {
        questions?.doneAsking();
        // Still this view's to type into, after asking.
        const after = now.current;
        if (!command || !after.owner || after.attachedHost !== moment.attachedHost) return;
        getHandle()?.sendInput(`${command}\r`);
      });
  }, [agentNotice, getHandle, sessionId]);
}
