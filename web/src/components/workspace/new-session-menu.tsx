"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderOpen, FolderTree, Plus, Server, SquareTerminal } from "lucide-react";
import {
  isValidElement,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import {
  type CascadeItem,
  CascadeMenu,
  type CascadeMenuHandle,
  type CascadePanel,
} from "@/components/ui/cascade-menu";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Agent, ApiError, agents, type Host, hosts, sessions, workspaces } from "@/lib/api";
import { autoPlace, type Rect } from "@/lib/grid";
import { activeTab, tabHome, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { pendingLaunch } from "./pending-launch";
import { addPaneTiles, PENDING_TILE_ID } from "./workspace-grid-helpers";

/** What the menu is about to add: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: Agent } | { kind: "files" };

function choiceKey(choice: Choice): string {
  return choice.kind === "agent" ? `agent-${choice.agent.id}` : choice.kind;
}

/** What the surface adds, and where it lands. Shared by both presentations. */
export type NewSessionProps = {
  mode: "session" | "workspace";
  workspaceId?: string;
  /** The tab the window lands in — its home answers "where". Defaults to the
   *  workspace's active tab. */
  tabId?: string;
  /** Drop the new window at this exact rect instead of auto-placing it. */
  placement?: Rect;
  /** `sessionId` is null when the menu added a widget rather than a session. */
  onCreated?: (r: { workspaceId: string; sessionId: string | null }) => void;
};

/**
 * The choice tree behind every "add a window" surface: what to run, then
 * where — unless the workspace's home answers that and one click is the whole
 * flow. Returns the panel to render, the disabled/tooltip state a trigger
 * wears, and the overlays every presentation has to mount (the folder picker
 * a "Select folder…" opens, and the error a refused create reports).
 */
function useNewSessionChoices({
  mode,
  workspaceId,
  tabId,
  placement,
  onCreated,
}: NewSessionProps): {
  root: CascadePanel;
  disabled: boolean;
  tooltip: string | undefined;
  overlays: JSX.Element;
} {
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
  const workspaceHasRoom = workspaceQ.data
    ? autoPlace(activeTab(workspaceQ.data.layout).layout.tiles).tile !== null
    : true;

  /*
   * Where a window added here opens: the tab's own home when it has one, else
   * the workspace's (chosen when it was created). With either, adding a window
   * never asks where — picking what (shell/agent/files) creates it at home
   * immediately. The folder browser remains only for a workspace without a
   * home (pre-migration rows whose sessions are gone, or a home host that has
   * been removed) and for the explicit "somewhere else" choice.
   */
  const home = (() => {
    if (mode !== "session" || !workspaceQ.data) return null;
    const layout = workspaceQ.data.layout;
    const resolved = tabHome(layout, tabId ?? activeTab(layout).id, workspaceQ.data);
    const host = resolved ? hostList.find((item) => item.id === resolved.host_id) : undefined;
    return host && resolved ? { host, cwd: resolved.cwd } : null;
  })();

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
        const id = crypto.randomUUID();
        const placed = placement
          ? [...tab.layout.tiles, { session_id: id, ...placement }]
          : addPaneTiles(tab.layout.tiles, id);
        if (!placed) throw new ApiError(409, "workspace_full", "workspace_full");
        const saved = await workspaces.update(workspaceId, {
          layout: withTabTiles(
            current.layout,
            tab.id,
            placed.map((tile) =>
              tile.session_id === id
                ? { ...tile, widget: { kind: "files" as const, host_id: host.id, path: cwd } }
                : tile,
            ),
          ),
        });
        return { workspaceId: saved.id, sessionId: null };
      }
      if (mode === "session") {
        if (!workspaceId) throw new Error("A workspace is required to create this session.");
        // Without an explicit drop rect, the pane joins an even band rather
        // than halving the biggest occupant. That reshapes the siblings too,
        // so the layout has to land before the create — the server refuses a
        // tile that overlaps what it still thinks is there.
        let tile = placement;
        if (!tile) {
          const current = await workspaces.get(workspaceId);
          const tab = activeTab(current.layout);
          const placed = addPaneTiles(tab.layout.tiles, PENDING_TILE_ID);
          if (!placed) throw new ApiError(409, "workspace_full", "workspace_full");
          const landed = placed.find((item) => item.session_id === PENDING_TILE_ID);
          if (landed) {
            tile = { x: landed.x, y: landed.y, w: landed.w, h: landed.h };
            await workspaces.update(workspaceId, {
              layout: withTabTiles(
                current.layout,
                tab.id,
                placed.filter((item) => item.session_id !== PENDING_TILE_ID),
              ),
            });
          }
        }
        const session = await sessions.create({
          host_id: host.id,
          cwd,
          workspace_id: workspaceId,
          tile,
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
        setErrorMessage("This workspace is full. Remove a window before adding another session.");
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

  /** Browse `host` for a folder; picking one creates the choice there. */
  const browseFolders = (host: Host, choice: Choice) => {
    setPickerChoice(choice);
    setPickerHost(host);
    setPickerOpen(true);
  };

  /**
   * "Somewhere other than home": the folder browser answers where, so there is
   * no menu of locations to step through — one host opens it straight away,
   * several ask which machine first.
   */
  const elsewhere = (choice: Choice): Pick<CascadeItem, "disabled" | "onSelect" | "panel"> => {
    const only = hostList.length === 1 ? hostList[0] : null;
    if (only) {
      return { disabled: only.status !== "online", onSelect: () => browseFolders(only, choice) };
    }
    return {
      panel: {
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
          onSelect: () => browseFolders(host, choice),
        })),
      },
    };
  };

  // What goes in the window; then where it points, unless home answers that.
  const target = (choice: Choice): Pick<CascadeItem, "disabled" | "onSelect" | "panel"> =>
    home
      ? {
          disabled: home.host.status !== "online",
          onSelect: () => createAt(home.host, home.cwd, choice),
        }
      : elsewhere(choice);

  const root: CascadePanel = {
    id: "widgets",
    title: mode === "workspace" ? "New workspace" : "Add a window",
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
              ...elsewhere({ kind: "shell" }),
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
              detail: "Browse a folder in a window",
              ...target({ kind: "files" }),
            },
          ]
        : []),
    ],
  };

  const disabled = workspaceFull || createM.isPending;
  const tooltip = workspaceFull
    ? "This workspace is full. Remove a window before adding another session."
    : createM.isPending
      ? "Creating session…"
      : undefined;

  const overlays = (
    <>
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
    </>
  );

  return { root, disabled, tooltip, overlays };
}

export function NewSessionMenu(
  props: NewSessionProps & {
    trigger: React.ReactNode;
    /**
     * "pointer" opens the menu at the click instead of under the trigger — for
     * triggers that are areas rather than buttons (an empty grid opening can be
     * half the canvas, so its corner is nowhere near the cursor).
     */
    anchor?: "trigger" | "pointer";
  },
): JSX.Element {
  const { trigger, mode, anchor = "trigger" } = props;
  const { root, disabled, tooltip, overlays } = useNewSessionChoices(props);
  const menuRef = useRef<CascadeMenuHandle>(null);

  return (
    <span className="relative inline-flex" title={tooltip}>
      <CascadeMenu
        ref={menuRef}
        root={root}
        sheetTitle={mode === "workspace" ? "New workspace" : "Add a window"}
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
      {overlays}
    </span>
  );
}

/**
 * One choice as a pill: icon, name, and a chevron when picking it still opens
 * a cascade. `detail` becomes the tooltip rather than a second line — the row
 * is meant to be scanned, not read.
 */
function Lozenge({
  item,
  disabled,
  ...triggerProps
}: {
  item: CascadeItem;
  disabled: boolean;
  /* What `CascadeMenu.renderTrigger` hands a trigger — all optional, so a leaf
     choice can pass its own `onSelect` as `onClick` and nothing else. */
  onClick?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu";
  "aria-controls"?: string;
}): JSX.Element {
  return (
    <button
      {...triggerProps}
      type="button"
      disabled={disabled}
      title={item.detail}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2",
        "text-sm font-medium transition-colors hover:border-ring/50 hover:bg-accent",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      {item.icon != null && (
        <span
          className="flex size-4.5 shrink-0 items-center justify-center [&>svg]:size-4"
          aria-hidden
        >
          {item.icon}
        </span>
      )}
      {item.label}
      {item.panel != null && (
        <ChevronRight className="-mr-1 size-3.5 shrink-0 opacity-50" aria-hidden />
      )}
    </button>
  );
}

/**
 * The cascade's own choices, laid flat as a row of lozenges — for the empty
 * state, where nothing else is on screen to compete with them and the shortest
 * path to a running window is one click on the thing you want. Choices that
 * still need a "where" (another folder, another host) open the cascade from
 * their own lozenge, so the row never has to answer that itself.
 */
export function NewSessionLozenges(props: NewSessionProps & { className?: string }): JSX.Element {
  const { root, disabled, tooltip, overlays } = useNewSessionChoices(props);
  // "Somewhere else" is the cascade's escape hatch for a surface with nothing
  // else to say where a window lands. The row has the tab's own folder sitting
  // right above it, which is the better answer, so it drops the item.
  const picks = root.items.filter((item) => item.key !== "shell-elsewhere");
  return (
    <div
      role="toolbar"
      aria-label={root.title}
      title={tooltip}
      className={cn("relative flex flex-wrap items-center justify-center gap-2", props.className)}
    >
      {picks.map((item) => {
        const shared = { item, disabled: disabled || Boolean(item.disabled) };
        const key = item.key ?? item.label;
        return item.panel ? (
          <CascadeMenu
            key={key}
            root={item.panel}
            sheetTitle={item.label}
            renderTrigger={(triggerProps) => <Lozenge {...shared} {...triggerProps} />}
          />
        ) : (
          <Lozenge key={key} {...shared} onClick={item.onSelect} />
        );
      })}
      {overlays}
    </div>
  );
}
