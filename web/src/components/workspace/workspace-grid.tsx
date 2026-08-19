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
  GRID_SIZE,
  move as moveTile,
  readingOrder,
  remove as removeTile,
  resize as resizeTile,
  type Tile,
} from "@/lib/grid";
import { cn } from "@/lib/utils";
import { NewSessionMenu } from "./new-session-menu";
import { type PaneResizeEdge, type PaneSlotTarget, SessionPane } from "./session-pane";
import {
  moveIdInOrder,
  moveSwapTarget,
  repackMobileTiles,
  tilePixelRect,
} from "./workspace-grid-helpers";

const WIDE_CONTAINER_PX = 768;

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
  before: Tile[];
  preview: Tile[];
  areaRect: DOMRect;
  gap: number;
};

type ResizeGesture = {
  kind: "resize";
  edge: PaneResizeEdge;
  sessionId: string;
  startClientX: number;
  startClientY: number;
  lastW: number;
  lastH: number;
  before: Tile[];
  preview: Tile[];
  areaRect: DOMRect;
  gap: number;
};

type GridGesture = MoveGesture | ResizeGesture;

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
    ? {
        left: "calc(var(--pane-gap) / 2)",
        top: "calc(var(--pane-gap) / 2)",
        width: "calc(100% - var(--pane-gap))",
        height: "calc(100% - var(--pane-gap))",
      }
    : {
        left: `calc(${(tile.x / GRID_SIZE) * 100}% + var(--pane-gap) / 2)`,
        top: `calc(${(tile.y / GRID_SIZE) * 100}% + var(--pane-gap) / 2)`,
        width: `calc(${(tile.w / GRID_SIZE) * 100}% - var(--pane-gap))`,
        height: `calc(${(tile.h / GRID_SIZE) * 100}% - var(--pane-gap))`,
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
  sessions,
  initialFocusId,
  onFocusChange,
  onSavingChange,
  onError,
}: {
  workspace: Workspace;
  sessions: Session[];
  initialFocusId?: string | null;
  onFocusChange?: (sessionId: string | null) => void;
  onSavingChange?: (saving: boolean) => void;
  onError?: (message: string | null) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const areaRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const tileElementsRef = useRef(new Map<string, HTMLDivElement>());
  const handleGettersRef = useRef(new Map<string, HandleGetter>());
  const gestureRef = useRef<GridGesture | null>(null);
  const gestureListenersRef = useRef<{
    move: ((event: PointerEvent) => void) | null;
    up: (() => void) | null;
    cancel: (() => void) | null;
  }>({ move: null, up: null, cancel: null });
  const [tiles, setTiles] = useState<Tile[]>(workspace.layout.tiles);
  const [slots, setSlots] = useState<SlotRegistry>({});
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches,
  );
  const [finePointer, setFinePointer] = useState(
    () => typeof window === "undefined" || window.matchMedia("(pointer: fine)").matches,
  );
  const [focusedId, setFocusedId] = useState<string | null>(
    initialFocusId && workspace.layout.tiles.some((tile) => tile.session_id === initialFocusId)
      ? initialFocusId
      : (readingOrder(workspace.layout.tiles)[0] ?? null),
  );
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  const latestTilesRef = useRef(tiles);
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
  const allWorkspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    staleTime: 30_000,
  });

  useEffect(() => onSavingChange?.(saving), [onSavingChange, saving]);

  useEffect(() => {
    if (saving || workspace.updated_at === serverWorkspaceRef.current.updated_at) return;
    serverWorkspaceRef.current = workspace;
    latestTilesRef.current = workspace.layout.tiles;
    setTiles(workspace.layout.tiles);
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

  const commitLayout = useCallback(
    (nextTiles: Tile[]) => {
      latestTilesRef.current = nextTiles;
      setTiles(nextTiles);
      revisionRef.current += 1;
      setRevision(revisionRef.current);
      setSaving(true);
      onError?.(null);
      const current =
        queryClient.getQueryData<Workspace>(["workspace", workspace.id]) ??
        serverWorkspaceRef.current;
      writeWorkspaceCaches({ ...current, layout: { version: 2, tiles: nextTiles } });
    },
    [onError, queryClient, workspace.id, writeWorkspaceCaches],
  );

  useEffect(() => {
    if (revision === 0) return;
    const submittedRevision = revision;
    const submittedTiles = latestTilesRef.current;
    const submittedEpoch = persistenceEpochRef.current;
    const timer = window.setTimeout(() => {
      saveChainRef.current = saveChainRef.current.then(async () => {
        if (submittedEpoch !== persistenceEpochRef.current) return;
        try {
          const saved = await workspaces.update(workspace.id, {
            layout: { version: 2, tiles: submittedTiles },
          });
          if (submittedEpoch !== persistenceEpochRef.current) return;
          serverWorkspaceRef.current = saved;
          persistedRevisionRef.current = Math.max(persistedRevisionRef.current, submittedRevision);
          writeWorkspaceCaches(saved);
          if (revisionRef.current === submittedRevision) {
            latestTilesRef.current = saved.layout.tiles;
            setTiles(saved.layout.tiles);
            setSaving(false);
          } else {
            writeWorkspaceCaches({
              ...saved,
              layout: { version: 2, tiles: latestTilesRef.current },
            });
          }
        } catch (error) {
          if (submittedEpoch !== persistenceEpochRef.current) return;
          persistenceEpochRef.current += 1;
          persistedRevisionRef.current = revisionRef.current;
          const rollback = serverWorkspaceRef.current;
          latestTilesRef.current = rollback.layout.tiles;
          setTiles(rollback.layout.tiles);
          writeWorkspaceCaches(rollback);
          setSaving(false);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [onError, revision, workspace.id, writeWorkspaceCaches]);

  useEffect(
    () => () => {
      if (revisionRef.current <= persistedRevisionRef.current) return;
      saveChainRef.current = saveChainRef.current.then(async () => {
        try {
          await workspaces.update(workspace.id, {
            layout: { version: 2, tiles: latestTilesRef.current },
          });
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

  const readGap = useCallback(() => {
    const value = areaRef.current
      ? Number.parseFloat(getComputedStyle(areaRef.current).getPropertyValue("--pane-gap"))
      : Number.NaN;
    return Number.isFinite(value) ? value : 6;
  }, []);

  const clearGestureStyles = useCallback(() => {
    for (const element of tileElementsRef.current.values()) {
      element.style.transform = "";
      element.style.removeProperty("--preview-width");
      element.style.removeProperty("--preview-height");
      element.style.removeProperty("transition");
      element.removeAttribute("data-swap-target");
      element.removeAttribute("data-gesture-active");
    }
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.hidden = true;
      ghost.removeAttribute("data-swap");
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const previewLayout = useCallback((gesture: GridGesture, swapTarget: string | null) => {
    const { before, preview, sessionId, areaRect, gap } = gesture;
    for (const next of preview) {
      const element = tileElementsRef.current.get(next.session_id);
      const previous = before.find((tile) => tile.session_id === next.session_id);
      if (!element || !previous) continue;
      element.toggleAttribute("data-swap-target", next.session_id === swapTarget);
      if (next.session_id === sessionId) continue;
      const from = tilePixelRect(previous, areaRect.width, areaRect.height, gap);
      const to = tilePixelRect(next, areaRect.width, areaRect.height, gap);
      element.style.transform = `translate3d(${to.left - from.left}px, ${to.top - from.top}px, 0)`;
      element.style.setProperty("--preview-width", `${to.width}px`);
      element.style.setProperty("--preview-height", `${to.height}px`);
    }
    const target = preview.find((tile) => tile.session_id === sessionId);
    const ghost = ghostRef.current;
    if (!target || !ghost) return;
    const rect = tilePixelRect(target, areaRect.width, areaRect.height, gap);
    ghost.hidden = false;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.toggleAttribute("data-swap", swapTarget !== null);
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
      if (gesture && commit && !tilesEqual(gesture.before, gesture.preview)) {
        flushSync(() => commitLayout(gesture.preview));
      }
      clearGestureStyles();
    },
    [clearGestureStyles, commitLayout],
  );

  const onGestureMove = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      event.preventDefault();
      const active = tileElementsRef.current.get(gesture.sessionId);
      const original = gesture.before.find((tile) => tile.session_id === gesture.sessionId);
      if (!active || !original) return;

      const dx = event.clientX - gesture.startClientX;
      const dy = event.clientY - gesture.startClientY;
      if (gesture.kind === "move") {
        active.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        const cellWidth = gesture.areaRect.width / GRID_SIZE;
        const cellHeight = gesture.areaRect.height / GRID_SIZE;
        const x = Math.round(
          (event.clientX - gesture.areaRect.left - gesture.pointerOffsetX) / cellWidth,
        );
        const y = Math.round(
          (event.clientY - gesture.areaRect.top - gesture.pointerOffsetY) / cellHeight,
        );
        if (x === gesture.lastX && y === gesture.lastY) return;
        gesture.lastX = x;
        gesture.lastY = y;
        gesture.preview = moveTile(gesture.before, gesture.sessionId, x, y);
        previewLayout(gesture, moveSwapTarget(gesture.before, gesture.preview, gesture.sessionId));
        return;
      }

      const cellWidth = gesture.areaRect.width / GRID_SIZE;
      const cellHeight = gesture.areaRect.height / GRID_SIZE;
      const adjustsWidth = gesture.edge === "east" || gesture.edge === "southeast";
      const adjustsHeight = gesture.edge === "south" || gesture.edge === "southeast";
      const requestedW = adjustsWidth ? Math.round(original.w + dx / cellWidth) : original.w;
      const requestedH = adjustsHeight ? Math.round(original.h + dy / cellHeight) : original.h;
      const minWidth = (3 / GRID_SIZE) * gesture.areaRect.width - gesture.gap;
      const minHeight = (3 / GRID_SIZE) * gesture.areaRect.height - gesture.gap;
      const maxWidth =
        ((GRID_SIZE - original.x) / GRID_SIZE) * gesture.areaRect.width - gesture.gap;
      const maxHeight =
        ((GRID_SIZE - original.y) / GRID_SIZE) * gesture.areaRect.height - gesture.gap;
      const originalRect = tilePixelRect(
        original,
        gesture.areaRect.width,
        gesture.areaRect.height,
        gesture.gap,
      );
      if (adjustsWidth) {
        active.style.setProperty(
          "--preview-width",
          `${Math.min(maxWidth, Math.max(minWidth, originalRect.width + dx))}px`,
        );
      }
      if (adjustsHeight) {
        active.style.setProperty(
          "--preview-height",
          `${Math.min(maxHeight, Math.max(minHeight, originalRect.height + dy))}px`,
        );
      }
      if (requestedW === gesture.lastW && requestedH === gesture.lastH) return;
      gesture.lastW = requestedW;
      gesture.lastH = requestedH;
      gesture.preview = resizeTile(gesture.before, gesture.sessionId, requestedW, requestedH);
      previewLayout(gesture, null);
    },
    [previewLayout],
  );

  const onGestureUp = useCallback(() => finishGesture(true), [finishGesture]);
  const onGestureCancel = useCallback(() => finishGesture(false), [finishGesture]);

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

  const startMove = useCallback(
    (sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || zoomedId || event.pointerType === "touch") return;
      const area = areaRef.current;
      const tileElement = tileElementsRef.current.get(sessionId);
      const tile = latestTilesRef.current.find((item) => item.session_id === sessionId);
      if (!area || !tileElement || !tile) return;
      event.preventDefault();
      event.stopPropagation();
      const areaRect = area.getBoundingClientRect();
      const tileRect = tileElement.getBoundingClientRect();
      const before = latestTilesRef.current;
      const gesture: MoveGesture = {
        kind: "move",
        sessionId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        pointerOffsetX: event.clientX - tileRect.left,
        pointerOffsetY: event.clientY - tileRect.top,
        lastX: tile.x,
        lastY: tile.y,
        before,
        preview: before,
        areaRect,
        gap: readGap(),
      };
      gestureRef.current = gesture;
      tileElement.dataset.gestureActive = "true";
      tileElement.style.transition = "none";
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setFocus(sessionId);
      previewLayout(gesture, null);
      installGestureListeners();
    },
    [finePointer, installGestureListeners, previewLayout, readGap, setFocus, wide, zoomedId],
  );

  const startResize = useCallback(
    (sessionId: string, edge: PaneResizeEdge, event: ReactPointerEvent<HTMLElement>) => {
      if (!wide || !finePointer || zoomedId || event.pointerType === "touch") return;
      const area = areaRef.current;
      const tileElement = tileElementsRef.current.get(sessionId);
      const tile = latestTilesRef.current.find((item) => item.session_id === sessionId);
      if (!area || !tileElement || !tile) return;
      event.preventDefault();
      event.stopPropagation();
      const before = latestTilesRef.current;
      const gesture: ResizeGesture = {
        kind: "resize",
        edge,
        sessionId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastW: tile.w,
        lastH: tile.h,
        before,
        preview: before,
        areaRect: area.getBoundingClientRect(),
        gap: readGap(),
      };
      gestureRef.current = gesture;
      tileElement.dataset.gestureActive = "true";
      tileElement.style.transition = "none";
      document.body.style.cursor =
        edge === "east" ? "col-resize" : edge === "south" ? "row-resize" : "nwse-resize";
      document.body.style.userSelect = "none";
      setFocus(sessionId);
      previewLayout(gesture, null);
      installGestureListeners();
    },
    [finePointer, installGestureListeners, previewLayout, readGap, setFocus, wide, zoomedId],
  );

  useEffect(
    () => () => {
      document.removeEventListener("pointermove", onGestureMove);
      document.removeEventListener("pointerup", onGestureUp);
      document.removeEventListener("pointercancel", onGestureCancel);
      clearGestureStyles();
    },
    [clearGestureStyles, onGestureCancel, onGestureMove, onGestureUp],
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
                  "absolute z-10 min-h-0 min-w-0 will-change-transform transition-transform duration-150 ease-swift",
                  "data-[swap-target]:z-20 data-[swap-target]:ring-2 data-[swap-target]:ring-warning",
                  zoomedId && !zoomed && "hidden",
                  zoomed && "z-30",
                )}
              >
                <PaneSlot sessionId={tile.session_id} stacked={false} register={registerSlot} />
              </div>
            );
          })}
          <div
            ref={ghostRef}
            hidden
            aria-hidden
            className="pointer-events-none absolute z-40 rounded-md border-2 border-dashed border-ring bg-ring/10 data-[swap]:border-warning data-[swap]:bg-warning-soft"
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-(--pane-gap) overflow-y-auto p-[calc(var(--pane-gap)/2)]">
        {orderedIds.map((sessionId) => (
          <div key={sessionId} className="min-h-[55dvh] w-full shrink-0">
            <PaneSlot sessionId={sessionId} stacked register={registerSlot} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div ref={areaRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {tiles.length === 0 ? (
          <EmptyState
            icon={<Plus />}
            title="Start with a shell"
            body="Choose a host and folder. The session appears here as soon as it is created."
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

      {orderedIds.map((sessionId, index) => (
        <SessionPane
          key={sessionId}
          sessionId={sessionId}
          session={sessionsById.get(sessionId)}
          slot={slots[sessionId]}
          focused={focusedId === sessionId}
          zoomed={zoomedId === sessionId}
          paneCount={tiles.length}
          canDrag={wide && finePointer && zoomedId === null}
          canMoveUp={!wide && index > 0}
          canMoveDown={!wide && index < orderedIds.length - 1}
          onFocus={(id) => setFocus(id)}
          onToggleZoom={(id) => setZoomedId((current) => (current === id ? null : id))}
          onMoveStart={startMove}
          onResizeStart={startResize}
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
