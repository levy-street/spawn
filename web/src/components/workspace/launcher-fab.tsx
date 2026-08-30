"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Plus, SquareTerminal, Trash2 } from "lucide-react";
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
import {
  HostUpdateBadge,
  HostUpdateDialog,
  useHostUpdate,
} from "@/components/release/HostUpdateDialog";
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
import { autoPlace, GRID_SIZE, type Rect, type Tile } from "@/lib/grid";
import { activeTab, tabById, tabHome, tabTiles, withActiveTab, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { agentRunCommand } from "./agent-command";
import { isWorkspaceFullError } from "./new-session-menu-helpers";
import { queryAllInPane, queryInPane, usePaneScope } from "./pane-scope";
import { pendingLaunch } from "./pending-launch";
import {
  addPaneTiles,
  type DockZone,
  dockInsert,
  dockZoneAt,
  PENDING_TILE_ID,
} from "./workspace-grid-helpers";

/** What a launcher item adds: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: Agent } | { kind: "files" };

/** Where a dropped pane lands: a free opening, one half of a pane it was
 *  aimed at, or an even share of the band. */
type Drop =
  | { kind: "opening"; rect: Rect }
  | { kind: "dock"; targetId: string; zone: DockZone }
  | { kind: "auto" };

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
 * The pane launcher: a + sunk into the bottom-right corner of the viewport.
 * Hovering (or focusing) it fans out one icon per thing a pane can run —
 * shell, each installed agent, the file explorer. Tapping an icon creates the
 * pane at the workspace's home folder, auto-placed in the open tab; dragging
 * an icon onto the canvas places it exactly where it lands (the grid's
 * openings light up as drop targets).
 */
export function LauncherFab({
  workspace,
  tabId,
  paneDragging,
  onPreviewTiles,
  onCreated,
}: {
  workspace: Workspace;
  /** The tab on screen — panes land here, not in the server's idea of it. */
  tabId: string;
  /** A pane is being carried on the canvas. This is the bin for that drag too,
   *  so it wears the same face and keeps its drawer shut. */
  paneDragging?: boolean;
  /** The layout the canvas should show while a pane is dragged off here, null
   *  once the drag ends. The grid renders it; the tab strip reads it too. */
  onPreviewTiles?: (tiles: Tile[] | null) => void;
  onCreated?: (result: { sessionId: string | null }) => void;
}) {
  const queryClient = useQueryClient();
  // This half of the window: in a split there are two launchers on screen, and
  // the canvas and openings this one measures have to be its own.
  const { rootRef: paneRootRef, split } = usePaneScope();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<{ icon: ReactNode; choice: Choice } | null>(null);
  const fabRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dropPreviewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    choice: Choice;
    icon: ReactNode;
    startX: number;
    startY: number;
    started: boolean;
    target: Element | null;
    /**
     * The canvas as it rests: the element, its box, its openings, and where
     * auto-place would land. All read once, at drag start, and never again —
     * the panes on it are showing this drag's own preview, so measuring them
     * mid-drag would have each frame answer the last one. The element is kept
     * so the pointer can be asked whether it is over *this* half's canvas
     * rather than over any canvas.
     */
    canvasElement: Element | null;
    canvas: DOMRect | null;
    openings: Array<{ rect: Rect; button: Element | null }>;
    autoRect: Rect | null;
    /** What the outline is promising, and the pointer target it came from —
     *  the placement is only re-derived when that target changes. */
    placement: string | null;
    drop: Drop | null;
    move: (event: PointerEvent) => void;
    up: () => void;
    cancel: () => void;
    key: (event: KeyboardEvent) => void;
  } | null>(null);

  // Anything in flight, from here or from the canvas: this is a bin for the
  // length of it. Fanning out "add a pane" under the cursor at the same time
  // would be offering the opposite of what the drop does.
  const bin = dragging !== null || paneDragging === true;
  const showItems = open && !bin;

  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  // Where a window launched here opens: the tab's own home when it has one,
  // else the workspace's — and only when that host is still around.
  const target = tabHome(workspace.layout, tabId, workspace);
  const homeHost = (hostsQ.data ?? []).find((host) => host.id === target?.host_id) ?? null;
  const home = homeHost && target ? { host: homeHost, cwd: target.cwd } : null;
  const hostUpdate = useHostUpdate(home?.host ?? null);

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
      // A dock resolves to a concrete placement by reshaping the occupants
      // around the newcomer — evenly across a band of columns or rows, else by
      // halving the target. Sessions need that reshape persisted before the
      // create (the server refuses a tile overlapping an occupant); the files
      // write already carries the whole layout, so it folds the reshape in.
      let placed = placement;
      if (!placed && dock) {
        const tab = tabById(layout, tabId) ?? activeTab(layout);
        const docked = dockInsert(tab.layout.tiles, PENDING_TILE_ID, dock.targetId, dock.zone);
        const landed = docked?.find((tile) => tile.session_id === PENDING_TILE_ID);
        if (docked && landed) {
          layout = withTabTiles(
            layout,
            tab.id,
            docked.filter((tile) => tile.session_id !== PENDING_TILE_ID),
          );
          placed = { x: landed.x, y: landed.y, w: landed.w, h: landed.h };
          if (choice.kind !== "files") {
            layout = (
              await workspaces.update(workspace.id, { layout: withActiveTab(layout, tabId) })
            ).layout;
          }
        }
      }
      if (choice.kind === "files") {
        const tab = tabById(layout, tabId) ?? activeTab(layout);
        const id = crypto.randomUUID();
        const placedTiles = placed
          ? [...tab.layout.tiles, { session_id: id, ...placed }]
          : addPaneTiles(tab.layout.tiles, id);
        if (!placedTiles) throw new ApiError(409, "workspace_full", "workspace_full");
        await workspaces.update(workspace.id, {
          layout: withActiveTab(
            withTabTiles(
              layout,
              tab.id,
              placedTiles.map((tile) =>
                tile.session_id === id
                  ? {
                      ...tile,
                      widget: { kind: "files" as const, host_id: home.host.id, path: home.cwd },
                    }
                  : tile,
              ),
            ),
            tab.id,
          ),
        });
        return { sessionId: null };
      }
      // A tap, or a drop on bare canvas: nothing was aimed at, so the pane
      // joins an even band instead of halving the biggest occupant. The
      // reshaped siblings have to land before the create — the server refuses
      // a tile that overlaps what it still thinks is there.
      if (!placed) {
        const tab = tabById(layout, tabId) ?? activeTab(layout);
        const added = addPaneTiles(tab.layout.tiles, PENDING_TILE_ID);
        if (!added) throw new ApiError(409, "workspace_full", "workspace_full");
        const landed = added.find((tile) => tile.session_id === PENDING_TILE_ID);
        if (landed) {
          placed = { x: landed.x, y: landed.y, w: landed.w, h: landed.h };
          layout = (
            await workspaces.update(workspace.id, {
              layout: withActiveTab(
                withTabTiles(
                  layout,
                  tab.id,
                  added.filter((tile) => tile.session_id !== PENDING_TILE_ID),
                ),
                tabId,
              ),
            })
          ).layout;
        }
      }
      const session = await sessions.create({
        host_id: home.host.id,
        cwd: home.cwd,
        workspace_id: workspace.id,
        tile: placed,
      });
      if (choice.kind === "agent") pendingLaunch.set(session.id, agentRunCommand(choice.agent));
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
        toast.error("This tab is full. Remove a window before adding another.");
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

  const launch = (input: {
    choice: Choice;
    placement?: Rect;
    dock?: { targetId: string; zone: DockZone };
  }) => {
    if (!home) return;
    hostUpdate.promptHostUpdate(home.host, () => createM.mutate(input));
  };

  const layoutRef = useRef(workspace.layout);
  layoutRef.current = workspace.layout;
  // Read through a ref: an inline callback prop must not change the identities
  // the live drag closed over.
  const onPreviewTilesRef = useRef(onPreviewTiles);
  onPreviewTilesRef.current = onPreviewTiles;

  const clearDropTarget = useCallback((drag: { target: Element | null }) => {
    drag.target?.removeAttribute("data-drop-target");
    drag.target = null;
  }, []);

  /**
   * Show the panes the shape they will take once this pane lands, so the
   * outline never sits on top of a pane that has not moved out of its way.
   * Handed to the grid rather than written onto its tiles: the grid renders
   * every pane's geometry itself, and a second writer only holds until it
   * re-renders.
   */
  const previewPanes = useCallback(
    (tiles: Tile[] | null) => onPreviewTilesRef.current?.(tiles),
    [],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.removeEventListener("pointermove", drag.move);
    document.removeEventListener("pointerup", drag.up);
    document.removeEventListener("pointercancel", drag.cancel);
    document.removeEventListener("keydown", drag.key);
    clearDropTarget(drag);
    previewPanes(null);
    fabRef.current?.removeAttribute("data-trash-hover");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(null);
  }, [clearDropTarget, previewPanes]);

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
      fabRef.current?.toggleAttribute(
        "data-trash-hover",
        Boolean(under?.closest?.("[data-launcher-fab]")),
      );
      const preview = dropPreviewRef.current;
      const canvas = drag.canvas;
      const canvasElement = drag.canvasElement;
      if (!preview || !canvas || !canvasElement) return;

      // What the pointer is aimed at, resolved in cell space against the
      // resting layout rather than by hit-testing the panes: they are already
      // showing this drag's preview, so a pane that slid aside would stop
      // being the thing under the cursor and the placement would oscillate.
      // Only the canvas and the launcher are read from the DOM — neither moves.
      const cellWidth = canvas.width / GRID_SIZE;
      const cellHeight = canvas.height / GRID_SIZE;
      const pointerX = (moveEvent.clientX - canvas.left) / cellWidth;
      const pointerY = (moveEvent.clientY - canvas.top) / cellHeight;
      const covers = (rect: Rect) =>
        pointerX >= rect.x &&
        pointerX < rect.x + rect.w &&
        pointerY >= rect.y &&
        pointerY < rect.y + rect.h;

      const resting = tabTiles(layoutRef.current, tabId);
      // This half's canvas specifically. Carrying an item over the other
      // workspace's grid promises nothing and drops nothing: panes belong to
      // the workspace whose launcher they came from.
      const overCanvas = under?.closest?.("[data-workspace-canvas]") === canvasElement;
      const opening = overCanvas ? (drag.openings.find((slot) => covers(slot.rect)) ?? null) : null;
      const hovered = overCanvas && !opening ? (resting.find(covers) ?? null) : null;
      const zone = hovered
        ? dockZoneAt((pointerX - hovered.x) / hovered.w, (pointerY - hovered.y) / hovered.h)
        : null;
      const placement = !overCanvas
        ? "off"
        : opening
          ? `opening:${opening.rect.x},${opening.rect.y},${opening.rect.w},${opening.rect.h}`
          : hovered
            ? `dock:${hovered.session_id}:${zone}`
            : "auto";
      if (placement === drag.placement) return;
      drag.placement = placement;

      const button = opening?.button ?? null;
      if (button !== drag.target) {
        clearDropTarget(drag);
        button?.setAttribute("data-drop-target", "true");
        drag.target = button;
      }
      if (!overCanvas) {
        drag.drop = null;
        preview.hidden = true;
        previewPanes(null);
        return;
      }
      // Outline exactly where the pane will land, and remember it: the drop
      // replays this rather than deriving its own.
      //
      // The whole previewed layout, not just the newcomer's rect: the panes
      // have to move out of its way on screen, or the outline lands on top
      // of one that never budged.
      let placed: Tile[] | null = null;
      if (opening) {
        placed = [...resting, { session_id: PENDING_TILE_ID, ...opening.rect }];
        drag.drop = { kind: "opening", rect: opening.rect };
      } else {
        if (hovered && zone) {
          placed = dockInsert(resting, PENDING_TILE_ID, hovered.session_id, zone);
          if (placed) drag.drop = { kind: "dock", targetId: hovered.session_id, zone };
        }
        // Nothing aimed at, or an occupant too small to halve: the pane
        // joins the band evenly, which is what the drop itself will do.
        if (!placed) {
          placed = addPaneTiles(resting, PENDING_TILE_ID);
          drag.drop = { kind: "auto" };
        }
      }
      const rect = placed?.find((tile) => tile.session_id === PENDING_TILE_ID) ?? drag.autoRect;
      if (!rect) {
        preview.hidden = true;
        previewPanes(null);
        return;
      }
      preview.hidden = false;
      preview.style.left = `${canvas.left + (rect.x / GRID_SIZE) * canvas.width}px`;
      preview.style.top = `${canvas.top + (rect.y / GRID_SIZE) * canvas.height}px`;
      preview.style.width = `${(rect.w / GRID_SIZE) * canvas.width}px`;
      preview.style.height = `${(rect.h / GRID_SIZE) * canvas.height}px`;
      previewPanes(placed);
    };
    const onUp = () => {
      const drag = dragRef.current;
      endDrag();
      if (!drag) return;
      if (!drag.started) {
        // A tap: create at home, auto-placed in the open tab.
        launch({ choice: drag.choice });
        return;
      }
      // Whatever the outline last promised — deriving it again from the
      // pointer would read a canvas this drag has already reshaped, and land
      // the pane somewhere it was never shown. Nothing promised means the
      // pointer left the canvas: a change of mind.
      const drop = drag.drop;
      if (!drop) return;
      if (drop.kind === "opening") {
        launch({ choice: drag.choice, placement: drop.rect });
      } else if (drop.kind === "dock") {
        launch({
          choice: drag.choice,
          dock: { targetId: drop.targetId, zone: drop.zone },
        });
      } else {
        launch({ choice: drag.choice });
      }
    };
    const onCancel = () => endDrag();
    /** Escape abandons the drag, the same as dropping it off the canvas. */
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      endDrag();
    };
    // Read out of this half rather than the document: with two workspaces up
    // the document's first canvas and every opening in it belong to whichever
    // half is on the left, and a pane dropped here would land at coordinates
    // measured off the other grid.
    const paneRoot = paneRootRef.current;
    const canvasElement = queryInPane(paneRoot, "[data-workspace-canvas]");
    dragRef.current = {
      choice,
      icon,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      target: null,
      canvasElement,
      canvas: canvasElement?.getBoundingClientRect() ?? null,
      openings: queryAllInPane(paneRoot, "[data-grid-opening]").flatMap((element) => {
        const rect = parseOpening(element.getAttribute("data-grid-opening"));
        return rect ? [{ rect, button: element.querySelector("button") }] : [];
      }),
      autoRect: autoPlace(tabTiles(workspace.layout, tabId)).tile,
      placement: null,
      drop: null,
      move: onMove,
      up: onUp,
      cancel: onCancel,
      key: onKey,
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onCancel, { once: true });
    document.addEventListener("keydown", onKey);
  };

  const items: Array<{ key: string; label: string; icon: ReactNode; choice: Choice }> = [
    {
      key: "shell",
      label: "New shell window",
      icon: <SquareTerminal className="size-4.5" aria-hidden />,
      choice: { kind: "shell" },
    },
    ...(agentsQ.data ?? []).map((agent) => ({
      key: agent.id,
      label: `New ${agent.name} window`,
      icon: <AgentIcon kind={agent.kind} size={18} className="rounded" aria-hidden />,
      choice: { kind: "agent" as const, agent },
    })),
    {
      key: "files",
      label: "New file explorer window",
      icon: <FolderTree className="size-4.5" aria-hidden />,
      choice: { kind: "files" },
    },
  ];

  return (
    <>
      <div
        ref={fabRef}
        data-launcher-fab
        // Not while dragging: the drawer would fan out under the cursor at
        // the exact moment the button means "drop here to discard".
        onPointerEnter={() => {
          if (!bin) setOpen(true);
        }}
        onPointerLeave={() => setOpen(false)}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
        // One pill that grows from a circle: the items sit inside it and are
        // revealed by the container's own width, not a separate tray.
        className={cn(
          // Pinned into the corner rather than floating over it: it meets both
          // edges, so only the corner it turns towards the canvas is rounded
          // and only the two sides facing the canvas carry a border.
          "group/fab right-0 z-40 flex items-center rounded-tl-2xl border-l border-t border-border bg-popover shadow-lg",
          // Split, the button hangs off its own half — two viewport-fixed
          // launchers would sit on the same pixel, one hiding the other. A
          // single workspace stays fixed rather than being pinned to a half
          // that fills the window anyway: fixed is measured off the viewport,
          // so it keeps clearing the safe area and the modifier bar however
          // the content panel is inset or clipped.
          split ? "absolute" : "fixed",
          "bottom-[var(--safe-bottom)]",
          // Sat on the touch modifier bar on phones, flush against its top.
          "[@media(pointer:coarse)]:bottom-[calc(3.5rem+var(--safe-bottom))]",
        )}
      >
        {home && (
          <HostUpdateBadge
            host={home.host}
            className="absolute -top-7 right-0 shadow-sm shadow-black/10"
          />
        )}
        <div
          role="toolbar"
          aria-label="New window launcher"
          aria-hidden={!showItems}
          className={cn(
            "flex items-center gap-0.5 overflow-hidden transition-[max-width,padding] duration-200 ease-swift",
            // Enough of an inset that the first icon's plate clears the
            // container's rounded corner.
            // The 44px item buttons carry ~11px of their own slack around the
            // icon, so the wrapper adds none and pulls the first plate in.
            showItems ? "max-w-96 pl-0.5 pr-2" : "max-w-0 pl-0",
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
              tabIndex={showItems ? 0 : -1}
              // Fan out from the trigger: the icon nearest it leads, the rest
              // follow a frame behind each.
              style={{
                transitionDelay: `${(showItems ? list.length - 1 - index : index) * 35}ms`,
              }}
              onPointerDown={(event) => startDrag(item.choice, item.icon, event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!disabled) launch({ choice: item.choice });
                }
              }}
              className={cn(
                "grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-xl text-muted-foreground",
                "transition-all duration-200 ease-swift",
                showItems
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
          aria-label={bin ? "Discard what you are dragging" : "Add a window"}
          aria-expanded={showItems}
          title={bin ? "Drop here to discard" : (disabledReason ?? "Add a window")}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            // The one primary action on the canvas: a filled square button,
            // easing into its hover tint rather than snapping to it. Nothing
            // here scales: pinned flush, a plate that grew on hover would push
            // itself off both edges.
            "grid shrink-0 place-items-center",
            "transition-all duration-200 ease-swift",
            bin
              ? // Anything in flight, it is the bin: drop here to discard. It
                // swells past the + it replaces so the drop target reads as
                // the biggest thing on the canvas, and swells again once the
                // drag is actually over it — the plate only, the glyph inside
                // holds its size. Real width/height, not a scale: the jiggle
                // owns `transform`, and an animation's transform beats the
                // utility's, so a scale-* here would never render.
                "size-12 bin-jiggle bg-destructive/15 text-destructive group-data-[trash-hover]/fab:size-14 group-data-[trash-hover]/fab:bg-destructive/30"
              : "size-10 bg-primary text-primary-foreground hover:opacity-90 active:opacity-80",
            // Shut, the plate is the whole pill and wears its one rounded
            // corner; open, that corner belongs to the drawer's far end and
            // the plate squares off into the middle of the pill.
            !showItems && "rounded-tl-2xl",
          )}
        >
          {/* The plate grows, the glyph does not: the icon holds the same
              size the + had, so what reads as changing is the target. The
              turn to a × is the glyph's alone — turning the plate would spin
              its one rounded corner away from the canvas. */}
          {bin ? (
            <Trash2 className="size-4.5" aria-hidden />
          ) : (
            <Plus
              className={cn(
                "size-4.5 transition-transform duration-200 ease-swift",
                showItems && "rotate-45",
              )}
              aria-hidden
            />
          )}
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
      <HostUpdateDialog {...hostUpdate.dialogProps} />
    </>
  );
}
