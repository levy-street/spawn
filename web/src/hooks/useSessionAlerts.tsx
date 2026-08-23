"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { WorkspaceAvatar } from "@/components/nav/sidebar-parts";
import { useClaimedSessions, useTerminalHandles } from "@/components/terminal/LiveTerminalProvider";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { ALERT_TOAST_MS, toast } from "@/components/ui/toast";
import { claimAlert } from "@/lib/alert-claim";
import { subscribeToAlerts } from "@/lib/alert-socket";
import { type AlertEvent, alertBody, alertKey, alertTitle } from "@/lib/alerts";
import type { Agent, Session, Workspace } from "@/lib/api";
import { playAlertCue, showSystemAlert, vibrateAlert } from "@/lib/notify-channels";
import { alertKindEnabled, getNotifyPrefs, isSessionMuted } from "@/lib/notify-prefs";
import { tabOfSession } from "@/lib/tabs";

/**
 * Turns owner attention events into the channels the owner asked for.
 *
 * Mounted exactly once, in the app shell. It reads its inputs from the shared
 * React Query caches rather than taking props, because the shell remounts on
 * every route change and this must not care.
 *
 * Ordering is deliberate: the toast fires in every visible tab before the
 * cross-tab claim, because a toast is in-page UI and duplicating it across
 * two windows is correct. Sound, haptics and the OS notification all wait for
 * the claim, because duplicating those is just noise.
 */
export function useSessionAlerts(): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const getHandle = useTerminalHandles();
  // Read through a ref: the socket callback is installed once, and needs the
  // value as it is when an event lands, not as it was when it subscribed.
  const claimed = useClaimedSessions();
  const claimedRef = useRef(claimed);
  claimedRef.current = claimed;

  // Through a ref so the subscription is set up once: resubscribing on every
  // router identity change would drop events in the gap.
  const openRef = useRef<(sessionId: string, url: string) => void>(() => {});
  openRef.current = (sessionId, url) => {
    router.push(url);
    focusWhenReady(sessionId, getHandle);
  };

  useEffect(() => {
    return subscribeToAlerts((event) => {
      void deliverAlert(event, queryClient, {
        open: (sessionId, url) => openRef.current(sessionId, url),
        onScreen: (sessionId) => claimedRef.current[sessionId] === true,
      });
    });
  }, [queryClient]);
}

/**
 * Focus a session's terminal once its pane exists.
 *
 * The navigation that precedes this has to mount the workspace, the tab and
 * the pane before there is anything to focus, and none of that is awaitable
 * from here — so poll briefly and give up rather than guess a delay. Focusing
 * the terminal also selects the pane: the pane listens for `focusin`.
 */
function focusWhenReady(
  sessionId: string,
  getHandle: (id: string) => TerminalHandle | null,
  attemptsLeft = 40,
): void {
  const handle = getHandle(sessionId);
  if (handle) {
    handle.focus();
    return;
  }
  if (attemptsLeft <= 0) return;
  window.setTimeout(() => focusWhenReady(sessionId, getHandle, attemptsLeft - 1), 50);
}

async function deliverAlert(
  event: AlertEvent,
  queryClient: QueryClient,
  surface: {
    open: (sessionId: string, url: string) => void;
    onScreen: (sessionId: string) => boolean;
  },
): Promise<void> {
  const prefs = getNotifyPrefs();
  if (!alertKindEnabled(prefs, event.event)) return;
  if (isSessionMuted(event.session_id)) return;

  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  // You are looking straight at the pane. Telling you what you can already
  // see is the fastest way to make someone turn a feature off — and it is
  // every channel, not just the toast: a buzz for a pane on screen is worse
  // than a toast for one.
  if (visible && surface.onScreen(event.session_id)) {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    return;
  }

  const sessions = queryClient.getQueryData<Session[]>(["sessions"]);
  const session = sessions?.find((item) => item.id === event.session_id);
  const agents = queryClient.getQueryData<Agent[]>(["agents"]) ?? [];
  const workspace = workspaceOf(event.session_id, queryClient);

  // The event is also the freshest possible signal that the session list is
  // stale — the pane's own status dot should flip at the same moment the
  // alert lands, not five seconds later.
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });

  const hidden = !visible;
  const title = alertTitle(event, agents);
  const detail = alertBody(event, session, workspace?.name);
  const url = sessionUrl(event.session_id, workspace);

  if (!hidden && prefs.toast) {
    toast(title, {
      detail,
      durationMs: ALERT_TOAST_MS,
      onClick: () => surface.open(event.session_id, url),
      actionLabel: `Go to ${title}`,
      icon: <AlertMark workspace={workspace} command={event.command} />,
    });
  }

  // Nothing below here should happen twice on one browser.
  const claimed = await claimAlert(alertKey(event));
  if (!claimed) return;

  if (prefs.sound) playAlertCue(event.event);
  if (prefs.haptics) vibrateAlert(event.event);

  if (hidden && prefs.system) {
    await showSystemAlert({
      title,
      body: detail,
      // Same tag per session+event: a second alert for the same session
      // replaces the first instead of stacking a column in the shade.
      tag: `spawn:${event.event}:${event.session_id}`,
      url,
      // The sound channel already made a noise if it was asked to; letting
      // the OS chime as well double-alerts anyone running both.
      silent: prefs.sound,
    });
  }
}

/**
 * Where it happened, as one mark: the workspace's own avatar with the running
 * agent badged onto its corner.
 *
 * Two facts, one glance. The workspace is the bigger of the two because it is
 * what tells two otherwise identical Claude sessions apart, and the agent
 * rides the corner the way a status dot does on a pane header.
 */
function AlertMark({
  workspace,
  command,
}: {
  workspace: Workspace | null;
  command: string | null;
}) {
  if (!workspace) {
    return <AgentIcon command={command} size={36} className="rounded-md" />;
  }
  return (
    <span className="relative inline-flex shrink-0">
      <WorkspaceAvatar name={workspace.name} icon={workspace.icon} className="size-9 rounded-md" />
      {command ? (
        <AgentIcon
          command={command}
          size={23}
          // Ringed in the toast's own surface so the badge reads as sitting
          // on top of the avatar rather than merging into it. Squarer than the
          // plate's own `rounded-lg`, which at this size reads as a circle and
          // loses the app-icon shape the mark is drawn for.
          className="absolute -right-2 -top-2 rounded-[6px] ring-2 ring-popover"
        />
      ) : null}
    </span>
  );
}

function workspaceOf(sessionId: string, queryClient: QueryClient): Workspace | null {
  const workspaces = queryClient.getQueryData<Workspace[]>(["workspaces"]) ?? [];
  return workspaces.find((item) => tabOfSession(item.layout, sessionId) !== null) ?? null;
}

/**
 * Where clicking the notification should land: the workspace tab holding the
 * session, focused on it. Falls back to the standalone session page, which
 * always exists even for a session no workspace references.
 */
function sessionUrl(sessionId: string, workspace: Workspace | null): string {
  const tab = workspace ? tabOfSession(workspace.layout, sessionId) : null;
  if (workspace && tab) return `/w/${workspace.id}?tab=${tab.id}&focus=${sessionId}`;
  return `/sessions/${sessionId}`;
}
