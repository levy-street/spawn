"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
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
import { Trident } from "@/components/icons/BrandMark";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import {
  agents as agentsApi,
  type Host,
  type Session,
  sessionAccess,
  sessions as sessionsApi,
  type Workspace,
  workspaces,
} from "@/lib/api";
import {
  autoPlace,
  GRID_SIZE,
  MAX_TILES,
  MIN_TILE_SIZE,
  type Rect,
  readingOrder,
  remove as removeTile,
  type Tile,
  type TileWidget,
  validate,
} from "@/lib/grid";
import { detectAppleModifiers, gridShortcut, keystrokeBelongsToText } from "@/lib/keyboard-chords";
import { sessionAgent, sessionTitle } from "@/lib/sessions";
import {
  addTab,
  type LayoutV3,
  MAX_TABS,
  moveSessionToTab,
  nextTabName,
  tabOfSession,
  tabTiles,
  withActiveTab,
  withTabTiles,
} from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { agentLaunchCommand, newAgentConversationId } from "./agent-command";
import { NewSessionLozenges, NewSessionMenu } from "./new-session-menu";
import { queryInPane, usePaneScope } from "./pane-scope";
import { pendingLaunch } from "./pending-launch";
import { type PaneSlotTarget, SessionPane } from "./session-pane";
import { TabHomeButton } from "./tab-home";
import { WidgetPane, widgetTitle } from "./widget-pane";
import {
  addPaneTiles,
  clampDividerLine,
  dockInsert,
  dockPane,
  dockZoneAt,
  type EdgeTargets,
  expandTileIntoEmptySpace,
  freeRects,
  type GridDivider,
  gridDividers,
  insertPane,
  moveDivider,
  moveIdInOrder,
  movePane,
  PENDING_TILE_ID,
  type ResizeEdges,
  repackMobileTiles,
  resizeEdges,
  tilePixelRect,
  wantsDuplicate,
} from "./workspace-grid-helpers";

/**
 * How much canvas the real grid needs; narrower than this the panes stack into
 * the mobile layout instead.
 *
 * A half of a split is not measured at all. The stacked layout is an answer
 * to a *phone*, and a half of a window on a desktop is not one — a split that
 * dropped its panes into a scrolling list the moment the seam moved past some
 * number would be rearranging work the user had laid out, for a shape they
 * chose deliberately. A split half stays a grid at whatever width it is given.
 */
const WIDE_CONTAINER_PX = 768;
/**
 * Where the first window of an empty tab lands: the left half, full height.
 * Auto-placing would hand it the whole canvas, and a full canvas has nowhere
 * left to invite a second window from — this leaves a standing opening.
 */
const FIRST_WINDOW: Rect = { x: 0, y: 0, w: GRID_SIZE / 2, h: GRID_SIZE };
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
  /**
   * Non-null while ⌘ is held: the drag is duplicating, not moving. The source
   * pane stays put and this placeholder — same size, `PENDING_TILE_ID` — is what
   * follows the cursor. The drop turns it into a real pane.
   */
  clone: { size: { w: number; h: number } } | null;
  /** True while the pointer is over the launcher, which is a bin for the
   *  length of a drag: the drop discards the pane instead of placing it. */
  discarding: boolean;
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

/**
 * The tab under the pointer, when it is one of `workspaceId`'s own.
 *
 * A split window has two tab strips on screen and a hit-test finds either, but
 * a grid can only carry a pane into a tab of the workspace it is showing:
 * switching to a foreign tab id would leave this grid pointed at a tab that
 * does not exist in its envelope. Dragging a pane across the seam is not a
 * gesture yet, so the other strip has to read as no strip at all rather than
 * as a target that half-works.
 *
 * A tab has to name this workspace to count. One that names nobody is not
 * treated as ours: the strip stamps its owner on every button, so an unowned
 * one means the markup moved and the safe answer is the one that cannot switch
 * this grid to a foreign tab.
 */
function ownTabAt(under: Element | null | undefined, workspaceId: string): string | null {
  const tab = under?.closest?.("[data-workspace-tab]");
  if (!tab || tab.getAttribute("data-workspace-tab-owner") !== workspaceId) return null;
  return tab.getAttribute("data-workspace-tab");
}

/**
 * True when the pointer rests on this workspace's tab strip itself — the open
 * ground after the tabs, not a tab or a control in it. Same ownership rule as
 * `ownTabAt`: in a split, a foreign strip reads as no strip at all. The
 * ground is where a tab that does not exist yet would go, which is why a
 * dragged pane is offered "new tab" there and nowhere else.
 */
function ownStripGroundAt(under: Element | null | undefined, workspaceId: string): boolean {
  const strip = under?.closest?.("[data-workspace-tab-strip]");
  if (!strip || strip.getAttribute("data-workspace-tab-strip-owner") !== workspaceId) return false;
  // A tab is its own target — the drop moves the pane into it — and a rename
  // in flight keeps its input. Everything else in the band counts as ground,
  // buttons included: they are inert to a drag anyway, and excluding the "+"
  // would let the chip's own arrival shove it under the pointer and steal
  // the drop it just promised.
  return !under?.closest?.("[data-workspace-tab], form, input");
}

/** The tile a gesture is actually dragging — the copy, when ⌘ is down. */
function draggedTileId(gesture: GridGesture): string | null {
  if (gesture.kind === "divider") return null;
  if (gesture.kind === "move" && gesture.clone) return PENDING_TILE_ID;
  return gesture.sessionId;
}

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

/**
 * A tile's whole geometry, in cell fractions of the canvas. `--preview-*` is
 * the one escape hatch: the pane being resized wants sub-cell pixel feedback
 * under the pointer, which no grid rect can express, so `onGestureMove` writes
 * those two on that pane alone and `clearGestureStyles` takes them back off.
 * Every other pane's geometry comes from here and nowhere else.
 */
function tileStyle(tile: Tile): CSSProperties {
  const values = {
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
  previewTiles,
  onPreviewTiles,
  onDraggingPane,
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
  /** A preview driven from outside the grid — a pane dragged off the launcher.
   *  The panes take the shape they will have once it lands. Ignored while the
   *  grid has a gesture of its own, which owns the preview. */
  previewTiles?: Tile[] | null;
  /** Live gesture previews (move/resize/seam), null when no gesture is on.
   *  The tab strip uses this to restyle the selected tab mid-drag. */
  onPreviewTiles?: (tiles: Tile[] | null) => void;
  /** A pane is being carried (moved or duplicated), so the launcher can put on
   *  its bin face — dropping there discards instead of placing. */
  onDraggingPane?: (dragging: boolean) => void;
  onError?: (message: string | null) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // This half of the window: whether it shares the screen with a second
  // workspace, and whether it is the half the keyboard is meant for.
  const { active: paneActive, split, routed, rootRef: paneRootRef } = usePaneScope();
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
    key: ((event: KeyboardEvent) => void) | null;
  }>({ move: null, up: null, cancel: null, key: null });
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
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  const latestTilesRef = useRef(tiles);
  // Read through a ref for the same reason as the callbacks below: the live
  // gesture closures must not be rebuilt when a prop identity changes.
  const workspaceIdRef = useRef(workspace.id);
  workspaceIdRef.current = workspace.id;
  const onSwitchTabRef = useRef(onSwitchTab);
  onSwitchTabRef.current = onSwitchTab;
  // Read through a ref everywhere below: an inline onError prop must not
  // change gesture-callback identities (that tore down live drag listeners).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPreviewTilesRef = useRef(onPreviewTiles);
  onPreviewTilesRef.current = onPreviewTiles;
  const onDraggingPaneRef = useRef(onDraggingPane);
  onDraggingPaneRef.current = onDraggingPane;
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
  /**
   * The layout a live gesture is showing, plus the tile riding the pointer —
   * that one stays at its resting rect and is offset by a transform instead,
   * so it tracks the cursor exactly rather than snapping to whole cells.
   *
   * Rendered rather than written onto the tiles by hand: a tile's geometry has
   * exactly one owner, `tileStyle`. Driving the same properties imperatively
   * as well only holds until something re-renders mid-gesture — and plenty
   * does, since every preview reports up to the tab strip.
   */
  const [livePreview, setLivePreview] = useState<{
    tiles: Tile[];
    draggedId: string | null;
  } | null>(null);
  // Cleared for the length of a gesture: the openings are drop affordances for
  // a canvas at rest, and mid-drag they light up under the ghost and offer to
  // add a pane on top of the one being placed.
  const openings = useMemo(
    () => (livePreview !== null || tiles.length >= MAX_TILES ? [] : freeRects(tiles)),
    [livePreview, tiles],
  );
  /**
   * A tab holding one window has canvas left over, and nothing on screen says
   * that canvas is clickable — so while there is exactly one window its
   * openings stay lit rather than waiting for a hover. From the second window
   * on they go quiet again: a working grid is not littered with dashed boxes.
   */
  const openingsLit = tiles.length === 1;
  const sessionTileIds = useMemo(() => readingOrder(tiles.filter((tile) => !tile.widget)), [tiles]);
  const allWorkspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  // Warms the registry cache so a duplicate's ensureQueryData resolves from
  // memory; the duplicate itself awaits the query rather than reading this.
  useQuery({
    queryKey: ["agents"],
    queryFn: agentsApi.list,
    staleTime: 60_000,
  });
  const canDuplicate = useCallback(
    (tileId: string) =>
      tiles.length < MAX_TILES &&
      (Boolean(tiles.find((tile) => tile.session_id === tileId)?.widget) ||
        sessionsById.has(tileId)),
    [sessionsById, tiles],
  );
  const canDuplicateRef = useRef(canDuplicate);
  canDuplicateRef.current = canDuplicate;
  const duplicateRef = useRef<(sourceId: string, placement: Rect | null) => void>(() => {});

  useEffect(() => {
    if (saving || workspace.updated_at === serverWorkspaceRef.current.updated_at) return;
    serverWorkspaceRef.current = workspace;
    latestLayoutRef.current = workspace.layout;
    latestTilesRef.current = tabTiles(workspace.layout, tabIdRef.current);
    setTiles(latestTilesRef.current);
  }, [saving, workspace]);

  useLayoutEffect(() => {
    // A half of a split keeps its grid whatever it is measured at, so there
    // is nothing to watch: the stacked layout answers a phone, not a narrow
    // pane the user made narrow on purpose.
    if (split) {
      setWide(true);
      return;
    }
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= WIDE_CONTAINER_PX);
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [split]);

  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

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

  /**
   * Duplicate a pane: same host, same folder, same skills, and the same agent
   * relaunched in the copy's shell — a second pane pointed at the same work,
   * not a second view of the same process. `placement` is where a ⌘-drag
   * dropped it; the menu passes null and takes whatever spot auto-place finds.
   *
   * A widget tile is pure layout, so its copy needs no round trip at all.
   */
  const duplicatePane = useCallback(
    async (sourceId: string, placement: Rect | null) => {
      const source = latestTilesRef.current.find((tile) => tile.session_id === sourceId);
      /** Commit the copy's tile, falling back to auto-place when the dropped
       *  rect no longer fits (the layout moved on while the session started). */
      const land = (tileId: string, widget?: TileWidget): boolean => {
        const current = latestTilesRef.current;
        const withWidget = (tiles: Tile[]): Tile[] =>
          widget
            ? tiles.map((tile) => (tile.session_id === tileId ? { ...tile, widget } : tile))
            : tiles;
        if (placement) {
          const candidate = [...current, { session_id: tileId, ...placement }];
          if (validate({ version: 3, tiles: candidate }).ok) {
            commitLayout(withWidget(candidate));
            return true;
          }
        }
        // No drop rect (the menu, not a drag): share the canvas out evenly
        // rather than halving whichever pane happens to be biggest.
        const added = addPaneTiles(current, tileId);
        if (!added) return false;
        commitLayout(withWidget(added));
        return true;
      };

      if (source?.widget) {
        if (!land(crypto.randomUUID(), source.widget)) {
          onErrorRef.current?.("This tab is full — close a window before duplicating another.");
        }
        return;
      }
      const session = sessionsById.get(sourceId);
      if (!session) return;
      try {
        // Skills are read at launch, so they have to travel with the create
        // call rather than being patched on afterwards.
        const access = await sessionAccess.get(sourceId).catch(() => null);
        const skillIds = access?.skills.map((skill) => skill.id) ?? [];
        // Awaited rather than read from the hook: a duplicate fired before
        // the registry query settles would silently copy an agent pane as a
        // bare shell. Failure falls back to the empty list it used to read.
        const definitions = await queryClient
          .ensureQueryData({ queryKey: ["agents"], queryFn: agentsApi.list })
          .catch(() => []);
        // The copy is created as the same type of window, so it is one even
        // before its agent has taken the foreground — and stays one if the
        // agent is later quit.
        const agent = sessionAgent(session, definitions);
        // A copy is the same kind of window in a conversation of its own.
        const conversation = agent ? newAgentConversationId(agent.kind) : null;
        const created = await sessionsApi.create({
          host_id: session.host_id,
          cwd: session.cwd,
          ...(agent && { agent_id: agent.id, agent_session_id: conversation }),
          ...(skillIds.length > 0 && { skill_ids: skillIds }),
        });
        if (agent) pendingLaunch.set(created.id, agentLaunchCommand(agent, conversation));
        if (!land(created.id)) {
          await sessionsApi.remove(created.id).catch(() => {});
          throw new Error("This tab is full — close a window before duplicating another.");
        }
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        setFocus(created.id, true);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
      }
    },
    [commitLayout, queryClient, sessionsById, setFocus],
  );
  duplicateRef.current = (sourceId, placement) => {
    void duplicatePane(sourceId, placement);
  };

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
    const elements = [...tileElementsRef.current.values()];
    for (const element of elements) {
      // Transition off before the transform goes. By now the committed
      // left/top already put the tile exactly where the transform was showing
      // it, so animating that offset back to zero would fling the pane a full
      // tile past its slot in the direction of travel and then walk it back.
      element.style.transition = "none";
      element.style.transform = "";
      element.style.removeProperty("--preview-width");
      element.style.removeProperty("--preview-height");
      element.removeAttribute("data-gesture-active");
    }
    // Flush the untransformed frame, then hand the transition back to the
    // class so the next layout change animates normally.
    if (elements.length > 0) void elements[0]?.offsetHeight;
    for (const element of elements) element.style.removeProperty("transition");
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.hidden = true;
      ghost.removeAttribute("data-clone");
    }
    const divider = dividerElementRef.current;
    if (divider) {
      divider.style.transform = "";
      divider.removeAttribute("data-dragging");
      dividerElementRef.current = null;
    }
    queryInPane(paneRootRef.current, "[data-launcher-fab]")?.removeAttribute("data-trash-hover");
    queryInPane(paneRootRef.current, "[data-workspace-newtab-ghost]")?.removeAttribute(
      "data-newtab-hover",
    );
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [paneRootRef]);

  const previewLayout = useCallback((gesture: GridGesture) => {
    const { preview, areaRect } = gesture;
    onPreviewTilesRef.current?.(preview);
    // A seam drag has no dragged tile: every pane it touches previews in place.
    const sessionId = draggedTileId(gesture);
    setLivePreview({ tiles: preview, draggedId: sessionId });
    // Over the bin the drop discards rather than places, so there is nothing
    // to outline — nor for a seam drag, which places nothing to begin with.
    const target =
      gesture.kind === "move" && gesture.discarding
        ? undefined
        : preview.find((tile) => tile.session_id === sessionId);
    const ghost = ghostRef.current;
    if (!ghost) return;
    if (!target) {
      ghost.hidden = true;
      return;
    }
    const rect = tilePixelRect(target, areaRect.width, areaRect.height);
    ghost.toggleAttribute("data-clone", sessionId === PENDING_TILE_ID);
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
      if (listeners.key) {
        document.removeEventListener("keydown", listeners.key);
        document.removeEventListener("keyup", listeners.key);
      }
      gestureListenersRef.current = { move: null, up: null, cancel: null, key: null };
      const cloning = gesture?.kind === "move" && gesture.clone !== null ? gesture : null;
      const clonePlacement =
        cloning?.preview.find((tile) => tile.session_id === PENDING_TILE_ID) ?? null;
      if (cloning && commit && clonePlacement) {
        // The copy is not a tile yet — it is a session that has to be created
        // first. Settle everything the drag displaced now, so the canvas holds
        // the shape the ghost promised, and let the copy land into the gap.
        const settled = cloning.preview.filter((tile) => tile.session_id !== PENDING_TILE_ID);
        if (!tilesEqual(cloning.before, settled)) flushSync(() => commitLayout(settled));
        const { x, y, w, h } = clonePlacement;
        duplicateRef.current(cloning.sessionId, { x, y, w, h });
      } else if (gesture && commit && gesture.kind === "move" && gesture.sourceTab) {
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
      setLivePreview(null);
      onPreviewTilesRef.current?.(null);
      onDraggingPaneRef.current?.(false);
      clearGestureStyles();
    },
    [clearGestureStyles, commitEnvelope, commitLayout],
  );

  /**
   * Dropped in the bin. A widget is pure layout, so it simply goes; a session
   * is a live process, so it is closed on the same terms as the pane menu's
   * "Close session" — asked for first, then killed.
   *
   * The tile leaves whichever tab holds it, not the one on screen: a drag that
   * crossed tabs and was carried back to the bin left the pane where it began.
   */
  const discardPane = useCallback(
    async (sessionId: string) => {
      const drop = () => {
        const tab = tabOfSession(latestLayoutRef.current, sessionId);
        if (!tab) return;
        commitEnvelope(
          withTabTiles(latestLayoutRef.current, tab.id, removeTile(tab.layout.tiles, sessionId)),
        );
      };
      const session = sessionsById.get(sessionId);
      // A widget tile, or a pane whose session is already gone: nothing to kill.
      if (!session) {
        drop();
        return;
      }
      const accepted = await confirm({
        title: `Close ${sessionTitle(session)}?`,
        body: "This kills the shell process and permanently removes the session.",
        confirmLabel: "Close session",
        destructive: true,
      });
      if (!accepted) return;
      try {
        await sessionsApi.remove(sessionId);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
        return;
      }
      drop();
      queryClient.removeQueries({ queryKey: ["session", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    [commitEnvelope, queryClient, sessionsById],
  );

  /**
   * Everything a move gesture derives from a pointer position: the dragged
   * thing's pixel transform, then either a dock preview (over a pane) or a
   * cell-snapped placement (over open canvas). Split out of the pointermove
   * handler because ⌘ going down or up has to re-derive all of it from the
   * pointer's last known position, with no pointer event in hand.
   */
  const applyMovePointer = useCallback(
    (gesture: MoveGesture, clientX: number, clientY: number) => {
      const draggedId = gesture.clone ? PENDING_TILE_ID : gesture.sessionId;
      const active = tileElementsRef.current.get(gesture.sessionId);
      // A duplicating drag leaves the source pane where it is — only the ghost
      // travels, which is what makes the copy read as a copy.
      if (active) {
        active.style.transform = gesture.clone
          ? ""
          : `translate3d(${clientX - gesture.startClientX}px, ${clientY - gesture.startClientY}px, 0)`;
      }
      // Aimed at the bin: the drop discards rather than places, so the pane in
      // hand goes on following the pointer and nothing else on the canvas moves.
      if (gesture.discarding) return;
      const cellWidth = gesture.areaRect.width / GRID_SIZE;
      const cellHeight = gesture.areaRect.height / GRID_SIZE;

      // Hovering another pane docks against its nearest edge (iTerm-style):
      // the target splits in half and the ghost claims the hovered side. While
      // duplicating, the source pane is a legal target too — ⌘-dragging a pane
      // onto its own edge is how you split it in two.
      const pointerX = (clientX - gesture.areaRect.left) / cellWidth;
      const pointerY = (clientY - gesture.areaRect.top) / cellHeight;
      const hovered = gesture.before.find(
        (tile) =>
          tile.session_id !== draggedId &&
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
        const docked = gesture.clone
          ? dockInsert(gesture.before, PENDING_TILE_ID, hovered.session_id, zone)
          : dockPane(gesture.before, gesture.sessionId, hovered.session_id, zone);
        if (docked) {
          gesture.lastDock = dockKey;
          // Leaving dock mode must recompute the cell path, whatever cell.
          gesture.lastX = Number.NaN;
          gesture.lastY = Number.NaN;
          gesture.preview = docked;
          previewLayout(gesture);
          return;
        }
        // The occupant is too small to halve. Rather than preview nothing —
        // which leaves the ghost sitting exactly on top of a pane that never
        // moves — fall through and place by cell, which shoves the occupants
        // aside to make the room.
      }
      gesture.lastDock = null;

      const x = Math.round((clientX - gesture.areaRect.left - gesture.pointerOffsetX) / cellWidth);
      const y = Math.round((clientY - gesture.areaRect.top - gesture.pointerOffsetY) / cellHeight);
      if (x === gesture.lastX && y === gesture.lastY) return;
      gesture.lastX = x;
      gesture.lastY = y;
      // A refused placement keeps the last previewed one. Falling back to
      // `before` would drop the copy's placeholder entirely, and a ghost with
      // nothing to point at is a ghost stranded wherever it last was.
      gesture.preview = gesture.clone
        ? (insertPane(gesture.before, PENDING_TILE_ID, gesture.clone.size, x, y) ?? gesture.preview)
        : movePane(gesture.before, gesture.sessionId, x, y);
      previewLayout(gesture);
    },
    [previewLayout],
  );

  /**
   * Flip a live move gesture between moving and duplicating. Returns whether
   * anything changed, so the caller only re-derives the preview when it did.
   * Refused when the copy has nowhere to go — a full tab, or a pane whose
   * session has not loaded — which leaves ⌘ as a plain modifier on a move.
   */
  const setCloneMode = useCallback((gesture: MoveGesture, wanted: boolean) => {
    if (wanted === (gesture.clone !== null)) return false;
    const source = gesture.before.find((tile) => tile.session_id === gesture.sessionId);
    if (wanted && (!source || !canDuplicateRef.current(gesture.sessionId))) return false;
    gesture.clone = wanted && source ? { size: { w: source.w, h: source.h } } : null;
    gesture.lastDock = null;
    // Force the next pointer application to recompute from scratch.
    gesture.lastX = Number.NaN;
    gesture.lastY = Number.NaN;
    gesture.preview = gesture.before;
    const element = tileElementsRef.current.get(gesture.sessionId);
    if (element) {
      element.style.removeProperty("--preview-width");
      element.style.removeProperty("--preview-height");
      // Entering: the source glides back to its own rect. Leaving: it is being
      // dragged again, so it must snap under the cursor rather than chase it.
      if (wanted) element.style.removeProperty("transition");
      else element.style.transition = "none";
    }
    document.body.style.cursor = wanted ? "copy" : "grabbing";
    return true;
  }, []);

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
        const under = document.elementFromPoint(event.clientX, event.clientY);
        // The launcher is the bin for the length of any drag. It floats over
        // the canvas, so aiming at it has to take the placement off the table
        // rather than dock the pane into whatever sits behind it.
        const overBin = Boolean(under?.closest?.("[data-launcher-fab]"));
        // The bin that will act is this half's own, whichever one the pointer
        // found: the drop discards a pane out of this grid.
        queryInPane(paneRootRef.current, "[data-launcher-fab]")?.toggleAttribute(
          "data-trash-hover",
          overBin,
        );
        if (overBin !== gesture.discarding) {
          gesture.discarding = overBin;
          // Either direction, the placement has to be derived again from here.
          gesture.lastDock = null;
          gesture.lastX = Number.NaN;
          gesture.lastY = Number.NaN;
          if (overBin) {
            gesture.preview = gesture.before;
            previewLayout(gesture);
          }
        }
        // Hovering another tab in the strip for a beat switches the view to
        // it mid-drag; the tabId-change effect below re-seeds the gesture so
        // the pane is carried into the newly visible grid. A duplicating drag
        // stays home: the copy belongs beside the pane it came from.
        const overTab = gesture.clone ? null : ownTabAt(under, workspaceIdRef.current);
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
        // The strip's open ground is the one tab that does not exist yet:
        // resting there lights a "New tab" chip at the end of the strip, and
        // the drop makes that tab and carries the pane into it. A duplicating
        // drag stays home for the same reason it ignores the tabs themselves,
        // and a full envelope has no chip to offer. Stamped on the chip
        // directly, the same wiring as the launcher's bin morph above, so a
        // live gesture never re-renders React.
        const overStripGround =
          !gesture.clone &&
          !overBin &&
          latestLayoutRef.current.tabs.length < MAX_TABS &&
          ownStripGroundAt(under, workspaceIdRef.current);
        queryInPane(paneRootRef.current, "[data-workspace-newtab-ghost]")?.toggleAttribute(
          "data-newtab-hover",
          overStripGround,
        );
        setCloneMode(gesture, wantsDuplicate(event));
        applyMovePointer(gesture, event.clientX, event.clientY);
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
    [applyMovePointer, paneRootRef, previewLayout, setCloneMode],
  );

  const onGestureUp = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (gesture?.kind === "move" && gesture.discarding) {
        // Into the bin. A copy exists only as a placeholder, so letting the
        // gesture fall away is the whole of discarding it; a pane that is
        // already on the canvas has to be closed.
        const { sessionId, clone } = gesture;
        finishGesture(false);
        if (!clone) void discardPane(sessionId);
        return;
      }
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const overTab = ownTabAt(under, workspaceIdRef.current);
      if (gesture?.kind === "move" && !gesture.clone && overTab && overTab !== tabIdRef.current) {
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
      if (
        gesture?.kind === "move" &&
        !gesture.clone &&
        latestLayoutRef.current.tabs.length < MAX_TABS &&
        ownStripGroundAt(under, workspaceIdRef.current)
      ) {
        // Dropped on the strip's open ground — the chip's promise: one
        // envelope write makes a fresh tab and moves the pane into it, then
        // the view follows, the same shape as dropping on an existing tab.
        const layout = latestLayoutRef.current;
        const newTabId = crypto.randomUUID();
        const added = addTab(layout, newTabId, nextTabName(layout));
        const moved = added ? moveSessionToTab(added, gesture.sessionId, newTabId) : null;
        finishGesture(false);
        if (moved) {
          flushSync(() => commitEnvelope(moved));
          onSwitchTabRef.current?.(newTabId);
        }
        return;
      }
      finishGesture(true);
    },
    [commitEnvelope, discardPane, finishGesture],
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
          setTiles(tabTiles(latestLayoutRef.current, tabId));
          return;
        }
        gesture.sourceTab ??= { tabId: originTabId, tiles: gesture.before };
        const seeded = [...placed.tiles, { ...dragged, ...placed.tile }];
        gesture.before = seeded;
        gesture.preview = seeded;
        gesture.lastX = placed.tile.x;
        gesture.lastY = placed.tile.y;
        gesture.lastDock = null;
        setTiles(seeded);
        // Reads the element before that render lands, which is fine: the only
        // one touched is the pane being carried, and it keeps its key across
        // the change, so React hands the same node back.
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
      setTiles(latestTilesRef.current);
      previewLayout(gesture);
      return;
    }
    if (gesture) finishGesture(false);
    setTiles(latestTilesRef.current);
  }, [finishGesture, previewLayout, tabId]);

  /** Escape abandons any gesture. ⌘ down or up mid-drag, with the pointer
   *  parked: re-derive from where it last was, so the ghost flips to a copy
   *  without waiting for a wiggle. */
  const onGestureKey = useCallback(
    (event: KeyboardEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishGesture(false);
        return;
      }
      if (gesture.kind !== "move") return;
      if (!setCloneMode(gesture, wantsDuplicate(event))) return;
      applyMovePointer(gesture, gesture.lastClientX, gesture.lastClientY);
    },
    [applyMovePointer, finishGesture, setCloneMode],
  );

  const installGestureListeners = useCallback(() => {
    gestureListenersRef.current = {
      move: onGestureMove,
      up: onGestureUp,
      cancel: onGestureCancel,
      key: onGestureKey,
    };
    document.addEventListener("pointermove", onGestureMove, { passive: false });
    document.addEventListener("pointerup", onGestureUp, { once: true });
    document.addEventListener("pointercancel", onGestureCancel, { once: true });
    document.addEventListener("keydown", onGestureKey);
    document.addEventListener("keyup", onGestureKey);
  }, [onGestureCancel, onGestureKey, onGestureMove, onGestureUp]);

  const beginMove = useCallback(
    (sessionId: string, startClientX: number, startClientY: number, duplicating: boolean) => {
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
        clone: null,
        discarding: false,
        before,
        preview: before,
        areaRect,
      };
      gestureRef.current = gesture;
      onDraggingPaneRef.current?.(true);
      tileElement.dataset.gestureActive = "true";
      tileElement.style.transition = "none";
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setFocus(sessionId);
      // Held before the drag crossed the threshold, it still means duplicate.
      setCloneMode(gesture, duplicating);
      previewLayout(gesture);
      installGestureListeners();
    },
    [installGestureListeners, previewLayout, setCloneMode, setFocus],
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
   * the pointer has travelled far enough to rule out a click.
   */
  const startMove = useCallback(
    (sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || event.pointerType === "touch") return;
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
        beginMove(sessionId, clientX, clientY, wantsDuplicate(moveEvent));
      };
      const armed: ArmedMove = { sessionId, clientX, clientY, move: onMove, end: disarmMove };
      armedMoveRef.current = armed;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", disarmMove, { once: true });
      document.addEventListener("pointercancel", disarmMove, { once: true });
    },
    [beginMove, disarmMove, finePointer, wide],
  );

  const startResize = useCallback(
    (sessionId: string, edges: ResizeEdges, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || event.pointerType === "touch") return;
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
    [finePointer, installGestureListeners, previewLayout, setFocus, wide],
  );

  const startDividerDrag = useCallback(
    (divider: GridDivider, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || event.pointerType === "touch") return;
      const area = areaRef.current;
      if (!area) return;
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget;
      const before = latestTilesRef.current;
      dividerElementRef.current = element;
      element.dataset.dragging = "true";
      const gesture: DividerGesture = {
        kind: "divider",
        divider,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastLine: divider.line,
        before,
        preview: before,
        areaRect: area.getBoundingClientRect(),
      };
      gestureRef.current = gesture;
      for (const id of [...divider.before, ...divider.after]) {
        const tileElement = tileElementsRef.current.get(id);
        if (tileElement) tileElement.style.transition = "none";
      }
      document.body.style.cursor = divider.axis === "vertical" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      previewLayout(gesture);
      installGestureListeners();
    },
    [finePointer, installGestureListeners, previewLayout, wide],
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
      if (listeners.key) {
        document.removeEventListener("keydown", listeners.key);
        document.removeEventListener("keyup", listeners.key);
      }
      gestureListenersRef.current = { move: null, up: null, cancel: null, key: null };
      disarmMove();
      clearGestureStyles();
      // A preview left standing outlives this grid: it is held above us, and a
      // grid mounted back into it would open on a layout nobody is dragging.
      onPreviewTilesRef.current?.(null);
      onDraggingPaneRef.current?.(false);
    },
    [clearGestureStyles, disarmMove],
  );

  useEffect(() => {
    // Only the half being worked in listens at all, rather than every half
    // listening and filtering: two grids on the document answer one Alt+2
    // with two navigations and walk the focus through both their panes. The
    // whole window is the active half when it holds a single workspace, so
    // this is the same registration it has always been.
    if (!paneActive) return;
    // Which chord this is depends on the keyboard in front of the person, not
    // on the pane: on a Mac ⌥ is how the shell moves a word at a time, so the
    // app asks for ⌃⌥ or ⌘⌥ wherever something is typing. `@/lib/keyboard-chords`
    // holds the whole rule and why.
    const apple = detectAppleModifiers();
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = gridShortcut(event, {
        apple,
        textHasKey: keystrokeBelongsToText(event.target),
      });
      if (!shortcut) return;
      if (shortcut.kind === "workspace") {
        const ordered = [...(allWorkspacesQ.data ?? [])].sort((a, b) => a.position - b.position);
        const target = ordered[shortcut.position - 1];
        if (target && target.id !== workspace.id) {
          event.preventDefault();
          event.stopPropagation();
          router.push(`/w/${target.id}`);
        }
        return;
      }
      if (orderedIds.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = focusedId ? orderedIds.indexOf(focusedId) : -1;
      const index =
        current < 0
          ? 0
          : (current + (shortcut.forward ? 1 : orderedIds.length - 1)) % orderedIds.length;
      setFocus(orderedIds[index] ?? null, true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [allWorkspacesQ.data, focusedId, orderedIds, paneActive, router, setFocus, workspace.id]);

  /** Re-root a file widget, keeping its rect and its place in the tab. */
  const changeWidgetPath = useCallback(
    (tileId: string, path: string) =>
      commitLayout(
        latestTilesRef.current.map((tile) =>
          tile.session_id === tileId && tile.widget
            ? { ...tile, widget: { ...tile.widget, path } }
            : tile,
        ),
      ),
    [commitLayout],
  );

  const removeFromWorkspace = useCallback(
    (sessionId: string) => commitLayout(removeTile(latestTilesRef.current, sessionId)),
    [commitLayout],
  );

  /** Swap a session pane for a file explorer rooted at its folder: the tile
   *  keeps its rect, the session is closed (confirmed first). */
  const convertToFiles = useCallback(
    async (sessionId: string) => {
      const session = sessionsById.get(sessionId);
      if (!session) return;
      const accepted = await confirm({
        title: `Replace ${sessionTitle(session)} with a file explorer?`,
        body: "The session will be closed and its running process killed; a file explorer for its folder takes over the window.",
        confirmLabel: "Replace window",
        destructive: true,
      });
      if (!accepted) return;
      commitLayout(
        latestTilesRef.current.map((tile) =>
          tile.session_id === sessionId
            ? {
                ...tile,
                session_id: crypto.randomUUID(),
                widget: { kind: "files" as const, host_id: session.host_id, path: session.cwd },
              }
            : tile,
        ),
      );
      try {
        await sessionsApi.remove(sessionId);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
      }
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    [commitLayout, queryClient, sessionsById],
  );

  /** Swap a session pane for a fresh shell on another host: the tile keeps
   *  its rect, the old session is closed (confirmed first) and the new shell
   *  starts in the picked host's home folder. */
  const moveToHost = useCallback(
    async (sessionId: string, host: Host) => {
      const session = sessionsById.get(sessionId);
      if (!session || session.host_id === host.id) return;
      const accepted = await confirm({
        title: `Move ${sessionTitle(session)} to ${host.name}?`,
        body: `This shell will be closed and its running process killed; a new shell starts in your home folder on ${host.name}.`,
        confirmLabel: "Move window",
        destructive: true,
      });
      if (!accepted) return;
      let created: Session;
      try {
        // Created before anything is torn down, so a failure (host dropped
        // offline, say) leaves the pane exactly as it was.
        created = await sessionsApi.create({ host_id: host.id, cwd: "~" });
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
        return;
      }
      // Seed the cache so the swapped tile finds its session immediately
      // instead of flashing "missing" until the next sessions poll.
      queryClient.setQueryData<Session[]>(["sessions"], (current) =>
        current ? [...current, created] : [created],
      );
      commitLayout(
        latestTilesRef.current.map((tile) =>
          tile.session_id === sessionId ? { ...tile, session_id: created.id } : tile,
        ),
      );
      setFocus(created.id, true);
      try {
        await sessionsApi.remove(sessionId);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
      }
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    [commitLayout, queryClient, sessionsById, setFocus],
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

  const expandPane = useCallback(
    (tileId: string) => {
      const current = latestTilesRef.current;
      const expanded = expandTileIntoEmptySpace(current, tileId);
      if (!tilesEqual(current, expanded)) commitLayout(expanded);
    },
    [commitLayout],
  );

  const canGesture = wide && finePointer;

  // What the panes are showing right now: a gesture of this grid's own while
  // one is running, else a pane being dragged out of the launcher, else the
  // committed layout.
  const shownTiles = livePreview?.tiles ?? previewTiles ?? tiles;

  const renderPaneSlots = () => {
    if (wide) {
      return (
        <div className="absolute inset-0 overflow-hidden">
          {tiles.map((tile) => {
            // The tile riding the pointer keeps its resting rect: it is offset
            // by a transform, which tracks the cursor rather than the cell the
            // preview has snapped it to.
            const rect =
              tile.session_id === livePreview?.draggedId
                ? tile
                : (shownTiles.find((other) => other.session_id === tile.session_id) ?? tile);
            return (
              <div
                key={tile.session_id}
                ref={(element) => {
                  if (element) tileElementsRef.current.set(tile.session_id, element);
                  else tileElementsRef.current.delete(tile.session_id);
                }}
                data-grid-tile={tile.session_id}
                style={tileStyle(rect)}
                className={cn(
                  // Position and size ease together: a preview that moves a
                  // pane but snaps its size reads as a glitch, not as the pane
                  // making room. The pane under the pointer opts out with an
                  // inline `transition: none` for the length of the gesture.
                  "absolute z-10 min-h-0 min-w-0 border-pane-divider will-change-transform transition-[transform,left,top,width,height] duration-150 ease-swift",
                  // A divider only where two panes actually meet edge to edge;
                  // edges facing empty canvas (or the border) draw nothing.
                  shownTiles.some(
                    (other) =>
                      other.session_id !== rect.session_id &&
                      other.x === rect.x + rect.w &&
                      other.y < rect.y + rect.h &&
                      rect.y < other.y + other.h,
                  ) && "border-r",
                  shownTiles.some(
                    (other) =>
                      other.session_id !== rect.session_id &&
                      other.y === rect.y + rect.h &&
                      other.x < rect.x + rect.w &&
                      rect.x < other.x + other.w,
                  ) && "border-b",
                )}
              >
                {tile.widget ? (
                  <WidgetPane
                    tile={tile}
                    widget={tile.widget}
                    focused={focusedId === tile.session_id}
                    paneCount={tiles.length}
                    canDrag={canGesture}
                    canDuplicate={canDuplicate(tile.session_id)}
                    onFocus={(id) => setFocus(id)}
                    onMoveStart={startMove}
                    onExpand={canGesture ? expandPane : undefined}
                    onDuplicate={(id) => duplicateRef.current(id, null)}
                    onChangePath={changeWidgetPath}
                    onRemove={removeFromWorkspace}
                  />
                ) : (
                  <PaneSlot sessionId={tile.session_id} stacked={false} register={registerSlot} />
                )}
                {canGesture && (
                  <TileResizeHandles
                    sessionId={tile.session_id}
                    title={
                      tile.widget
                        ? widgetTitle(tile.widget)
                        : (() => {
                            const session = sessionsById.get(tile.session_id);
                            return session ? sessionTitle(session) : "window";
                          })()
                    }
                    onStart={startResize}
                  />
                )}
              </div>
            );
          })}
          {openings.map((rect) => (
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
                tabId={tabId}
                placement={rect}
                // The trigger is the whole opening, so anchor to the click.
                anchor="pointer"
                trigger={
                  <button
                    type="button"
                    aria-label="Add a window here"
                    className={cn(
                      "group/opening grid size-full place-items-center rounded-md border border-dashed text-muted-foreground transition-colors hover:border-border hover:bg-background/80",
                      openingsLit ? "border-border/60" : "border-transparent",
                      // Lit up while a pane dragged off the launcher hovers it.
                      "data-[drop-target]:border-ring/70 data-[drop-target]:bg-background/80",
                    )}
                  >
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-xs transition-opacity group-hover/opening:opacity-100 group-data-[drop-target]/opening:opacity-100",
                        !openingsLit && "opacity-0",
                      )}
                    >
                      <Plus className="size-4" aria-hidden />
                      Add a window
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
                      ? "Resize the windows on either side"
                      : "Resize the windows above and below"
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
            data-grid-ghost
            className="group/ghost pointer-events-none absolute z-50 grid place-items-center border-2 border-dashed border-ring bg-ring/10"
          >
            {/* Only a ⌘-drag shows a label: an ordinary move's ghost is
                self-explanatory, a copy's is not. */}
            <span className="hidden items-center gap-1.5 rounded-full bg-ring px-2.5 py-1 text-xs font-medium text-background shadow-sm group-data-[clone]/ghost:inline-flex">
              <Copy className="size-3.5" aria-hidden />
              Duplicate
            </span>
          </div>
        </div>
      );
    }
    return (
      <div
        data-pane-stack
        className="flex min-h-0 flex-1 flex-col gap-(--pane-gap) overflow-y-auto p-[calc(var(--pane-gap)/2)]"
      >
        {orderedIds.map((sessionId) => {
          const widget = tiles.find((tile) => tile.session_id === sessionId)?.widget;
          return (
            <div
              key={sessionId}
              // Reading height is a floor, not a size: a stack short of the
              // fold grows to spend the whole column, so a lone pane runs
              // full-height instead of perching above a void. Past the fold
              // the floor wins and the stack scrolls.
              className="min-h-[55dvh] w-full shrink-0 grow overflow-hidden rounded-md border border-pane-divider"
            >
              {widget ? (
                <WidgetPane
                  tile={{ session_id: sessionId, x: 0, y: 0, w: GRID_SIZE, h: GRID_SIZE }}
                  widget={widget}
                  focused={focusedId === sessionId}
                  paneCount={tiles.length}
                  canDrag={false}
                  onFocus={(id) => setFocus(id)}
                  onMoveStart={() => {}}
                  onChangePath={changeWidgetPath}
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
          <div className="relative size-full overflow-hidden">
            {/* A wide, faint ember pool under the state, so an empty tab reads
                as a lit stage rather than a void. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_48%_at_50%_53%,color-mix(in_oklab,var(--color-brand-accent)_10%,transparent),transparent_72%)]"
            />
            <EmptyState
              icon={<Trident className="mb-3 size-10" />}
              iconPlate={false}
              title="Open your first window"
              body="The circle is empty. Spawn something into it."
              className="relative size-full"
              action={
                <div className="flex flex-col items-center gap-4">
                  {/* Where a window lands, above the rule; what lands there,
                      below it. */}
                  <TabHomeButton
                    workspace={workspace}
                    tabId={tabId}
                    onError={(message) => onError?.(message ?? "")}
                  />
                  <hr className="h-px w-full max-w-xl border-0 bg-border" />
                  {/* Every choice the ⋯ cascade offers, one click deep: an
                      empty tab is the one place with room to spell them out. */}
                  <NewSessionLozenges
                    mode="session"
                    workspaceId={workspace.id}
                    tabId={tabId}
                    placement={FIRST_WINDOW}
                    className="max-w-xl"
                    onCreated={({ sessionId }) => {
                      // Only the half the address bar is about may move it.
                      // The same push from the other half of a split would
                      // send the URL to a workspace nobody asked to open, and
                      // the pane it just made would arrive there instead.
                      if (routed) router.push(`/w/${workspace.id}?focus=${sessionId}`);
                      else setFocus(sessionId, true);
                    }}
                  />
                </div>
              }
            />
          </div>
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
          canDuplicate={canDuplicate(sessionId)}
          canMoveUp={!wide && index > 0}
          canMoveDown={!wide && index < orderedIds.length - 1}
          onFocus={(id) => setFocus(id)}
          onMoveStart={startMove}
          onExpand={canGesture ? expandPane : undefined}
          onDuplicate={(id) => duplicateRef.current(id, null)}
          onMoveUp={(id) => moveMobile(id, -1)}
          onMoveDown={(id) => moveMobile(id, 1)}
          onRemoveFromWorkspace={removeFromWorkspace}
          onConvertToFiles={(id) => void convertToFiles(id)}
          onMoveToHost={(id, host) => void moveToHost(id, host)}
          registerHandle={registerHandle}
          onError={onError ?? (() => {})}
        />
      ))}
    </div>
  );
}
