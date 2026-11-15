"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { workspaces } from "@/lib/api";
import {
  clampSizes,
  columnCapacity,
  columnFloor,
  dragSeam,
  drawnColumns,
  drawnShares,
  MAX_MEMBERS,
  SEAM_STEP,
  seamPosition,
} from "@/lib/split-group";
import { splitFor, splitStore, useSplit } from "@/lib/split-store";
import { cn } from "@/lib/utils";
import {
  dropLeaving,
  type MountedColumn,
  mountColumns,
  settledColumns,
  settledShares,
  settleEntering,
} from "./split-columns";
import { WorkspaceView } from "./workspace-view";

/**
 * Opening is generous and closing is quick: a window rearranging itself is
 * worth watching, a window putting something away is not worth waiting for.
 */
const OPEN_MS = 220;
const CLOSE_MS = 180;
/** The whole window, for a route that draws one workspace. */
const WHOLE: readonly number[] = [1];

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** What one column's chrome can do to the split, stable for as long as it is mounted. */
interface ColumnHandlers {
  activate: () => void;
  keepOnly: () => void;
  remove: () => void;
}

/**
 * The routed workspace, or the group it belongs to.
 *
 * The arrangement is `splitStore`'s; this is the only place that turns it into
 * layout. Every column is the same component, so the single-workspace window
 * is not a separate code path — it is this one with one column.
 *
 * The URL names a workspace, not a column: a split is drawn whenever the route
 * lands on any of the group's members, in the group's own left-to-right
 * order. So opening another member from the rail keeps the window exactly as
 * it was and simply moves which column the address bar is about, and opening a
 * workspace outside the group draws it alone with the group left standing.
 *
 * A window too narrow to give every column `MIN_COLUMN_PX` draws as many
 * neighbouring columns as fit — never fewer than two, so a pair is drawn at
 * any width, as it always was — keeping the column being worked in on screen.
 * The rest stay in the group and come back when there is room. Three or four
 * columns are drawn no narrower than that minimum, whatever widths are stored
 * (see `drawnShares`).
 */
export function WorkspaceSplit({
  workspaceId,
  focusParam,
  tabParam,
}: {
  workspaceId: string;
  /** `?focus=` / `?tab=`, which reach the routed column only — see `WorkspaceView`. */
  focusParam: string | null;
  tabParam: string | null;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const { group, activeId, heading } = useSplit();
  const [resizing, setResizing] = useState(false);
  /**
   * The canvas's width, or null until it has been measured. Nothing is
   * mounted before then: drawing every member of a group before the window
   * knows how many fit would mount — and claim terminals for — columns the
   * narrow-window fold then takes away again a moment later.
   */
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  const capacity = canvasWidth === null ? MAX_MEMBERS : columnCapacity(canvasWidth);
  /**
   * The widths a seam drag is showing. Kept here until the seam is let go,
   * and only then stored: the sidebar and localStorage hear about a seam when
   * it has been put down, not at pointer rate while it moves.
   */
  const [liveSizes, setLiveSizes] = useState<readonly number[] | null>(null);

  /*
   * Where the address bar is going, if something has just sent it somewhere
   * (a member leaving, a drop), or else where it is. The route trails the
   * change by a render or more, and the window draws its destination rather
   * than one frame of what the old route named.
   */
  const routeId = heading ?? workspaceId;
  /** The group this route draws, or null when it draws one workspace. */
  const drawnGroup = splitFor(group, routeId);
  const members = drawnGroup ? drawnGroup.members : [routeId];
  const sizes = drawnGroup
    ? liveSizes?.length === drawnGroup.members.length
      ? liveSizes
      : drawnGroup.sizes
    : WHOLE;

  /*
   * Which of the group fit, as a run of neighbours that scrolls only as far
   * as it must to keep the column being worked in on screen. The previous
   * start is a ref, not state: it is only ever the answer to "where was the
   * window", and remembering it must not cost a render of its own.
   */
  const runStartRef = useRef(0);
  const { start: runStart, ids: visible } = drawnColumns(
    members,
    capacity,
    runStartRef.current,
    activeId,
    routeId,
  );
  const runLength = visible.length;
  const visibleKey = canvasWidth === null ? "" : visible.join(" ");
  useEffect(() => {
    runStartRef.current = runStart;
  }, [runStart]);

  /*
   * What is mounted, which outlives what is visible for the length of a
   * close: unmounting on the same tick would make a column disappear rather
   * than collapse. Brought up to date during render rather than in an effect,
   * so a route onto some other workspace never draws one frame of the old one.
   */
  const [columns, setColumns] = useState<MountedColumn[]>([]);
  const [mountedKey, setMountedKey] = useState("");
  if (mountedKey !== visibleKey) {
    setMountedKey(visibleKey);
    // The first columns, once the canvas has been measured, are simply there:
    // a window opening is not a window rearranging itself.
    setColumns(mountedKey === "" ? settledColumns(visible) : mountColumns(columns, visible));
  }

  const entering = columns.some(({ state }) => state === "entering");
  const leavingKey = columns
    .filter(({ state }) => state === "leaving")
    .map(({ id }) => id)
    .join(" ");
  useEffect(() => {
    if (!entering) return;
    // One frame flat at the seam first, so the transition has a width to
    // start from; setting both in the same commit is a jump, not a sweep.
    const frame = requestAnimationFrame(() => setColumns(settleEntering));
    return () => cancelAnimationFrame(frame);
  }, [entering]);
  useEffect(() => {
    if (!leavingKey) return;
    const timer = window.setTimeout(() => setColumns(dropLeaving), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [leavingKey]);

  /*
   * Measured before the first paint, so the columns mount once, at the
   * number that fits. The container's width does not depend on its columns
   * — it is the main panel's — so an empty container measures true.
   */
  useIsoLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setCanvasWidth(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      setCanvasWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /*
   * The route and router, for callbacks made once and kept — the column
   * handlers below, and the reconcile that follows a member that has gone.
   */
  const routeRef = useRef(workspaceId);
  routeRef.current = workspaceId;
  const routerRef = useRef(router);
  routerRef.current = router;

  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  /*
   * Null while the list is in flight. `reconcile` reads that as "no opinion
   * yet" and leaves the group alone; handing it an empty set instead would
   * drop the arrangement on every cold load, before the list had said anything
   * about whether its workspaces still exist.
   */
  const knownIds = useMemo(
    () => (workspacesQ.data ? new Set(workspacesQ.data.map((workspace) => workspace.id)) : null),
    [workspacesQ.data],
  );
  const nameOf = (id: string) => workspacesQ.data?.find((workspace) => workspace.id === id)?.name;

  /*
   * A member that stopped existing leaves the group here when the list
   * refresh beats its own 404 — and when it was the one the address bar is
   * on, the route goes to the column that took its place, exactly as the 404
   * would have sent it. The window is already drawing that destination.
   */
  useEffect(() => {
    const destination = splitStore.reconcile(knownIds, routeRef.current);
    if (destination) routerRef.current.replace(`/w/${destination}`);
  }, [knownIds]);

  /*
   * Arriving somewhere hands that column the keyboard. Keyed on the route
   * alone: within a split the active column is the user's own — clicking into
   * another pane moves it — and only going somewhere should move it back.
   */
  useEffect(() => {
    splitStore.followRoute(workspaceId);
  }, [workspaceId]);

  /*
   * Geometry and the arrangement disagree for the length of a close, so they
   * get a flag each.
   *
   * `split` is what is on screen, and everything that measures or clips reads
   * it: the columns' widths, their clip, and — through `PaneScope` — each
   * grid's own layout. Reading the store there would tell a surviving column
   * it was alone while its canvas was still part-width, long enough for the
   * grid to reflow twice inside a 180ms animation.
   *
   * The unsplit affordances read the group instead (see `paired` below), so a
   * control goes on the click rather than lingering on a window the user has
   * already dismissed.
   */
  const split = columns.length > 1;
  /*
   * Each settled column's share, held to the floor for this canvas: three or
   * four columns are never drawn under `MIN_COLUMN_PX` while the window holds
   * them, whatever is stored. The drop preview holds its columns the same way
   * (`drawnShares`), so the two cannot disagree about a width.
   */
  const settled = settledShares(columns, members, sizes);
  const held = clampSizes([...settled.values()], columnFloor(settled.size, canvasWidth ?? 0));
  const shares = new Map([...settled.keys()].map((id, index) => [id, held[index] ?? 0]));

  /*
   * The measurement only this component can make, published for the surfaces
   * that draw the split from outside it — the sidebar asking whether the
   * arrangement it lists is the window in front of you, most of all.
   *
   * In an effect rather than in render, because a store write during render
   * tears: the listeners fire while React is still deciding what this tree
   * looks like. The cleanup covers leaving the workspace route entirely,
   * which would otherwise leave the sidebar drawing a split for a page that
   * has none of it on.
   */
  const renderedKey = split ? columns.map(({ id }) => id).join(" ") : "";
  useEffect(() => {
    splitStore.setRendered(renderedKey ? renderedKey.split(" ") : []);
    return () => splitStore.setRendered([]);
  }, [renderedKey]);

  /*
   * One set of handlers per column, made once and kept: every column is a
   * memoised view, and a fresh callback per render would re-run every grid on
   * screen at pointer rate while a seam is dragged. They read the route and
   * router through refs, so being made once does not make them stale.
   */
  const handlersRef = useRef(new Map<string, ColumnHandlers>());
  const handlersFor = (id: string): ColumnHandlers => {
    const known = handlersRef.current.get(id);
    if (known) return known;
    const made: ColumnHandlers = {
      activate: () => splitStore.setActive(id),
      // End the split keeping this column — and follow it if the route must.
      keepOnly: () => {
        const destination = splitStore.unsplit(id, routeRef.current);
        if (destination) routerRef.current.push(`/w/${destination}`);
      },
      // This column steps out; the others stay, and the route follows the
      // column that takes its place if it was about this one.
      remove: () => {
        const destination = splitStore.remove(id, routeRef.current);
        if (destination) routerRef.current.push(`/w/${destination}`);
      },
    };
    handlersRef.current.set(id, made);
    return made;
  };

  /** The run as drawn right now, for gestures that outlive the render they started in. */
  const runRef = useRef({ start: runStart, length: runLength });
  runRef.current = { start: runStart, length: runLength };

  /*
   * The sidebar's grip, at `AppShell.startSidebarResize`, with the container's
   * bounds standing in for the aside's: the pointer may leave the 8px target,
   * and `resizing` drops the transition for the length of the gesture so the
   * columns track the cursor exactly instead of easing towards it. Only the
   * two columns either side of the seam change; every other seam stays where
   * it is, and neither neighbour goes under its floor (`dragSeam`).
   *
   * The pointer is captured, so the release comes back here wherever it
   * happens; a move with no button held ends the drag too — a release the
   * page never heard, over another window or after the tab lost focus, would
   * otherwise leave the seam following a mouse nobody is holding.
   */
  const startSeamResize = (seam: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const handle = event.currentTarget;
    const bounds = containerRef.current?.getBoundingClientRect();
    const from = splitStore.get().group;
    if (!bounds || bounds.width <= 0 || !from) return;
    event.preventDefault();
    const { pointerId } = event;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // The pointer went away already; the document listeners still end it.
    }
    const { start, length } = runRef.current;
    let latest: readonly number[] = from.sizes;
    let done = false;
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        finish();
        return;
      }
      const boundary = (moveEvent.clientX - bounds.left) / bounds.width;
      latest = dragSeam(from.sizes, start, length, seam, boundary, bounds.width);
      setLiveSizes(latest);
    };
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Stored once, now that the seam has been put down.
      splitStore.setSizes(latest);
      setLiveSizes(null);
      setResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  /** Arrows step the seam; Home and End take it as far as either neighbour allows. */
  const nudgeSeam = (seam: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = splitStore.get().group;
    if (!current) return;
    const { start, length } = runRef.current;
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const at = seamPosition(drawnShares(current.sizes, start, length, width), seam);
    const target =
      event.key === "ArrowLeft"
        ? at - SEAM_STEP
        : event.key === "ArrowRight"
          ? at + SEAM_STEP
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : null;
    if (target === null) return;
    event.preventDefault();
    splitStore.setSizes(dragSeam(current.sizes, start, length, seam, target, width));
  };

  /*
   * Which column owns the document-level gestures: the one the user last
   * worked in, or the one the URL is about until they have.
   */
  const showing = columns.filter(({ state }) => state !== "leaving").map(({ id }) => id);
  const activeColumn =
    activeId && showing.includes(activeId)
      ? activeId
      : showing.includes(routeId)
        ? routeId
        : (showing[0] ?? routeId);

  // Every column moves on the same clock, so the seams read as things
  // sweeping across rather than panels resizing next to each other.
  const durationMs = leavingKey ? CLOSE_MS : OPEN_MS;

  return (
    <div ref={containerRef} className="flex min-w-0">
      {columns.map((column, index) => {
        const left = columns[index - 1];
        const settled = column.state === "in";
        const share = shares.get(column.id) ?? 0;
        /*
         * `paired` is what the store says, and the unsplit affordances read
         * it: a column on its way out, or one whose group has just been
         * dissolved, has no "keep only" or "remove" left to offer.
         */
        const paired = drawnGroup !== null && column.state !== "leaving";
        const handlers = handlersFor(column.id);
        // The seam's number in the drawn run, which is what the widths are
        // kept against. Only a seam between two settled columns is live.
        const seam = visible.indexOf(column.id) - 1;
        const seamLive = left?.state === "in" && settled && seam >= 0;
        const leftName = left ? nameOf(left.id) : undefined;
        const rightName = nameOf(column.id);
        const seamLabel =
          leftName && rightName
            ? `Resize split between ${leftName} and ${rightName}`
            : "Resize split";
        return (
          <Fragment key={column.id}>
            {left ? (
              /*
               * A zero-width flex item, so the seam sits exactly on the
               * boundary and sweeps with it for free — positioning it at
               * `left: share%` would leave it parked at its destination while
               * the columns were still on their way there.
               */
              <div
                // Canvas, as far as a carried workspace is concerned: aiming
                // between two columns is aiming at this.
                data-split-seam
                className="relative w-0 shrink-0 grow-0"
              >
                <button
                  type="button"
                  aria-label={seamLabel}
                  title={seamLabel}
                  disabled={!seamLive}
                  onPointerDown={startSeamResize(seam)}
                  onKeyDown={nudgeSeam(seam)}
                  // Above the strip chrome, not level with it: the workspace
                  // menu pinned to the next column's left edge is sticky at
                  // z-20 with an opaque plate, and being later in the DOM it
                  // wins that tie and punches its own height out of the seam.
                  // The seam is one line down the whole window or it is not a
                  // seam.
                  // `touch-none`: a finger on the seam drags it, rather than the
                  // browser taking the gesture for a scroll and cancelling it.
                  className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none focus-visible:outline-none disabled:pointer-events-none"
                >
                  <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring" />
                </button>
              </div>
            ) : null}
            <div
              className={cn(
                // Positioned, so anything a column places by hand is placed
                // against that column rather than against whatever ancestor
                // happened to be positioned first — which, with several
                // columns up, is the one to its left.
                "relative min-w-0 shrink-0 grow-0",
                // Clipping only matters once there is a neighbour to bleed
                // into; a single-workspace window keeps whatever overflow it
                // has today.
                split && "overflow-hidden",
                !resizing && "transition-[flex-basis,opacity] ease-swift",
              )}
              style={{
                flexBasis: !split ? "100%" : settled ? `${share * 100}%` : "0%",
                opacity: !split || settled ? 1 : 0,
                transitionDuration: `${durationMs}ms`,
              }}
            >
              <WorkspaceView
                workspaceId={column.id}
                // Counted among the columns that are staying, so a neighbour
                // folding away does not move anyone's edge for its 180ms.
                column={Math.max(0, showing.indexOf(column.id))}
                columns={showing.length}
                split={split}
                routedId={workspaceId}
                active={!split || column.id === activeColumn}
                focusParam={column.id === workspaceId ? focusParam : null}
                tabParam={column.id === workspaceId ? tabParam : null}
                onActivate={handlers.activate}
                onUnsplit={paired ? handlers.keepOnly : null}
                onRemoveFromSplit={paired ? handlers.remove : null}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
