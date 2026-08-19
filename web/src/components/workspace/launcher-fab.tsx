"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Plus, SquareTerminal } from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { toast } from "@/components/ui/toast";
import {
  type Agent,
  ApiError,
  agents,
  hosts,
  sessions,
  type Workspace,
  workspaces,
} from "@/lib/api";
import { autoPlace, GRID_SIZE, type Rect } from "@/lib/grid";
import { activeTab, tabById, tabTiles, withActiveTab, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { pendingLaunch } from "./pending-launch";
import { type DockZone, dockSplitRect, dockZoneAt } from "./workspace-grid-helpers";

/** What a launcher item adds: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: Agent } | { kind: "files" };

/** Pointer travel that separates a tap on an item from a drag off it. */
const DRAG_THRESHOLD_PX = 4;

function parseOpening(value: string | null | undefined): Rect | null {
  if (!value) return null;
  const [x, y, w, h] = value.split(",").map(Number);
  return [x, y, w, h].every((part) => Number.isInteger(part)) ? ({ x, y, w, h } as Rect) : null;
}

function choiceLabel(choice: Choice): string {
  if (choice.kind === "shell") return "shell";
  if (choice.kind === "files") return "file explorer";
  return choice.agent.name;
}

/**
 * The floating pane launcher: a + pinned to the bottom-right of the viewport.
 * Hovering (or focusing) it fans out one icon per thing a pane can run —
 * shell, each installed agent, the file explorer. Tapping an icon creates the
 * pane at the workspace's home folder, auto-placed in the open tab; dragging
 * an icon onto the canvas places it exactly where it lands (the grid's
 * openings light up as drop targets).
 */
export function LauncherFab({
  workspace,
  tabId,
  onCreated,
}: {
  workspace: Workspace;
  /** The tab on screen — panes land here, not in the server's idea of it. */
  tabId: string;
  onCreated?: (result: { sessionId: string | null }) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<{ icon: ReactNode; choice: Choice } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dropPreviewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    choice: Choice;
    icon: ReactNode;
    startX: number;
    startY: number;
    started: boolean;
    target: Element | null;
    /** Canvas geometry + where auto-place would land, captured at drag start. */
    canvas: DOMRect | null;
    autoRect: Rect | null;
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: () => void;
  } | null>(null);

  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const homeHost = (hostsQ.data ?? []).find((host) => host.id === workspace.host_id) ?? null;
  const home = homeHost && workspace.cwd ? { host: homeHost, cwd: workspace.cwd } : null;

  const createM = useMutation({
    mutationFn: async ({
      choice,
      placement,
      dock,
    }: {
      choice: Choice;
      placement?: Rect;
      /** Dropped on a pane: split it and take the half on `zone`'s side. */
      dock?: { targetId: string; zone: DockZone };
    }) => {
      if (!home) {
        throw new Error("Set this workspace's folder first (… menu in the tab strip).");
      }
      // Fresh envelope: panes must land in the tab on screen, but the server
      // appends to its own active_tab, which only layout writes move. Stamp
      // it first when the view has drifted from it.
      const current = await workspaces.get(workspace.id);
      let layout = current.layout;
      if (tabById(layout, tabId) && activeTab(layout).id !== tabId) {
        layout = (await workspaces.update(workspace.id, { layout: withActiveTab(layout, tabId) }))
          .layout;
      }
      // A dock resolves to a concrete placement by shrinking the occupant to
      // its half. Sessions need that shrink persisted before the create (the
      // server refuses a tile overlapping the occupant); the files write
      // already carries the whole layout, so it folds the shrink in.
      let placed = placement;
      if (!placed && dock) {
        const tab = tabById(layout, tabId) ?? activeTab(layout);
        const target = tab.layout.tiles.find((tile) => tile.session_id === dock.targetId);
        const split = target ? dockSplitRect(target, dock.zone) : null;
        if (target && split) {
          layout = withTabTiles(
            layout,
            tab.id,
            tab.layout.tiles.map((tile) =>
              tile.session_id === dock.targetId ? { ...tile, ...split.kept } : tile,
            ),
          );
          placed = split.moved;
          if (choice.kind !== "files") {
            layout = (
              await workspaces.update(workspace.id, { layout: withActiveTab(layout, tabId) })
            ).layout;
          }
        }
      }
      if (choice.kind === "files") {
        const tab = tabById(layout, tabId) ?? activeTab(layout);
        const placedTile = placed
          ? { tile: placed, tiles: tab.layout.tiles }
          : autoPlace(tab.layout.tiles);
        if (!placedTile.tile) throw new ApiError(409, "workspace_full", "workspace_full");
        await workspaces.update(workspace.id, {
          layout: withActiveTab(
            withTabTiles(layout, tab.id, [
              ...placedTile.tiles,
              {
                session_id: crypto.randomUUID(),
                ...placedTile.tile,
                widget: { kind: "files" as const, host_id: home.host.id, path: home.cwd },
              },
            ]),
            tab.id,
          ),
        });
        return { sessionId: null };
      }
      const session = await sessions.create({
        host_id: home.host.id,
        cwd: home.cwd,
        workspace_id: workspace.id,
        tile: placed,
      });
      if (choice.kind === "agent") pendingLaunch.set(session.id, choice.agent.command);
      return { sessionId: session.id };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onCreated?.(result);
    },
    onError: (error) => {
      if (isWorkspaceFullError(error)) {
        toast.error("This tab is full. Remove a pane before adding another.");
        queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const disabled = !home || home.host.status !== "online" || createM.isPending;
  const disabledReason = !home
    ? "Set this workspace's folder first (… menu in the tab strip)"
    : home.host.status !== "online"
      ? `${home.host.name} is offline`
      : undefined;

  const clearDropTarget = useCallback((drag: { target: Element | null }) => {
    drag.target?.removeAttribute("data-drop-target");
    drag.target = null;
  }, []);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.removeEventListener("pointermove", drag.move);
    document.removeEventListener("pointerup", drag.up);
    document.removeEventListener("pointercancel", drag.cancel);
    clearDropTarget(drag);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(null);
  }, [clearDropTarget]);

  useEffect(() => endDrag, [endDrag]);

  const startDrag = (choice: Choice, icon: ReactNode, event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (
        !drag.started &&
        Math.abs(moveEvent.clientX - drag.startX) < DRAG_THRESHOLD_PX &&
        Math.abs(moveEvent.clientY - drag.startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      if (!drag.started) {
        drag.started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        // Synchronous: the ghost must exist to be positioned by this event.
        flushSync(() => setDragging({ icon: drag.icon, choice: drag.choice }));
      }
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.left = `${moveEvent.clientX + 14}px`;
        ghost.style.top = `${moveEvent.clientY + 14}px`;
      }
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const openingElement = under?.closest?.("[data-grid-opening]") ?? null;
      const opening = openingElement?.querySelector("button") ?? null;
      if (opening !== drag.target) {
        clearDropTarget(drag);
        opening?.setAttribute("data-drop-target", "true");
        drag.target = opening;
      }
      // Outline exactly where the pane will land: the hovered opening, the
      // half of a hovered pane the cursor would dock against, or the
      // auto-place slot anywhere else on the canvas.
      const preview = dropPreviewRef.current;
      if (preview) {
        let rect = openingElement
          ? parseOpening(openingElement.getAttribute("data-grid-opening"))
          : null;
        if (!rect) {
          const paneElement = under?.closest?.("[data-grid-tile]");
          const targetId = paneElement?.getAttribute("data-grid-tile");
          const target = targetId
            ? tabTiles(workspace.layout, tabId).find((tile) => tile.session_id === targetId)
            : undefined;
          if (paneElement && target) {
            const box = paneElement.getBoundingClientRect();
            const zone = dockZoneAt(
              (moveEvent.clientX - box.left) / box.width,
              (moveEvent.clientY - box.top) / box.height,
            );
            rect = dockSplitRect(target, zone)?.moved ?? drag.autoRect;
          } else {
            rect = drag.autoRect;
          }
        }
        const overCanvas = Boolean(under?.closest?.("[data-workspace-canvas]"));
        if (drag.canvas && rect && overCanvas) {
          preview.hidden = false;
          preview.style.left = `${drag.canvas.left + (rect.x / GRID_SIZE) * drag.canvas.width}px`;
          preview.style.top = `${drag.canvas.top + (rect.y / GRID_SIZE) * drag.canvas.height}px`;
          preview.style.width = `${(rect.w / GRID_SIZE) * drag.canvas.width}px`;
          preview.style.height = `${(rect.h / GRID_SIZE) * drag.canvas.height}px`;
        } else {
          preview.hidden = true;
        }
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      const drag = dragRef.current;
      endDrag();
      if (!drag) return;
      if (!drag.started) {
        // A tap: create at home, auto-placed in the open tab.
        createM.mutate({ choice: drag.choice });
        return;
      }
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const opening = parseOpening(
        under?.closest?.("[data-grid-opening]")?.getAttribute("data-grid-opening"),
      );
      if (opening) {
        createM.mutate({ choice: drag.choice, placement: opening });
        return;
      }
      const paneElement = under?.closest?.("[data-grid-tile]");
      const targetId = paneElement?.getAttribute("data-grid-tile");
      if (paneElement && targetId) {
        // Dropped on a pane: dock against the cursor's nearest edge, exactly
        // as the preview outlined.
        const box = paneElement.getBoundingClientRect();
        const zone = dockZoneAt(
          (upEvent.clientX - box.left) / box.width,
          (upEvent.clientY - box.top) / box.height,
        );
        createM.mutate({ choice: drag.choice, dock: { targetId, zone } });
        return;
      }
      // Anywhere else on the canvas still adds the pane; off it, the drag
      // was a change of mind.
      if (under?.closest?.("[data-workspace-canvas]")) createM.mutate({ choice: drag.choice });
    };
    const onCancel = () => endDrag();
    dragRef.current = {
      choice,
      icon,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      target: null,
      canvas: document.querySelector("[data-workspace-canvas]")?.getBoundingClientRect() ?? null,
      autoRect: autoPlace(tabTiles(workspace.layout, tabId)).tile,
      move: onMove,
      up: onUp,
      cancel: onCancel,
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onCancel, { once: true });
  };

  const items: Array<{ key: string; label: string; icon: ReactNode; choice: Choice }> = [
    {
      key: "shell",
      label: "New shell pane",
      icon: <SquareTerminal className="size-5.5" aria-hidden />,
      choice: { kind: "shell" },
    },
    ...(agentsQ.data ?? []).map((agent) => ({
      key: agent.id,
      label: `New ${agent.name} pane`,
      icon: <AgentIcon kind={agent.kind} size={22} className="rounded" aria-hidden />,
      choice: { kind: "agent" as const, agent },
    })),
    {
      key: "files",
      label: "New file explorer pane",
      icon: <FolderTree className="size-5.5" aria-hidden />,
      choice: { kind: "files" },
    },
  ];

  return (
    <>
      <div
        data-launcher-fab
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
        // One pill that grows from a circle: the items sit inside it and are
        // revealed by the container's own width, not a separate tray.
        className={cn(
          "fixed right-4 z-40 flex items-center rounded-2xl border border-border bg-popover shadow-lg",
          "bottom-[calc(1rem+var(--safe-bottom))]",
          // Clear of the touch modifier bar on phones.
          "[@media(pointer:coarse)]:bottom-[calc(4.5rem+var(--safe-bottom))]",
        )}
      >
        <div
          role="toolbar"
          aria-label="New pane launcher"
          aria-hidden={!open}
          className={cn(
            "flex items-center gap-0.5 overflow-hidden transition-[max-width,padding] duration-200 ease-swift",
            // Enough of an inset that the first icon's plate clears the
            // container's rounded corner.
            open ? "max-w-96 pl-3" : "max-w-0 pl-0",
          )}
        >
          {[...items].reverse().map((item, index, list) => (
            <button
              key={item.key}
              type="button"
              aria-label={item.label}
              title={
                disabledReason ?? `${item.label} — click to add, drag onto the canvas to place`
              }
              disabled={disabled}
              tabIndex={open ? 0 : -1}
              // Fan out from the trigger: the icon nearest it leads, the rest
              // follow a frame behind each.
              style={{ transitionDelay: `${(open ? list.length - 1 - index : index) * 35}ms` }}
              onPointerDown={(event) => startDrag(item.choice, item.icon, event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!disabled) createM.mutate({ choice: item.choice });
                }
              }}
              className={cn(
                "grid size-11 shrink-0 cursor-grab touch-none place-items-center rounded-xl text-muted-foreground",
                "transition-all duration-200 ease-swift",
                open
                  ? "translate-x-0 scale-100 opacity-100"
                  : "pointer-events-none translate-x-4 scale-75 opacity-0",
                "hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50",
              )}
            >
              {item.icon}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Add a pane"
          aria-expanded={open}
          title={disabledReason ?? "Add a pane"}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            // The one primary action on the canvas: a filled square button,
            // easing into its hover tint rather than snapping to it.
            "grid size-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground",
            "transition-all duration-200 ease-swift hover:opacity-90",
            "hover:scale-105 active:scale-95",
            open && "rotate-45",
          )}
        >
          <Plus className="size-5" aria-hidden />
        </button>
      </div>
      {dragging && (
        <div
          ref={dropPreviewRef}
          hidden
          aria-hidden
          className="pointer-events-none fixed z-[105] border-2 border-dashed border-ring bg-ring/10"
        />
      )}
      {dragging && (
        <div
          ref={ghostRef}
          aria-hidden
          className="pointer-events-none fixed z-[110] flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-lg"
        >
          {dragging.icon}
          {choiceLabel(dragging.choice)}
        </div>
      )}
    </>
  );
}
