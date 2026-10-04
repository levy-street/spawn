"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { type JSX, type RefObject, useRef, useState } from "react";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import type { CascadeItem, CascadePanel } from "@/components/ui/cascade-menu";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Host, hosts, sessions, workspaces } from "@/lib/api";
import { focusedPane } from "@/lib/pane-focus";
import { displayPath, type Place, placeReasonLabel, suggestPlaces } from "@/lib/places";
import { activeTab, tabById } from "@/lib/tabs";
import { workspaceSessionIds } from "@/lib/workspaces";
import { FolderPicker } from "./folder-picker";

/**
 * "Where should this window run?" — asked by every surface that opens or moves
 * a window, since a workspace no longer answers it. The likeliest place comes
 * first (next to the focused pane, then this tab, this workspace, recent
 * places, each host's home), so the step is one keypress when the guess is
 * right; "Choose a folder…" browses any host for anything else.
 *
 * Returns a cascade panel to nest under a choice, or to open on its own, and
 * the folder browser it may open — which every presentation must mount.
 */
export function useWherePanel({
  workspaceId,
  tabId,
  exclude,
  anchorRef,
  onBack,
}: {
  workspaceId?: string | null;
  /** The tab the window lands in; the workspace's active tab when omitted. */
  tabId?: string | null;
  /** A place not to offer — where a pane being moved already runs. */
  exclude?: Place | null;
  /** What the folder browser hangs off — the cascade has closed by then. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Reopens the cascade behind the browser; omitted where there is none. */
  onBack?: () => void;
}): {
  /**
   * The panel for one choice: picking a place, or browsing to one, calls
   * `onPick`. `title` names it — "Where?" for a window about to open, the
   * where chip's "Where this runs" for one already running — and is what
   * the menu, and on a phone its sheet, is called.
   */
  panel: (id: string, onPick: (host: Host, cwd: string) => void, title?: string) => CascadePanel;
  overlays: JSX.Element;
} {
  const [browseHost, setBrowseHost] = useState<Host | null>(null);
  /** The choice a folder browse is for — the browser outlives the panel. */
  const browsePick = useRef<((host: Host, cwd: string) => void) | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    staleTime: 5_000,
  });
  const workspaceQ = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => workspaces.get(workspaceId as string),
    enabled: Boolean(workspaceId),
    staleTime: 10_000,
  });
  const hostList = hostsQ.data ?? [];
  const workspace = workspaceQ.data;
  const tab = workspace
    ? ((tabId ? tabById(workspace.layout, tabId) : null) ?? activeTab(workspace.layout))
    : null;
  const suggestions = suggestPlaces({
    sessions: sessionsQ.data ?? [],
    hosts: hostList,
    focusedSessionId: focusedPane(workspaceId),
    tabSessionIds: tab?.layout.tiles.map((tile) => tile.session_id) ?? [],
    workspaceSessionIds: workspace ? workspaceSessionIds(workspace) : [],
    exclude,
  });
  const hostOf = (id: string) => hostList.find((host) => host.id === id);

  const browse = (host: Host, onPick: (host: Host, cwd: string) => void) => {
    browsePick.current = onPick;
    setBrowseHost(host);
    setBrowseOpen(true);
  };

  const chooseFolder = (id: string, onPick: (host: Host, cwd: string) => void): CascadeItem => {
    const only = hostList.length === 1 ? hostList[0] : null;
    const base = { key: "browse", icon: <FolderOpen />, label: "Choose a folder…" };
    if (only) {
      return {
        ...base,
        detail: `Browse ${only.name}`,
        disabled: only.status !== "online",
        onSelect: () => browse(only, onPick),
      };
    }
    return {
      ...base,
      detail: "Browse any host",
      panel: {
        id: `${id}-hosts`,
        title: "Choose a host",
        emptyLabel: "Connect a host before creating a window.",
        items: hostList.map((host) => ({
          key: host.id,
          icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
          label: host.name,
          detail: host.status === "online" ? undefined : "offline",
          trailing: <HostUpdateBadge host={host} />,
          disabled: host.status !== "online",
          onSelect: () => browse(host, onPick),
        })),
      },
    };
  };

  const panel = (
    id: string,
    onPick: (host: Host, cwd: string) => void,
    title = "Where?",
  ): CascadePanel => ({
    id,
    title,
    loading: hostsQ.isLoading || sessionsQ.isLoading,
    emptyLabel: "Connect a host before creating a window.",
    items: hostList.length
      ? [
          ...suggestions.flatMap((place): CascadeItem[] => {
            const host = hostOf(place.hostId);
            if (!host) return [];
            return [
              {
                key: `${place.hostId}:${place.cwd}`,
                icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
                label: displayPath(place.cwd),
                detail: `${host.name} · ${place.online ? placeReasonLabel(place.reason) : "offline"}`,
                trailing: <HostUpdateBadge host={host} />,
                disabled: !place.online,
                onSelect: () => onPick(host, place.cwd),
              },
            ];
          }),
          chooseFolder(id, onPick),
        ]
      : [],
  });

  const overlays = (
    <FolderPicker
      key={`${browseHost?.id ?? "none"}:${browseOpen ? "open" : "closed"}`}
      open={browseOpen}
      host={browseHost}
      initialPath={suggestions.find((place) => place.hostId === browseHost?.id)?.cwd ?? null}
      anchorRef={anchorRef}
      onBack={
        onBack &&
        (() => {
          setBrowseOpen(false);
          onBack();
        })
      }
      onOpenChange={setBrowseOpen}
      onSelect={(path) => {
        if (browseHost) browsePick.current?.(browseHost, path);
      }}
    />
  );

  return { panel, overlays };
}
