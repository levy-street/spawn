"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderClock, FolderOpen, Home, Plus } from "lucide-react";
import { isValidElement, type JSX, type ReactNode, useEffect, useMemo, useState } from "react";
import { CascadeMenu, type CascadePanel } from "@/components/ui/cascade-menu";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Host, hosts, sessions, workspaces } from "@/lib/api";
import { autoPlace } from "@/lib/grid";
import { basename } from "@/lib/paths";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { isWorkspaceFullError } from "./new-session-menu-helpers";

export function NewSessionMenu(props: {
  trigger: React.ReactNode;
  mode: "session" | "workspace";
  workspaceId?: string;
  onCreated?: (r: { workspaceId: string; sessionId: string }) => void;
}): JSX.Element {
  const { trigger, mode, workspaceId, onCreated } = props;
  const queryClient = useQueryClient();
  const [pickerHost, setPickerHost] = useState<Host | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspaceFull, setWorkspaceFull] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const workspaceQ = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => workspaces.get(workspaceId as string),
    enabled: mode === "session" && Boolean(workspaceId),
    staleTime: 10_000,
  });
  const hostList = hostsQ.data ?? [];
  const recentQueries = useQueries({
    queries: hostList.map((host) => ({
      queryKey: ["host-recent-dirs", host.id],
      queryFn: () => hosts.recentDirs(host.id),
      enabled: host.status === "online",
      staleTime: 30_000,
    })),
  });
  const recentByHost = useMemo(
    () =>
      new Map(
        hostList.map((host, index) => [
          host.id,
          {
            loading: recentQueries[index]?.isLoading ?? false,
            dirs: recentQueries[index]?.data?.dirs.slice(0, 8) ?? [],
          },
        ]),
      ),
    [hostList, recentQueries],
  );
  const workspaceHasRoom = workspaceQ.data
    ? autoPlace(workspaceQ.data.layout.tiles).tile !== null
    : true;

  useEffect(() => {
    if (workspaceHasRoom) setWorkspaceFull(false);
  }, [workspaceHasRoom]);

  const createM = useMutation({
    mutationFn: async ({ host, cwd }: { host: Host; cwd: string }) => {
      if (mode === "session") {
        if (!workspaceId) throw new Error("A workspace is required to create this session.");
        const session = await sessions.create({ host_id: host.id, cwd, workspace_id: workspaceId });
        return { workspaceId, sessionId: session.id };
      }
      const result = await workspaces.create({ first_session: { host_id: host.id, cwd } });
      if (!result.session) throw new Error("The workspace was created without its first session.");
      return { workspaceId: result.workspace.id, sessionId: result.session.id };
    },
    onSuccess: (result) => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", result.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onCreated?.(result);
    },
    onError: (error) => {
      if (isWorkspaceFullError(error)) {
        setWorkspaceFull(true);
        setErrorMessage("This workspace is full. Remove a pane before adding another session.");
        queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const createAt = (host: Host, cwd: string) => {
    if (host.status !== "online" || createM.isPending || workspaceFull) return;
    setErrorMessage(null);
    createM.mutate({ host, cwd });
  };

  const locationPanel = (host: Host): CascadePanel => {
    const recent = recentByHost.get(host.id);
    const recentItems = recent?.dirs ?? [];
    return {
      id: `locations-${host.id}`,
      title: hostList.length > 1 ? host.name : "Choose a location",
      items: [
        {
          key: `${host.id}-home`,
          icon: <Home />,
          label: "Home",
          detail: "~",
          disabled: host.status !== "online",
          onSelect: () => createAt(host, "~"),
        },
        ...(recentItems.length > 0
          ? [
              {
                key: `${host.id}-recent-label`,
                icon: <FolderClock />,
                label: "Recent",
                disabled: true,
              },
              ...recentItems.map((item) => ({
                key: `${host.id}-${item.path}`,
                icon: <FolderOpen />,
                label: basename(item.path) || item.path,
                detail: item.path,
                onSelect: () => createAt(host, item.path),
              })),
            ]
          : []),
        {
          key: `${host.id}-picker`,
          icon: <FolderOpen />,
          label: "Select folder…",
          disabled: host.status !== "online",
          onSelect: () => {
            setPickerHost(host);
            setPickerOpen(true);
          },
        },
      ],
    };
  };

  const root: CascadePanel =
    hostList.length === 1
      ? locationPanel(hostList[0])
      : {
          id: "hosts",
          title: "Choose a host",
          loading: hostsQ.isLoading,
          emptyLabel: "Connect a host before creating a session.",
          items: hostList.map((host) => ({
            key: host.id,
            icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
            label: host.name,
            detail: host.status === "offline" ? "offline" : undefined,
            disabled: host.status === "offline",
            panel: locationPanel(host),
          })),
        };

  const disabled = workspaceFull || createM.isPending;
  const tooltip = workspaceFull
    ? "This workspace is full. Remove a pane before adding another session."
    : createM.isPending
      ? "Creating session…"
      : undefined;

  return (
    <span className="relative inline-flex" title={tooltip}>
      <CascadeMenu
        root={root}
        sheetTitle={mode === "workspace" ? "New workspace" : "New session"}
        renderTrigger={(triggerProps) =>
          isValidElement(trigger) ? (
            <Slot
              {...triggerProps}
              aria-disabled={disabled || undefined}
              data-disabled={disabled || undefined}
              tabIndex={disabled ? -1 : undefined}
              className={disabled ? "pointer-events-none opacity-50" : undefined}
              onClick={disabled ? undefined : triggerProps.onClick}
              onKeyDown={disabled ? undefined : triggerProps.onKeyDown}
            >
              {trigger}
            </Slot>
          ) : (
            <button
              {...triggerProps}
              type="button"
              disabled={disabled}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              <Plus className="size-4" aria-hidden />
              {trigger as ReactNode}
            </button>
          )
        }
      />
      {errorMessage && !workspaceFull && (
        <span
          role="alert"
          className="absolute left-0 top-full z-50 mt-2 w-72 rounded-md border border-destructive/30 bg-popover px-3 py-2 text-xs text-destructive shadow-lg"
        >
          {errorMessage}
        </span>
      )}
      <FolderPickerDialog
        key={`${pickerHost?.id ?? "none"}:${pickerOpen ? "open" : "closed"}`}
        open={pickerOpen}
        host={pickerHost}
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          if (pickerHost) createAt(pickerHost, path);
        }}
      />
    </span>
  );
}
