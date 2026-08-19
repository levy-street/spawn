"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { type Session, type Workspace, workspaces } from "@/lib/api";
import {
  autoPlace,
  GRID_SIZE,
  MAX_TILES,
  MIN_TILE_SIZE,
  readingOrder,
  remove as removeTile,
  type Tile,
} from "@/lib/grid";
import { sessionTitle } from "@/lib/sessions";
import { type LayoutV3, moveSessionToTab, tabTiles, withActiveTab, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { NewSessionMenu } from "./new-session-menu";
import { type PaneSlotTarget, SessionPane } from "./session-pane";
import { WidgetPane, widgetTitle } from "./widget-pane";
import {
  clampDividerLine,
  dockPane,
  dockZoneAt,
  type EdgeTargets,
  freeRects,
  type GridDivider,
  gridDividers,
  moveDivider,
  moveIdInOrder,
  movePane,
  type ResizeEdges,
  repackMobileTiles,
  resizeEdges,
  tilePixelRect,
} from "./workspace-grid-helpers";

const WIDE_CONTAINER_PX = 768;
/** How long a dragged pane must hover a tab before the view switches to it. */
const TAB_DWELL_MS = 250;
/** Pointer travel that separates a click on the title bar from a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Grab width of a seam, and how far it stops short of a pane corner. */
const DIVIDER_HIT_PX = 8;
const DIVIDER_INSET_PX = 8;

type SlotRegistry = Record<string, PaneSlotTarget>;
type HandleGetter = () => TerminalHandle | null;

type MoveGesture = {
  kind: "move";
  sessionId: string;
  startClientX: number;
  startClientY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  lastX: number;
  lastY: number;
  /** Live pointer position — cross-tab re-seeding restarts the drag here. */
  lastClientX: number;
  lastClientY: number;
  /** Set once the drag has left its starting tab: where the tile came from. */
  sourceTab: { tabId: string; tiles: Tile[] } | null;
  /** `${targetId}:${zone}` while hovering another pane (dock mode). */
  lastDock: string | null;
  before: Tile[];
  preview: Tile[];
  areaRect: DOMRect;
};

type ResizeGesture = {
  kind: "resize";
  sessionId: string;
  /** Which edge(s) the drag grabbed; corners grab one per axis. */
  edges: ResizeEdges;
  startClientX: number;
  startClientY: number;
  /** Serialized last edge targets, so previews recompute only on cell change. */
  lastKey: string;
  before: Tile[];
  preview: Tile[];
  areaRect: DOMRect;
};

type DividerGesture = {
  kind: "divider";
  divider: GridDivider;
  startClientX: number;
  startClientY: number;
  lastLine: number;
  before: Tile[];
  preview: Tile[];
  areaRect: DOMRect;
};

type GridGesture = MoveGesture | ResizeGesture | DividerGesture;

/** A pointerdown on a title bar, waiting to see whether it becomes a drag. */
type ArmedMove = {
  sessionId: string;
  clientX: number;
  clientY: number;
  move: (event: PointerEvent) => void;
  end: () => void;
};

function tilesEqual(a: Tile[], b: Tile[]): boolean {
  return (
    a.length === b.length &&
    a.every((tile, index) => {
      const other = b[index];
      return (
        tile.session_id === other?.session_id &&
        tile.x === other.x &&
        tile.y === other.y &&
        tile.w === other.w &&
        tile.h === other.h
      );
    })
  );
}

function tileStyle(tile: Tile, zoomed: boolean): CSSProperties {
  const values = zoomed
    ? { left: "0%", top: "0%", width: "100%", height: "100%" }
    : {
        left: `${(tile.x / GRID_SIZE) * 100}%`,
        top: `${(tile.y / GRID_SIZE) * 100}%`,
        width: `${(tile.w / GRID_SIZE) * 100}%`,
        height: `${(tile.h / GRID_SIZE) * 100}%`,
      };
  return {
    "--tile-left": values.left,
    "--tile-top": values.top,
    "--tile-width": values.width,
    "--tile-height": values.height,
    left: "var(--tile-left)",
    top: "var(--tile-top)",
    width: "var(--preview-width, var(--tile-width))",
    height: "var(--preview-height, var(--tile-height))",
  } as CSSProperties;
}

/**
 * The eight grab surfaces of a pane: four edge strips and four corners.
 * Rendered by the grid on the tile wrapper (above the pane's content, below
 * the seam dividers), so session panes and widgets resize identically from
 * any side. Edges facing a flush neighbour behave like a splitter — the
 * neighbour gives up or takes back the space (see `resizeEdges`).
 */
const RESIZE_PARTS: Array<{ part: string; edges: ResizeEdges; className: string }> = [
  {
    part: "left edge",
    edges: { h: -1, v: 0 },
    className: "left-0 inset-y-3 w-1.5 cursor-ew-resize",
  },
  {
    part: "right edge",
    edges: { h: 1, v: 0 },
    className: "right-0 inset-y-3 w-1.5 cursor-ew-resize",
  },
  { part: "top edge", edges: { h: 0, v: -1 }, className: "top-0 inset-x-3 h-1.5 cursor-ns-resize" },
  {
    part: "bottom edge",
    edges: { h: 0, v: 1 },
    className: "bottom-0 inset-x-3 h-1.5 cursor-ns-resize",
  },
  {
    part: "top-left corner",
    edges: { h: -1, v: -1 },
    className: "left-0 top-0 size-3 cursor-nwse-resize",
  },
  {
    part: "top-right corner",
    edges: { h: 1, v: -1 },
    className: "right-0 top-0 size-3 cursor-nesw-resize",
  },
  {
    part: "bottom-left corner",
    edges: { h: -1, v: 1 },
    className: "left-0 bottom-0 size-3 cursor-nesw-resize",
  },
  {
    part: "bottom-right corner",
    edges: { h: 1, v: 1 },
    className: "right-0 bottom-0 size-3 cursor-nwse-resize",
  },
];

function TileResizeHandles({
  sessionId,
  title,
  onStart,
}: {
  sessionId: string;
  title: string;
  onStart: (sessionId: string, edges: ResizeEdges, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <>
      {RESIZE_PARTS.map(({ part, edges, className }) => (
        <button
          key={part}
          type="button"
          aria-label={`Resize ${title} (${part})`}
          onPointerDown={(event) => onStart(sessionId, edges, event)}
          className={cn("absolute z-30 touch-none", className)}
        />
      ))}
    </>
  );
}

function PaneSlot({
  sessionId,
  stacked,
  register,
}: {
  sessionId: string;
  stacked: boolean;
  register: (sessionId: string, element: HTMLElement | null, stacked: boolean) => void;
}) {
  const setRef = useCallback(
    (element: HTMLDivElement | null) => register(sessionId, element, stacked),
    [register, sessionId, stacked],
  );
  return <div ref={setRef} className="flex size-full min-h-0 min-w-0" />;
}

export function WorkspaceGrid({
  workspace,
  tabId,
  sessions,
  initialFocusId,
  onFocusChange,
  onSwitchTab,
  onPreviewTiles,
  onError,
}: {
  workspace: Workspace;
  /** The tab whose grid this renders; the envelope's other tabs pass through
   *  every save untouched. */
  tabId: string;
  sessions: Session[];
  initialFocusId?: string | null;
  onFocusChange?: (sessionId: string | null) => void;
  /** Fired when a dragged pane dwells over another tab in the strip. */
  onSwitchTab?: (tabId: string) => void;
  /** Live gesture previews (move/resize/seam), null when no gesture is on.
   *  The tab strip uses this to restyle the selected tab mid-drag. */
  onPreviewTiles?: (tiles: Tile[] | null) => void;
  onError?: (message: string | null) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const areaRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const tileElementsRef = useRef(new Map<string, HTMLDivElement>());
  const handleGettersRef = useRef(new Map<string, HandleGetter>());
  const gestureRef = useRef<GridGesture | null>(null);
  const armedMoveRef = useRef<ArmedMove | null>(null);
  const dividerElementRef = useRef<HTMLElement | null>(null);
  const gestureListenersRef = useRef<{
    move: ((event: PointerEvent) => void) | null;
    up: ((event: PointerEvent) => void) | null;
    cancel: (() => void) | null;
  }>({ move: null, up: null, cancel: null });
  const [tiles, setTiles] = useState<Tile[]>(() => tabTiles(workspace.layout, tabId));
  const [slots, setSlots] = useState<SlotRegistry>({});
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches,
  );
  const [finePointer, setFinePointer] = useState(
    () => typeof window === "undefined" || window.matchMedia("(pointer: fine)").matches,
  );
  const [focusedId, setFocusedId] = useState<string | null>(() => {
    const initialTiles = tabTiles(workspace.layout, tabId);
    return initialFocusId && initialTiles.some((tile) => tile.session_id === initialFocusId)
      ? initialFocusId
      : (readingOrder(initialTiles)[0] ?? null);
  });
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  const latestTilesRef = useRef(tiles);
  const onSwitchTabRef = useRef(onSwitchTab);
  onSwitchTabRef.current = onSwitchTab;
  // Read through a ref everywhere below: an inline onError prop must not
  // change gesture-callback identities (that tore down live drag listeners).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPreviewTilesRef = useRef(onPreviewTiles);
  onPreviewTilesRef.current = onPreviewTiles;
  /** The whole envelope with every local edit applied — what saves PATCH.
   *  Commits fold the active tab's tiles (and any cross-tab removal) in. */
  const latestLayoutRef = useRef<LayoutV3>(workspace.layout);
  const tabIdRef = useRef(tabId);
  const hoveredTabRef = useRef<{ id: string; since: number } | null>(null);
  const revisionRef = useRef(0);
  const persistedRevisionRef = useRef(0);
  const persistenceEpochRef = useRef(0);
  const saveChainRef = useRef(Promise.resolve());
  const serverWorkspaceRef = useRef(workspace);
  const appliedFocusRef = useRef<string | null>(null);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const orderedIds = useMemo(() => readingOrder(tiles), [tiles]);
  const dividers = useMemo(() => gridDividers(tiles), [tiles]);
  const openings = useMemo(() => (tiles.length >= MAX_TILES ? [] : freeRects(tiles)), [tiles]);
  const sessionTileIds = useMemo(() => readingOrder(tiles.filter((tile) => !tile.widget)), [tiles]);
  const allWorkspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (saving || workspace.updated_at === serverWorkspaceRef.current.updated_at) return;
    serverWorkspaceRef.current = workspace;
    latestLayoutRef.current = workspace.layout;
    latestTilesRef.current = tabTiles(workspace.layout, tabIdRef.current);
    setTiles(latestTilesRef.current);
  }, [saving, workspace]);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= WIDE_CONTAINER_PX);
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (wide) return;
    setZoomedId(null);
  }, [wide]);

  const setFocus = useCallback(
    (sessionId: string | null, focusTerminal = false) => {
      setFocusedId(sessionId);
      onFocusChange?.(sessionId);
      if (focusTerminal && sessionId) {
        requestAnimationFrame(() => handleGettersRef.current.get(sessionId)?.()?.focus());
      }
    },
    [onFocusChange],
  );

  useEffect(() => {
    if (
      !initialFocusId ||
      appliedFocusRef.current === initialFocusId ||
      !orderedIds.includes(initialFocusId)
    ) {
      return;
    }
    appliedFocusRef.current = initialFocusId;
    setFocus(initialFocusId, true);
  }, [initialFocusId, orderedIds, setFocus]);

  useEffect(() => {
    if (orderedIds.length === 0) {
      if (focusedId !== null) setFocus(null);
      return;
    }
    if (!focusedId || !orderedIds.includes(focusedId)) setFocus(orderedIds[0] ?? null);
  }, [focusedId, orderedIds, setFocus]);

  useEffect(() => {
    if (zoomedId && !orderedIds.includes(zoomedId)) setZoomedId(null);
  }, [orderedIds, zoomedId]);

  const writeWorkspaceCaches = useCallback(
    (next: Workspace) => {
      queryClient.setQueryData(["workspace", workspace.id], next);
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
        current?.map((item) => (item.id === next.id ? next : item)),
      );
    },
    [queryClient, workspace.id],
  );

  const commitEnvelope = useCallback(
    (nextLayout: LayoutV3) => {
      // Stamp the viewed tab as active so any layout write records where the
      // operator is working (new sessions land there by default).
      const stamped = withActiveTab(nextLayout, tabIdRef.current);
      latestLayoutRef.current = stamped;
      latestTilesRef.current = tabTiles(stamped, tabIdRef.current);
      setTiles(latestTilesRef.current);
      revisionRef.current += 1;
      setRevision(revisionRef.current);
      setSaving(true);
      onErrorRef.current?.(null);
      const current =
        queryClient.getQueryData<Workspace>(["workspace", workspace.id]) ??
        serverWorkspaceRef.current;
      writeWorkspaceCaches({ ...current, layout: stamped });
    },
    [queryClient, workspace.id, writeWorkspaceCaches],
  );

  const commitLayout = useCallback(
    (nextTiles: Tile[]) =>
      commitEnvelope(withTabTiles(latestLayoutRef.current, tabIdRef.current, nextTiles)),
    [commitEnvelope],
  );

  useEffect(() => {
    if (revision === 0) return;
    const submittedRevision = revision;
    const submittedLayout = latestLayoutRef.current;
    const submittedEpoch = persistenceEpochRef.current;
    const timer = window.setTimeout(() => {
      saveChainRef.current = saveChainRef.current.then(async () => {
        if (submittedEpoch !== persistenceEpochRef.current) return;
        try {
          const saved = await workspaces.update(workspace.id, { layout: submittedLayout });
          if (submittedEpoch !== persistenceEpochRef.current) return;
          serverWorkspaceRef.current = saved;
          persistedRevisionRef.current = Math.max(persistedRevisionRef.current, submittedRevision);
          writeWorkspaceCaches(saved);
          if (revisionRef.current === submittedRevision) {
            latestLayoutRef.current = saved.layout;
            latestTilesRef.current = tabTiles(saved.layout, tabIdRef.current);
            setTiles(latestTilesRef.current);
            setSaving(false);
          } else {
            writeWorkspaceCaches({ ...saved, layout: latestLayoutRef.current });
          }
        } catch (error) {
          if (submittedEpoch !== persistenceEpochRef.current) return;
          persistenceEpochRef.current += 1;
          persistedRevisionRef.current = revisionRef.current;
          const rollback = serverWorkspaceRef.current;
          latestLayoutRef.current = rollback.layout;
          latestTilesRef.current = tabTiles(rollback.layout, tabIdRef.current);
          setTiles(latestTilesRef.current);
          writeWorkspaceCaches(rollback);
          setSaving(false);
          onErrorRef.current?.(error instanceof Error ? error.message : String(error));
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [revision, workspace.id, writeWorkspaceCaches]);

  useEffect(
    () => () => {
      if (revisionRef.current <= persistedRevisionRef.current) return;
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          await workspaces.update(workspace.id, { layout: latestLayoutRef.current });
        } catch (error) {
          console.warn("Could not persist the final workspace layout", error);
        }
      });
    },
    [workspace.id],
  );

  const registerSlot = useCallback(
    (sessionId: string, element: HTMLElement | null, stacked: boolean) => {
      setSlots((current) => {
        if (!element) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        const existing = current[sessionId];
        if (existing?.el === element && existing.stacked === stacked) return current;
        return { ...current, [sessionId]: { el: element, stacked } };
      });
    },
    [],
  );

  const registerHandle = useCallback((sessionId: string, getter: HandleGetter) => {
    handleGettersRef.current.set(sessionId, getter);
  }, []);

  const clearGestureStyles = useCallback(() => {
    for (const element of tileElementsRef.current.values()) {
      element.style.transform = "";
      element.style.removeProperty("--preview-width");
      element.style.removeProperty("--preview-height");
      element.style.removeProperty("transition");
      element.removeAttribute("data-gesture-active");
    }
    const ghost = ghostRef.current;
    if (ghost) ghost.hidden = true;
    const divider = dividerElementRef.current;
    if (divider) {
      divider.style.transform = "";
      divider.removeAttribute("data-dragging");
      dividerElementRef.current = null;
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const previewLayout = useCallback((gesture: GridGesture) => {
    const { before, preview, areaRect } = gesture;
    onPreviewTilesRef.current?.(preview);
    // A seam drag has no dragged tile: every pane it touches previews in place.
    const sessionId = gesture.kind === "divider" ? null : gesture.sessionId;
    for (const next of preview) {
      const element = tileElementsRef.current.get(next.session_id);
      const previous = before.find((tile) => tile.session_id === next.session_id);
      if (!element || !previous) continue;
      if (next.session_id === sessionId) continue;
      const from = tilePixelRect(previous, areaRect.width, areaRect.height);
      const to = tilePixelRect(next, areaRect.width, areaRect.height);
      element.style.transform = `translate3d(${to.left - from.left}px, ${to.top - from.top}px, 0)`;
      element.style.setProperty("--preview-width", `${to.width}px`);
      element.style.setProperty("--preview-height", `${to.height}px`);
    }
    const target = preview.find((tile) => tile.session_id === sessionId);
    const ghost = ghostRef.current;
    if (!target || !ghost) return;
    const rect = tilePixelRect(target, areaRect.width, areaRect.height);
    ghost.hidden = false;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
  }, []);

  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      const listeners = gestureListenersRef.current;
      if (listeners.move) document.removeEventListener("pointermove", listeners.move);
      if (listeners.up) document.removeEventListener("pointerup", listeners.up);
      if (listeners.cancel) document.removeEventListener("pointercancel", listeners.cancel);
      gestureListenersRef.current = { move: null, up: null, cancel: null };
      if (gesture && commit && gesture.kind === "move" && gesture.sourceTab) {
        // The drag crossed tabs: one envelope write removes the tile from its
        // source tab and lands the previewed layout in the viewed tab.
        const source = gesture.sourceTab;
        flushSync(() =>
          commitEnvelope(
            withTabTiles(
              withTabTiles(
                latestLayoutRef.current,
                source.tabId,
                removeTile(tabTiles(latestLayoutRef.current, source.tabId), gesture.sessionId),
              ),
              tabIdRef.current,
              gesture.preview,
            ),
          ),
        );
      } else if (gesture && commit && !tilesEqual(gesture.before, gesture.preview)) {
        flushSync(() => commitLayout(gesture.preview));
      } else if (gesture && gesture.kind === "move" && gesture.sourceTab) {
        // Cancelled mid-carry: the committed state never changed, so simply
        // fall back to the viewed tab's committed tiles (the dragged pane is
        // still in its source tab).
        setTiles(latestTilesRef.current);
      }
      hoveredTabRef.current = null;
      onPreviewTilesRef.current?.(null);
      clearGestureStyles();
    },
    [clearGestureStyles, commitEnvelope, commitLayout],
  );

  const onGestureMove = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      event.preventDefault();

      if (gesture.kind === "divider") {
        const { divider, areaRect } = gesture;
        const vertical = divider.axis === "vertical";
        const cell = (vertical ? areaRect.width : areaRect.height) / GRID_SIZE;
        const delta = vertical
          ? event.clientX - gesture.startClientX
          : event.clientY - gesture.startClientY;
        const line = clampDividerLine(divider, divider.line + delta / cell);
        const element = dividerElementRef.current;
        if (element) {
          element.style.transform = vertical
            ? `translate3d(${(line - divider.line) * cell}px, 0, 0)`
            : `translate3d(0, ${(line - divider.line) * cell}px, 0)`;
        }
        if (line === gesture.lastLine) return;
        gesture.lastLine = line;
        gesture.preview = moveDivider(gesture.before, divider, line);
        previewLayout(gesture);
        return;
      }

      const active = tileElementsRef.current.get(gesture.sessionId);
      const original = gesture.before.find((tile) => tile.session_id === gesture.sessionId);
      if (!active || !original) return;

      const dx = event.clientX - gesture.startClientX;
      const dy = event.clientY - gesture.startClientY;
      if (gesture.kind === "move") {
        gesture.lastClientX = event.clientX;
        gesture.lastClientY = event.clientY;
        // Hovering another tab in the strip for a beat switches the view to
        // it mid-drag; the tabId-change effect below re-seeds the gesture so
        // the pane is carried into the newly visible grid.
        const overTab = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest?.("[data-workspace-tab]")
          ?.getAttribute("data-workspace-tab");
        if (overTab && overTab !== tabIdRef.current) {
          const hovered = hoveredTabRef.current;
          if (!hovered || hovered.id !== overTab) {
            hoveredTabRef.current = { id: overTab, since: performance.now() };
          } else if (performance.now() - hovered.since >= TAB_DWELL_MS) {
            hoveredTabRef.current = null;
            onSwitchTabRef.current?.(overTab);
          }
        } else {
          hoveredTabRef.current = null;
        }
        active.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        const cellWidth = gesture.areaRect.width / GRID_SIZE;
        const cellHeight = gesture.areaRect.height / GRID_SIZE;

        // Hovering another pane docks against its nearest edge (iTerm-style):
        // the target splits in half and the ghost claims the hovered side.
        const pointerX = (event.clientX - gesture.areaRect.left) / cellWidth;
        const pointerY = (event.clientY - gesture.areaRect.top) / cellHeight;
        const hovered = gesture.before.find(
          (tile) =>
            tile.session_id !== gesture.sessionId &&
            pointerX >= tile.x &&
            pointerX < tile.x + tile.w &&
            pointerY >= tile.y &&
            pointerY < tile.y + tile.h,
        );
        if (hovered) {
          const zone = dockZoneAt(
            (pointerX - hovered.x) / hovered.w,
            (pointerY - hovered.y) / hovered.h,
          );
          const dockKey = `${hovered.session_id}:${zone}`;
          if (dockKey === gesture.lastDock) return;
          gesture.lastDock = dockKey;
          // Leaving dock mode must recompute the cell path, whatever cell.
          gesture.lastX = Number.NaN;
          gesture.lastY = Number.NaN;
          gesture.preview =
            dockPane(gesture.before, gesture.sessionId, hovered.session_id, zone) ?? gesture.before;
          previewLayout(gesture);
          return;
        }
        gesture.lastDock = null;

        const x = Math.round(
          (event.clientX - gesture.areaRect.left - gesture.pointerOffsetX) / cellWidth,
        );
        const y = Math.round(
          (event.clientY - gesture.areaRect.top - gesture.pointerOffsetY) / cellHeight,
        );
        if (x === gesture.lastX && y === gesture.lastY) return;
        gesture.lastX = x;
        gesture.lastY = y;
        gesture.preview = movePane(gesture.before, gesture.sessionId, x, y);
        previewLayout(gesture);
        return;
      }

      const cellWidth = gesture.areaRect.width / GRID_SIZE;
      const cellHeight = gesture.areaRect.height / GRID_SIZE;
      const { edges } = gesture;
      const targets: EdgeTargets = {};
      if (edges.h === -1) targets.left = Math.round(original.x + dx / cellWidth);
      if (edges.h === 1) targets.right = Math.round(original.x + original.w + dx / cellWidth);
      if (edges.v === -1) targets.top = Math.round(original.y + dy / cellHeight);
      if (edges.v === 1) targets.bottom = Math.round(original.y + original.h + dy / cellHeight);

      // Elastic pixel feedback on the grabbed pane; the ghost shows the snap.
      const originalRect = tilePixelRect(original, gesture.areaRect.width, gesture.areaRect.height);
      const minWidth = MIN_TILE_SIZE * cellWidth;
      const minHeight = MIN_TILE_SIZE * cellHeight;
      let left = originalRect.left;
      let top = originalRect.top;
      let width = originalRect.width;
      let height = originalRect.height;
      if (edges.h === 1) {
        width = Math.min(gesture.areaRect.width - left, Math.max(minWidth, width + dx));
      } else if (edges.h === -1) {
        const nextLeft = Math.min(left + width - minWidth, Math.max(0, left + dx));
        width += left - nextLeft;
        left = nextLeft;
      }
      if (edges.v === 1) {
        height = Math.min(gesture.areaRect.height - top, Math.max(minHeight, height + dy));
      } else if (edges.v === -1) {
        const nextTop = Math.min(top + height - minHeight, Math.max(0, top + dy));
        height += top - nextTop;
        top = nextTop;
      }
      active.style.transform = `translate3d(${left - originalRect.left}px, ${top - originalRect.top}px, 0)`;
      active.style.setProperty("--preview-width", `${width}px`);
      active.style.setProperty("--preview-height", `${height}px`);

      const key = `${targets.left ?? ""}:${targets.right ?? ""}:${targets.top ?? ""}:${targets.bottom ?? ""}`;
      if (key === gesture.lastKey) return;
      gesture.lastKey = key;
      // Applied to the latest preview, not the gesture start: a drag that hits
      // a gapped neighbour clamps there, and the next cell of travel starts
      // pushing it — one continuous sweep closes the gap, then trades space.
      gesture.preview = resizeEdges(gesture.preview, gesture.sessionId, targets);
      previewLayout(gesture);
    },
    [previewLayout],
  );

  const onGestureUp = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      const overTab = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest?.("[data-workspace-tab]")
        ?.getAttribute("data-workspace-tab");
      if (gesture?.kind === "move" && overTab && overTab !== tabIdRef.current) {
        // Dropped on the strip before the dwell switch fired: move the pane
        // into that tab directly, auto-placed, and follow it.
        const moved = moveSessionToTab(latestLayoutRef.current, gesture.sessionId, overTab);
        finishGesture(false);
        if (moved) {
          flushSync(() => commitEnvelope(moved));
          onSwitchTabRef.current?.(overTab);
        }
        return;
      }
      finishGesture(true);
    },
    [commitEnvelope, finishGesture],
  );
  const onGestureCancel = useCallback(() => finishGesture(false), [finishGesture]);

  /*
   * Tab switches. Normally: point the grid at the new tab's committed tiles.
   * Mid-move-drag (the dwell switch above): carry the dragged pane along —
   * auto-place it into the new tab and re-seed the live gesture there, so the
   * drop commits one cross-tab envelope write. Dragging back to the source
   * tab restores the original within-tab move. Resize and divider gestures
   * cannot cross tabs; a switch simply cancels them.
   */
  useEffect(() => {
    const previousTabId = tabIdRef.current;
    if (previousTabId === tabId) return;
    tabIdRef.current = tabId;
    hoveredTabRef.current = null;
    const gesture = gestureRef.current;
    latestTilesRef.current = tabTiles(latestLayoutRef.current, tabId);

    if (gesture?.kind === "move") {
      const dragged = gesture.before.find((tile) => tile.session_id === gesture.sessionId);
      const originTabId = gesture.sourceTab?.tabId ?? previousTabId;
      if (tabId === originTabId && dragged) {
        // Back home: the committed envelope still holds the tile here. The
        // origin must be re-anchored to the home rect — it was rewritten for
        // the tab the drag just left.
        gesture.sourceTab = null;
        gesture.lastDock = null;
        gesture.before = latestTilesRef.current;
        gesture.preview = latestTilesRef.current;
        const home = latestTilesRef.current.find((tile) => tile.session_id === gesture.sessionId);
        const area = areaRef.current;
        if (home && area) {
          gesture.areaRect = area.getBoundingClientRect();
          const homeRect = tilePixelRect(home, gesture.areaRect.width, gesture.areaRect.height);
          gesture.pointerOffsetX = Math.min(gesture.pointerOffsetX, homeRect.width);
          gesture.pointerOffsetY = Math.min(gesture.pointerOffsetY, homeRect.height);
          gesture.startClientX = gesture.areaRect.left + homeRect.left + gesture.pointerOffsetX;
          gesture.startClientY = gesture.areaRect.top + homeRect.top + gesture.pointerOffsetY;
          gesture.lastX = home.x;
          gesture.lastY = home.y;
        }
      } else if (dragged) {
        const targetTiles = latestTilesRef.current.filter(
          (tile) => tile.session_id !== gesture.sessionId,
        );
        const placed = autoPlace(targetTiles);
        if (placed.tile === null) {
          // No room here: the view switches but the drag ends without effect.
          finishGesture(false);
          flushSync(() => setTiles(tabTiles(latestLayoutRef.current, tabId)));
          return;
        }
        gesture.sourceTab ??= { tabId: originTabId, tiles: gesture.before };
        const seeded = [...placed.tiles, { ...dragged, ...placed.tile }];
        gesture.before = seeded;
        gesture.preview = seeded;
        gesture.lastX = placed.tile.x;
        gesture.lastY = placed.tile.y;
        gesture.lastDock = null;
        flushSync(() => setTiles(seeded));
        const area = areaRef.current;
        const element = tileElementsRef.current.get(gesture.sessionId);
        if (area && element) {
          gesture.areaRect = area.getBoundingClientRect();
          /*
           * Keep the original grab point: anchor the gesture's origin to the
           * seeded tile's layout rect — never the DOM rect, which still wears
           * the previous tab's drag transform — and place the pane under the
           * cursor immediately. Later moves recompute the same way (transform
           * = cursor − origin), so there is no offset drift after the switch.
           */
          const seededRect = tilePixelRect(
            placed.tile,
            gesture.areaRect.width,
            gesture.areaRect.height,
          );
          gesture.pointerOffsetX = Math.min(gesture.pointerOffsetX, seededRect.width);
          gesture.pointerOffsetY = Math.min(gesture.pointerOffsetY, seededRect.height);
          gesture.startClientX = gesture.areaRect.left + seededRect.left + gesture.pointerOffsetX;
          gesture.startClientY = gesture.areaRect.top + seededRect.top + gesture.pointerOffsetY;
          element.dataset.gestureActive = "true";
          element.style.transition = "none";
          element.style.transform = `translate3d(${gesture.lastClientX - gesture.startClientX}px, ${gesture.lastClientY - gesture.startClientY}px, 0)`;
        }
        previewLayout(gesture);
        return;
      }
      flushSync(() => setTiles(latestTilesRef.current));
      previewLayout(gesture);
      return;
    }
    if (gesture) finishGesture(false);
    setTiles(latestTilesRef.current);
    setZoomedId(null);
  }, [finishGesture, previewLayout, tabId]);

  const installGestureListeners = useCallback(() => {
    gestureListenersRef.current = {
      move: onGestureMove,
      up: onGestureUp,
      cancel: onGestureCancel,
    };
    document.addEventListener("pointermove", onGestureMove, { passive: false });
    document.addEventListener("pointerup", onGestureUp, { once: true });
    document.addEventListener("pointercancel", onGestureCancel, { once: true });
  }, [onGestureCancel, onGestureMove, onGestureUp]);

  const beginMove = useCallback(
    (sessionId: string, startClientX: number, startClientY: number) => {
      const area = areaRef.current;
      const tileElement = tileElementsRef.current.get(sessionId);
      const tile = latestTilesRef.current.find((item) => item.session_id === sessionId);
      if (!area || !tileElement || !tile) return;
      const areaRect = area.getBoundingClientRect();
      const tileRect = tileElement.getBoundingClientRect();
      const before = latestTilesRef.current;
      const gesture: MoveGesture = {
        kind: "move",
        sessionId,
        startClientX,
        startClientY,
        pointerOffsetX: startClientX - tileRect.left,
        pointerOffsetY: startClientY - tileRect.top,
        lastX: tile.x,
        lastY: tile.y,
        lastClientX: startClientX,
        lastClientY: startClientY,
        sourceTab: null,
        lastDock: null,
        before,
        preview: before,
        areaRect,
      };
      gestureRef.current = gesture;
      tileElement.dataset.gestureActive = "true";
      tileElement.style.transition = "none";
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setFocus(sessionId);
      previewLayout(gesture);
      installGestureListeners();
    },
    [installGestureListeners, previewLayout, setFocus],
  );

  const disarmMove = useCallback(() => {
    const armed = armedMoveRef.current;
    if (!armed) return;
    armedMoveRef.current = null;
    document.removeEventListener("pointermove", armed.move);
    document.removeEventListener("pointerup", armed.end);
    document.removeEventListener("pointercancel", armed.end);
  }, []);

  /**
   * The whole title bar is the drag surface, so the gesture only commits once
   * the pointer has travelled far enough to rule out a click or a double-click
   * (which zooms the pane).
   */
  const startMove = useCallback(
    (sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || zoomedId || event.pointerType === "touch") return;
      if (!tileElementsRef.current.has(sessionId)) return;
      disarmMove();
      const clientX = event.clientX;
      const clientY = event.clientY;
      const onMove = (moveEvent: PointerEvent) => {
        if (
          Math.abs(moveEvent.clientX - clientX) < DRAG_THRESHOLD_PX &&
          Math.abs(moveEvent.clientY - clientY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        disarmMove();
        beginMove(sessionId, clientX, clientY);
      };
      const armed: ArmedMove = { sessionId, clientX, clientY, move: onMove, end: disarmMove };
      armedMoveRef.current = armed;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", disarmMove, { once: true });
      document.addEventListener("pointercancel", disarmMove, { once: true });
    },
    [beginMove, disarmMove, finePointer, wide, zoomedId],
  );

  const startResize = useCallback(
    (sessionId: string, edges: ResizeEdges, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || zoomedId || event.pointerType === "touch") return;
      const area = areaRef.current;
      const tileElement = tileElementsRef.current.get(sessionId);
      const tile = latestTilesRef.current.find((item) => item.session_id === sessionId);
      if (!area || !tileElement || !tile || (edges.h === 0 && edges.v === 0)) return;
      event.preventDefault();
      event.stopPropagation();
      const before = latestTilesRef.current;
      const gesture: ResizeGesture = {
        kind: "resize",
        sessionId,
        edges,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastKey: "",
        before,
        preview: before,
        areaRect: area.getBoundingClientRect(),
      };
      gestureRef.current = gesture;
      tileElement.dataset.gestureActive = "true";
      tileElement.style.transition = "none";
      document.body.style.cursor =
        edges.h !== 0 && edges.v !== 0
          ? edges.h === edges.v
            ? "nwse-resize"
            : "nesw-resize"
          : edges.h !== 0
            ? "ew-resize"
            : "ns-resize";
      document.body.style.userSelect = "none";
      setFocus(sessionId);
      previewLayout(gesture);
      installGestureListeners();
    },
    [finePointer, installGestureListeners, previewLayout, setFocus, wide, zoomedId],
  );

  const startDividerDrag = useCallback(
    (divider: GridDivider, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || zoomedId || event.pointerType === "touch") return;
      const area = areaRef.current;
      if (!area) return;
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget;
      const before = latestTilesRef.current;
      dividerElementRef.current = element;
      element.dataset.dragging = "true";
      gestureRef.current = {
        kind: "divider",
        divider,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastLine: divider.line,
        before,
        preview: before,
        areaRect: area.getBoundingClientRect(),
      };
      for (const id of [...divider.before, ...divider.after]) {
        const tileElement = tileElementsRef.current.get(id);
        if (tileElement) tileElement.style.transition = "none";
      }
      document.body.style.cursor = divider.axis === "vertical" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      installGestureListeners();
    },
    [finePointer, installGestureListeners, wide, zoomedId],
  );

  // Unmount-only: removes whatever listeners are actually installed. Keying
  // this on the callbacks would re-run it on any re-render that changes their
  // identity — which is exactly mid-gesture, when a debounced save lands.
  useEffect(
    () => () => {
      const listeners = gestureListenersRef.current;
      if (listeners.move) document.removeEventListener("pointermove", listeners.move);
      if (listeners.up) document.removeEventListener("pointerup", listeners.up);
      if (listeners.cancel) document.removeEventListener("pointercancel", listeners.cancel);
      gestureListenersRef.current = { move: null, up: null, cancel: null };
      disarmMove();
      clearGestureStyles();
    },
    [clearGestureStyles, disarmMove],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
      if (digit) {
        const ordered = [...(allWorkspacesQ.data ?? [])].sort((a, b) => a.position - b.position);
        const target = ordered[Number(digit) - 1];
        if (target && target.id !== workspace.id) {
          event.preventDefault();
          event.stopPropagation();
          router.push(`/w/${target.id}`);
        }
        return;
      }
      if (event.code === "KeyZ" && focusedId) {
        event.preventDefault();
        event.stopPropagation();
        setZoomedId((current) => (current === focusedId ? null : focusedId));
        return;
      }
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if ((!forward && !backward) || orderedIds.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = focusedId ? orderedIds.indexOf(focusedId) : -1;
      const index =
        current < 0 ? 0 : (current + (forward ? 1 : orderedIds.length - 1)) % orderedIds.length;
      setFocus(orderedIds[index] ?? null, true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [allWorkspacesQ.data, focusedId, orderedIds, router, setFocus, workspace.id]);

  const removeFromWorkspace = useCallback(
    (sessionId: string) => commitLayout(removeTile(latestTilesRef.current, sessionId)),
    [commitLayout],
  );

  const moveMobile = useCallback(
    (sessionId: string, delta: -1 | 1) => {
      const currentOrder = readingOrder(latestTilesRef.current);
      const nextOrder = moveIdInOrder(currentOrder, sessionId, delta);
      if (nextOrder.every((id, index) => id === currentOrder[index])) return;
      commitLayout(repackMobileTiles(latestTilesRef.current, nextOrder));
      setFocus(sessionId, true);
    },
    [commitLayout, setFocus],
  );

  const canGesture = wide && finePointer && zoomedId === null;

  const renderPaneSlots = () => {
    if (wide) {
      return (
        <div className="absolute inset-0 overflow-hidden">
          {tiles.map((tile) => {
            const zoomed = zoomedId === tile.session_id;
            return (
              <div
                key={tile.session_id}
                ref={(element) => {
                  if (element) tileElementsRef.current.set(tile.session_id, element);
                  else tileElementsRef.current.delete(tile.session_id);
                }}
                data-grid-tile={tile.session_id}
                style={tileStyle(tile, zoomed)}
                className={cn(
                  "absolute z-10 min-h-0 min-w-0 border-pane-divider will-change-transform transition-transform duration-150 ease-swift",
                  // A divider only where two panes actually meet edge to edge;
                  // edges facing empty canvas (or the border) draw nothing.
                  !zoomed &&
                    tiles.some(
                      (other) =>
                        other.session_id !== tile.session_id &&
                        other.x === tile.x + tile.w &&
                        other.y < tile.y + tile.h &&
                        tile.y < other.y + other.h,
                    ) &&
                    "border-r",
                  !zoomed &&
                    tiles.some(
                      (other) =>
                        other.session_id !== tile.session_id &&
                        other.y === tile.y + tile.h &&
                        other.x < tile.x + tile.w &&
                        tile.x < other.x + other.w,
                    ) &&
                    "border-b",
                  zoomedId && !zoomed && "hidden",
                  zoomed && "z-30",
                )}
              >
                {tile.widget ? (
                  <WidgetPane
                    tile={tile}
                    widget={tile.widget}
                    focused={focusedId === tile.session_id}
                    paneCount={tiles.length}
                    canDrag={canGesture}
                    onFocus={(id) => setFocus(id)}
                    onToggleZoom={(id) => setZoomedId((current) => (current === id ? null : id))}
                    onMoveStart={startMove}
                    onRemove={removeFromWorkspace}
                  />
                ) : (
                  <PaneSlot sessionId={tile.session_id} stacked={false} register={registerSlot} />
                )}
                {canGesture && !zoomed && (
                  <TileResizeHandles
                    sessionId={tile.session_id}
                    title={
                      tile.widget
                        ? widgetTitle(tile.widget)
                        : (() => {
                            const session = sessionsById.get(tile.session_id);
                            return session ? sessionTitle(session) : "pane";
                          })()
                    }
                    onStart={startResize}
                  />
                )}
              </div>
            );
          })}
          {!zoomedId &&
            openings.map((rect) => (
              <div
                key={`opening-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
                data-grid-opening={`${rect.x},${rect.y},${rect.w},${rect.h}`}
                style={{
                  left: `${(rect.x / GRID_SIZE) * 100}%`,
                  top: `${(rect.y / GRID_SIZE) * 100}%`,
                  width: `${(rect.w / GRID_SIZE) * 100}%`,
                  height: `${(rect.h / GRID_SIZE) * 100}%`,
                }}
                className="absolute z-0 p-1 [&>span]:size-full [&>span>div]:size-full"
              >
                <NewSessionMenu
                  mode="session"
                  workspaceId={workspace.id}
                  placement={rect}
                  trigger={
                    <button
                      type="button"
                      aria-label="Add a pane here"
                      className={cn(
                        "group/opening grid size-full place-items-center rounded-md border border-dashed border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background/80",
                        // Lit up while a pane dragged off the launcher hovers it.
                        "data-[drop-target]:border-ring/70 data-[drop-target]:bg-background/80",
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-xs opacity-0 transition-opacity group-hover/opening:opacity-100 group-data-[drop-target]/opening:opacity-100">
                        <Plus className="size-4" aria-hidden />
                        Add a pane
                      </span>
                    </button>
                  }
                  onCreated={({ sessionId }) => {
                    if (sessionId) setFocus(sessionId, true);
                  }}
                />
              </div>
            ))}
          {canGesture &&
            dividers.map((divider) => {
              const vertical = divider.axis === "vertical";
              const along = `${(divider.start / GRID_SIZE) * 100}%`;
              const span = `${((divider.end - divider.start) / GRID_SIZE) * 100}%`;
              const across = `calc(${(divider.line / GRID_SIZE) * 100}% - ${DIVIDER_HIT_PX / 2}px)`;
              return (
                <button
                  key={divider.id}
                  type="button"
                  aria-label={
                    vertical
                      ? "Resize the panes on either side"
                      : "Resize the panes above and below"
                  }
                  data-grid-divider={divider.id}
                  onPointerDown={(event) => startDividerDrag(divider, event)}
                  style={
                    vertical
                      ? {
                          left: across,
                          top: `calc(${along} + ${DIVIDER_INSET_PX}px)`,
                          width: DIVIDER_HIT_PX,
                          height: `calc(${span} - ${DIVIDER_INSET_PX * 2}px)`,
                        }
                      : {
                          top: across,
                          left: `calc(${along} + ${DIVIDER_INSET_PX}px)`,
                          height: DIVIDER_HIT_PX,
                          width: `calc(${span} - ${DIVIDER_INSET_PX * 2}px)`,
                        }
                  }
                  className={cn(
                    "group/divider absolute z-40 touch-none",
                    vertical ? "cursor-col-resize" : "cursor-row-resize",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute bg-transparent transition-colors",
                      "group-hover/divider:bg-ring/70 group-data-[dragging]/divider:bg-ring",
                      vertical
                        ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
                        : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
                    )}
                  />
                </button>
              );
            })}
          <div
            ref={ghostRef}
            hidden
            aria-hidden
            className="pointer-events-none absolute z-50 border-2 border-dashed border-ring bg-ring/10"
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-(--pane-gap) overflow-y-auto p-[calc(var(--pane-gap)/2)]">
        {orderedIds.map((sessionId) => {
          const widget = tiles.find((tile) => tile.session_id === sessionId)?.widget;
          return (
            <div
              key={sessionId}
              className="min-h-[55dvh] w-full shrink-0 overflow-hidden rounded-md border border-pane-divider"
            >
              {widget ? (
                <WidgetPane
                  tile={{ session_id: sessionId, x: 0, y: 0, w: GRID_SIZE, h: GRID_SIZE }}
                  widget={widget}
                  focused={focusedId === sessionId}
                  paneCount={tiles.length}
                  canDrag={false}
                  onFocus={(id) => setFocus(id)}
                  onToggleZoom={() => {}}
                  onMoveStart={() => {}}
                  onRemove={removeFromWorkspace}
                />
              ) : (
                <PaneSlot sessionId={sessionId} stacked register={registerSlot} />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-shell">
      <div
        ref={areaRef}
        data-workspace-canvas
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
          // An empty tab wears the selected tab's own surface, so the tab
          // and its (empty) content read as one connected sheet.
          tiles.length === 0 && "bg-background",
        )}
      >
        {tiles.length === 0 ? (
          <EmptyState
            icon={<Plus />}
            title="Start with a shell"
            body="New sessions open in this workspace's folder — no picking required."
            className="size-full"
            action={
              <NewSessionMenu
                mode="session"
                workspaceId={workspace.id}
                trigger={
                  <Button size="lg">
                    <Plus className="size-4" aria-hidden />
                    New session
                  </Button>
                }
                onCreated={({ sessionId }) => {
                  router.push(`/w/${workspace.id}?focus=${sessionId}`);
                }}
              />
            }
          />
        ) : (
          renderPaneSlots()
        )}
      </div>

      {!wide && tiles.length > 0 && (
        <ModifierBar
          className="hidden [@media(pointer:coarse)]:flex"
          onSend={(bytes) => {
            const handle = focusedId ? handleGettersRef.current.get(focusedId)?.() : null;
            handle?.sendInput(bytes);
            requestAnimationFrame(() => handle?.focus());
          }}
          onPaste={(data) => {
            if (focusedId) handleGettersRef.current.get(focusedId)?.()?.pasteDataTransfer(data);
          }}
          onPasteText={(text) => {
            if (focusedId) handleGettersRef.current.get(focusedId)?.()?.pasteText(text);
          }}
          onPasteClick={() => {
            if (focusedId) void handleGettersRef.current.get(focusedId)?.()?.pasteFromClipboard();
          }}
          onSubmit={() => {
            const handle = focusedId ? handleGettersRef.current.get(focusedId)?.() : null;
            handle?.submit();
            requestAnimationFrame(() => handle?.focus());
          }}
        />
      )}

      {sessionTileIds.map((sessionId, index) => (
        <SessionPane
          key={sessionId}
          sessionId={sessionId}
          session={sessionsById.get(sessionId)}
          slot={slots[sessionId]}
          focused={focusedId === sessionId}
          paneCount={tiles.length}
          canDrag={canGesture}
          canMoveUp={!wide && index > 0}
          canMoveDown={!wide && index < orderedIds.length - 1}
          onFocus={(id) => setFocus(id)}
          onToggleZoom={(id) => setZoomedId((current) => (current === id ? null : id))}
          onMoveStart={startMove}
          onMoveUp={(id) => moveMobile(id, -1)}
          onMoveDown={(id) => moveMobile(id, 1)}
          onRemoveFromWorkspace={removeFromWorkspace}
          registerHandle={registerHandle}
          onError={onError ?? (() => {})}
        />
      ))}
    </div>
  );
}
