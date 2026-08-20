"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderClock,
  FolderOpen,
  FolderTree,
  Home,
  Plus,
  Server,
  SquareTerminal,
} from "lucide-react";
import {
  isValidElement,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import {
  CascadeMenu,
  type CascadeMenuHandle,
  type CascadePanel,
} from "@/components/ui/cascade-menu";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Agent, ApiError, agents, type Host, hosts, sessions, workspaces } from "@/lib/api";
import { autoPlace, type Rect } from "@/lib/grid";
import { basename } from "@/lib/paths";
import { activeTab, withTabTiles } from "@/lib/tabs";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { pendingLaunch } from "./pending-launch";

/** What the menu is about to add: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: Agent } | { kind: "files" };

function choiceKey(choice: Choice): string {
  return choice.kind === "agent" ? `agent-${choice.agent.id}` : choice.kind;
}

export function NewSessionMenu(props: {
  trigger: React.ReactNode;
  mode: "session" | "workspace";
  workspaceId?: string;
  /**
   * "pointer" opens the menu at the click instead of under the trigger — for
   * triggers that are areas rather than buttons (an empty grid opening can be
   * half the canvas, so its corner is nowhere near the cursor).
   */
  anchor?: "trigger" | "pointer";
  /** Drop the new pane at this exact rect instead of auto-placing it. */
  placement?: Rect;
  /** `sessionId` is null when the menu added a widget rather than a session. */
  onCreated?: (r: { workspaceId: string; sessionId: string | null }) => void;
}): JSX.Element {
  const { trigger, mode, workspaceId, placement, anchor = "trigger", onCreated } = props;
  const menuRef = useRef<CascadeMenuHandle>(null);
  const queryClient = useQueryClient();
  const [pickerHost, setPickerHost] = useState<Host | null>(null);
  const [pickerChoice, setPickerChoice] = useState<Choice>({ kind: "shell" });
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
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const hostList = hostsQ.data ?? [];
  const agentList = agentsQ.data ?? [];
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
    ? autoPlace(activeTab(workspaceQ.data.layout).layout.tiles).tile !== null
    : true;

  /*
   * The workspace's home: the host/folder chosen when it was created. When
   * set, adding a pane never asks where — picking what (shell/agent/files)
   * creates it at home immediately. The host+folder cascade remains only for
   * workspaces without a home (pre-migration rows whose sessions are gone,
   * or a home host that has been removed).
   */
  const homeHost =
    mode === "session" && workspaceQ.data?.host_id
      ? (hostList.find((host) => host.id === workspaceQ.data.host_id) ?? null)
      : null;
  const homeCwd = workspaceQ.data?.cwd ?? null;
  const home = homeHost && homeCwd ? { host: homeHost, cwd: homeCwd } : null;

  useEffect(() => {
    if (workspaceHasRoom) setWorkspaceFull(false);
  }, [workspaceHasRoom]);

  const createM = useMutation({
    mutationFn: async ({ host, cwd, choice }: { host: Host; cwd: string; choice: Choice }) => {
      if (choice.kind === "files") {
        if (!workspaceId) throw new Error("A workspace is required to add a file explorer.");
        // Widgets are layout, not sessions: place one in the active tab and
        // PATCH the envelope.
        const current = await workspaces.get(workspaceId);
        const tab = activeTab(current.layout);
        const placed = placement
          ? { tile: placement, tiles: tab.layout.tiles }
          : autoPlace(tab.layout.tiles);
        if (!placed.tile) throw new ApiError(409, "workspace_full", "workspace_full");
        const saved = await workspaces.update(workspaceId, {
          layout: withTabTiles(current.layout, tab.id, [
            ...placed.tiles,
            {
              session_id: crypto.randomUUID(),
              ...placed.tile,
              widget: { kind: "files" as const, host_id: host.id, path: cwd },
            },
          ]),
        });
        return { workspaceId: saved.id, sessionId: null };
      }
      if (mode === "session") {
        if (!workspaceId) throw new Error("A workspace is required to create this session.");
        const session = await sessions.create({
          host_id: host.id,
          cwd,
          workspace_id: workspaceId,
          tile: placement,
        });
        if (choice.kind === "agent") pendingLaunch.set(session.id, choice.agent.command);
        return { workspaceId, sessionId: session.id };
      }
      const result = await workspaces.create({ first_session: { host_id: host.id, cwd } });
      if (!result.session) throw new Error("The workspace was created without its first session.");
      if (choice.kind === "agent") pendingLaunch.set(result.session.id, choice.agent.command);
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

  const createAt = (host: Host, cwd: string, choice: Choice) => {
    if (host.status !== "online" || createM.isPending || workspaceFull) return;
    setErrorMessage(null);
    createM.mutate({ host, cwd, choice });
  };

  const locationPanel = (host: Host, choice: Choice): CascadePanel => {
    const recent = recentByHost.get(host.id);
    const recentItems = recent?.dirs ?? [];
    const scope = `${choiceKey(choice)}-${host.id}`;
    return {
      id: `locations-${scope}`,
      title: hostList.length > 1 ? host.name : "Choose a location",
      items: [
        {
          key: `${scope}-home`,
          icon: <Home />,
          label: "Home",
          detail: "~",
          disabled: host.status !== "online",
          onSelect: () => createAt(host, "~", choice),
        },
        ...(recentItems.length > 0
          ? [
              {
                key: `${scope}-recent-label`,
                icon: <FolderClock />,
                label: "Recent",
                disabled: true,
              },
              ...recentItems.map((item) => ({
                key: `${scope}-${item.path}`,
                icon: <FolderOpen />,
                label: basename(item.path) || item.path,
                detail: item.path,
                onSelect: () => createAt(host, item.path, choice),
              })),
            ]
          : []),
        {
          key: `${scope}-picker`,
          icon: <FolderOpen />,
          label: "Select folder…",
          disabled: host.status !== "online",
          onSelect: () => {
            setPickerChoice(choice);
            setPickerHost(host);
            setPickerOpen(true);
          },
        },
      ],
    };
  };

  const wherePanel = (choice: Choice): CascadePanel =>
    hostList.length === 1 && hostList[0]
      ? locationPanel(hostList[0], choice)
      : {
          id: `hosts-${choiceKey(choice)}`,
          title: "Choose a host",
          loading: hostsQ.isLoading,
          emptyLabel: "Connect a host before creating a session.",
          items: hostList.map((host) => ({
            key: host.id,
            icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
            label: host.name,
            detail: host.status === "offline" ? "offline" : undefined,
            disabled: host.status === "offline",
            panel: locationPanel(host, choice),
          })),
        };

  // What goes in the pane; then where it points, unless home answers that.
  const target = (choice: Choice) =>
    home
      ? {
          disabled: home.host.status !== "online",
          onSelect: () => createAt(home.host, home.cwd, choice),
        }
      : { panel: wherePanel(choice) };

  const root: CascadePanel = {
    id: "widgets",
    title: mode === "workspace" ? "New workspace" : "Add a pane",
    items: [
      {
        key: "shell",
        icon: <SquareTerminal />,
        label: "Shell",
        detail: home && home.host.status !== "online" ? "host offline" : "A plain login shell",
        ...target({ kind: "shell" }),
      },
      // Home answers "where" for everything above, so a workspace with one
      // needs this escape hatch to open a shell on another host (or just
      // another folder) without giving up the one-click default.
      ...(home
        ? [
            {
              key: "shell-elsewhere",
              icon: hostList.length > 1 ? <Server /> : <FolderOpen />,
              label: hostList.length > 1 ? "Shell on another host" : "Shell in another folder",
              detail: hostList.length > 1 ? "Pick a host and folder" : "Pick a folder",
              panel: wherePanel({ kind: "shell" }),
            },
          ]
        : []),
      ...agentList.map((agent) => ({
        key: agent.id,
        icon: <AgentIcon kind={agent.kind} size={18} className="rounded" />,
        label: agent.name,
        detail: agent.command,
        ...target({ kind: "agent", agent }),
      })),
      ...(mode === "session"
        ? [
            {
              key: "files",
              icon: <FolderTree />,
              label: "File explorer",
              detail: "Browse a folder in a pane",
              ...target({ kind: "files" }),
            },
          ]
        : []),
    ],
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
        ref={menuRef}
        root={root}
        sheetTitle={mode === "workspace" ? "New workspace" : "Add a pane"}
        renderTrigger={(triggerProps) =>
          isValidElement(trigger) ? (
            <Slot
              {...triggerProps}
              aria-disabled={disabled || undefined}
              data-disabled={disabled || undefined}
              tabIndex={disabled ? -1 : undefined}
              className={disabled ? "pointer-events-none opacity-50" : undefined}
              onClick={
                disabled
                  ? undefined
                  : (event: ReactMouseEvent) => {
                      // detail === 0 is keyboard activation: keep that anchored
                      // to the trigger, where focus already is.
                      if (anchor === "pointer" && event.detail > 0) {
                        menuRef.current?.toggleAt(event.clientX, event.clientY);
                        return;
                      }
                      triggerProps.onClick();
                    }
              }
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
          if (pickerHost) createAt(pickerHost, path, pickerChoice);
        }}
      />
    </span>
  );
}
