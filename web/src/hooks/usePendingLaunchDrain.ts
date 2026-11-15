"use client";

import { useEffect, useRef } from "react";
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  attachedLaunchHost,
  type PendingLaunchCommand,
  pendingLaunch,
} from "@/components/workspace/pending-launch";
import type { AgentNotice } from "@/lib/agent-notice";
import { askWindowHost } from "@/lib/conversation-inspect";
import type { DaemonConnection } from "@/lib/daemon-connection";
import type { DisplayControlState } from "@/lib/ws";

/** How long a queued launch waits for the view's terminal handle: 100 ms
 *  polls, so about five seconds — far longer than a handle ever lags. */
const PENDING_LAUNCH_HANDLE_TRIES = 50;

/** How long after typing `codex --no-daemon` a refusal of the flag is taken
 *  for this launch's, and answered by typing it again without. */
const NO_DAEMON_REFUSAL_WINDOW_MS = 60_000;

/**
 * The command to type for a queued launch: its `--no-daemon` form when it
 * has one and the window's host says, now, that the window's Codex accepts
 * it (`conv.launch`); the plain command otherwise — no host to ask, an older
 * daemon, a Codex that refuses the flag or one the host cannot tell about.
 */
export async function chooseLaunchCommand(
  launch: PendingLaunchCommand,
  ask: (() => Promise<boolean | null>) | null,
): Promise<string> {
  if (!launch.codexNoDaemon || !ask) return launch.command;
  const accepts = await ask().catch(() => null);
  return accepts === true ? launch.codexNoDaemon : launch.command;
}

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
 * host says the window's Codex accepts it (`chooseLaunchCommand`). The host
 * asks that Codex with the window's own environment, but cannot see an alias
 * or a shell hook; if the Codex that runs refuses the flag anyway
 * (`codex_no_daemon_refused` on screen soon after), the command is typed
 * again without it, once.
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
  session: { host_id: string } | undefined;
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
  // A `--no-daemon` launch just typed: the plain command to type if Codex
  // refuses the flag, until when.
  const refusalFallback = useRef<{ command: string; until: number } | null>(null);

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
      const launch = pendingLaunch.takeLaunch(sessionId, attachedHost);
      if (!launch) return;
      const connection = connectionRef.current;
      const questions =
        launch.codexNoDaemon && connection
          ? askWindowHost(attachedHost, connection, sessionId)
          : null;
      void chooseLaunchCommand(launch, questions?.codexNoDaemon ?? null).then((command) => {
        questions?.doneAsking();
        // Claimed, so typed: into whatever handle the view has now.
        const typing = getHandle() ?? handle;
        refusalFallback.current =
          command === launch.command
            ? null
            : { command: launch.command, until: Date.now() + NO_DAEMON_REFUSAL_WINDOW_MS };
        typing.sendInput(`${command}\r`);
        requestAnimationFrame(() => typing.focus());
      });
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [attachedHost, owner, getHandle, sessionId]);

  useEffect(() => {
    if (agentNotice !== "codex_no_daemon_refused") return;
    const fallback = refusalFallback.current;
    refusalFallback.current = null;
    if (!fallback || Date.now() > fallback.until) return;
    getHandle()?.sendInput(`${fallback.command}\r`);
  }, [agentNotice, getHandle]);
}
