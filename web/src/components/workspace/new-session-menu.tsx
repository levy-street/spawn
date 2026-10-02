"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderTree, Plus, SquareTerminal } from "lucide-react";
import {
  isValidElement,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { HostUpdateDialog, useHostUpdate } from "@/components/release/HostUpdateDialog";
import {
  type CascadeItem,
  CascadeMenu,
  type CascadeMenuHandle,
  type CascadePanel,
} from "@/components/ui/cascade-menu";
import { type Agent, ApiError, agents, type Host, sessions, workspaces } from "@/lib/api";
import { autoPlace, type Rect } from "@/lib/grid";
import { activeTab, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { agentLaunchCommand, newAgentConversationId } from "./agent-command";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { pendingLaunch } from "./pending-launch";
import { useWherePanel } from "./where-picker";
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
  /**
   * The tab the window lands in, which ranks the places offered for it.
   * Defaults to the workspace's active tab. Explicitly null for a tab that
   * does not exist yet (the strip's "+", which makes the tab as part of the
   * create).
   */
  tabId?: string | null;
  /** Drop the new window at this exact rect instead of auto-placing it. */
  placement?: Rect;
  /** Overrides what the menu calls itself — the heading over the root panel,
   *  and the mobile sheet's title. */
  heading?: string;
  /** Drops the heading row over the root panel, for a trigger that already
   *  says what the menu is. The mobile sheet keeps its title: it opens over
   *  the whole screen with no trigger left beside it to read. */
  hideHeading?: boolean;
  /**
   * Run just before the window is created, for a caller that has to make room
   * for it first — the strip's "+" adds the tab (and makes it active, which is
   * what puts the window in it) here. Whatever it returns is called if the
   * create then fails, so a tab added for a window that never opened does not
   * stay behind.
   */
  beforeCreate?: () => Promise<(() => void) | undefined>;
  /** `sessionId` is null when the menu added a widget rather than a session. */
  onCreated?: (r: { workspaceId: string; sessionId: string | null }) => void;
};

/**
 * The choice tree behind every "add a window" surface: what to run, then
 * where — always asked, with the likeliest place first (useWherePanel).
 * Returns the panel to render, the disabled/tooltip state a trigger wears,
 * and the overlays every presentation has to mount (the folder browser
 * "Choose a folder…" opens, and the error a refused create reports).
 */
function useNewSessionChoices(
  {
    mode,
    workspaceId,
    tabId,
    placement,
    heading,
    hideHeading,
    beforeCreate,
    onCreated,
  }: NewSessionProps,
  /** What the folder picker hangs off — the cascade has closed by then. */
  anchorRef?: RefObject<HTMLElement | null>,
  /** Reopens the cascade behind the picker; omitted where there is not one. */
  onBack?: () => void,
): {
  root: CascadePanel;
  disabled: boolean;
  tooltip: string | undefined;
  overlays: JSX.Element;
} {
  const queryClient = useQueryClient();
  const [workspaceFull, setWorkspaceFull] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hostUpdate = useHostUpdate(null);
  const workspaceQ = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => workspaces.get(workspaceId as string),
    enabled: mode === "session" && Boolean(workspaceId),
    staleTime: 10_000,
  });
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const agentList = agentsQ.data ?? [];
  /** Undoes what `beforeCreate` did, held for as long as the create it was
   *  made for is still in flight. */
  const undoRef = useRef<(() => void) | null>(null);
  // A tab that does not exist yet is empty by definition, so a full canvas is
  // no reason to refuse — the strip's own MAX_TABS check is what limits it.
  const workspaceHasRoom =
    tabId === null || !workspaceQ.data
      ? true
      : autoPlace(activeTab(workspaceQ.data.layout).layout.tiles).tile !== null;

  useEffect(() => {
    if (workspaceHasRoom) setWorkspaceFull(false);
  }, [workspaceHasRoom]);

  const createM = useMutation({
    mutationFn: async ({ host, cwd, choice }: { host: Host; cwd: string; choice: Choice }) => {
      // The conversation this agent starts under, chosen here so the window
      // can record it and a restart can resume it; null for a CLI that names
      // its own.
      const conversation =
        choice.kind === "agent" ? newAgentConversationId(choice.agent.kind) : null;
      // Whatever this makes room in is what `activeTab` reads below, so it has
      // to land on the server before anything else is fetched.
      undoRef.current = (await beforeCreate?.()) ?? null;
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
          // The window is a shell that an agent is about to be typed into;
          // recording which one is what makes it that kind of window, so a
          // duplicate of it opens as one too — and which conversation it is
          // starting, so a restart can bring it back to it.
          ...(choice.kind === "agent" && {
            agent_id: choice.agent.id,
            agent_session_id: conversation,
          }),
          workspace_id: workspaceId,
          tile,
        });
        if (choice.kind === "agent")
          pendingLaunch.set(session.id, agentLaunchCommand(choice.agent, conversation));
        return { workspaceId, sessionId: session.id };
      }
      const result = await workspaces.create({
        first_session: {
          host_id: host.id,
          cwd,
          ...(choice.kind === "agent" && {
            agent_id: choice.agent.id,
            agent_session_id: conversation,
          }),
        },
      });
      if (!result.session) throw new Error("The workspace was created without its first session.");
      if (choice.kind === "agent")
        pendingLaunch.set(result.session.id, agentLaunchCommand(choice.agent, conversation));
      return { workspaceId: result.workspace.id, sessionId: result.session.id };
    },
    onSuccess: (result) => {
      undoRef.current = null;
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", result.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onCreated?.(result);
    },
    onError: (error) => {
      undoRef.current?.();
      undoRef.current = null;
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
    hostUpdate.promptHostUpdate(host, () => createM.mutate({ host, cwd, choice }));
  };

  const where = useWherePanel({
    workspaceId: mode === "session" ? workspaceId : null,
    tabId: tabId ?? undefined,
    anchorRef,
    onBack,
  });

  // What goes in the window, then where it runs — the second step always.
  const target = (choice: Choice): Pick<CascadeItem, "panel"> => ({
    panel: where.panel(`where-${choiceKey(choice)}`, (host, cwd) => createAt(host, cwd, choice)),
  });

  const defaultHeading = mode === "workspace" ? "New workspace" : "Add a window";
  const root: CascadePanel = {
    id: "widgets",
    title: hideHeading ? undefined : (heading ?? defaultHeading),
    items: [
      {
        key: "shell",
        icon: <SquareTerminal />,
        label: "Shell",
        detail: "A plain login shell",
        ...target({ kind: "shell" }),
      },
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
      {where.overlays}
      <HostUpdateDialog {...hostUpdate.dialogProps} />
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
    /** Goes on the wrapper the trigger sits in, for a trigger whose own
     *  layout (a flex row's `shrink-0`, say) is set by its parent. */
    className?: string;
    /** Goes on the dropdown itself — its width, mostly, where the default is
     *  too narrow for the labels a surface carries. */
    menuClassName?: string;
  },
): JSX.Element {
  const { trigger, mode, heading, anchor = "trigger", className, menuClassName } = props;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<CascadeMenuHandle>(null);
  // The lozenge row has no single cascade to return to, so only this
  // presentation offers a way back.
  const { root, disabled, tooltip, overlays } = useNewSessionChoices(props, anchorRef, () =>
    menuRef.current?.open(),
  );

  return (
    <span ref={anchorRef} className={cn("relative inline-flex", className)} title={tooltip}>
      <CascadeMenu
        ref={menuRef}
        root={root}
        sheetTitle={heading ?? (mode === "workspace" ? "New workspace" : "Add a window")}
        menuClassName={menuClassName}
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
      {item.trailing}
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
  const anchorRef = useRef<HTMLDivElement>(null);
  const { root, disabled, tooltip, overlays } = useNewSessionChoices(props, anchorRef);
  const picks = root.items;
  return (
    <div
      ref={anchorRef}
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
