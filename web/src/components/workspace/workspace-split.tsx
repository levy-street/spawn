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
  columnCapacity,
  MAX_MEMBERS,
  moveSeam,
  runShares,
  SEAM_STEP,
  seamPosition,
  visibleRun,
  withRunShares,
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
 * The rest stay in the group and come back when there is room.
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
  const { group, activeId } = useSplit();
  const [resizing, setResizing] = useState(false);
  /** How many columns the canvas holds; all of them until it has been measured. */
  const [capacity, setCapacity] = useState(MAX_MEMBERS);

  /** The group this route draws, or null when it draws one workspace. */
  const drawnGroup = splitFor(group, workspaceId);
  const members = drawnGroup ? drawnGroup.members : [workspaceId];
  const sizes = drawnGroup ? drawnGroup.sizes : WHOLE;

  /*
   * Which of the group fit, as a run of neighbours that scrolls only as far
   * as it must to keep the column being worked in on screen. The previous
   * start is a ref, not state: it is only ever the answer to "where was the
   * window", and remembering it must not cost a render of its own.
   */
  const runStartRef = useRef(0);
  const runLength = Math.min(members.length, capacity);
  const routedIndex = members.indexOf(workspaceId);
  const activeIndex = activeId ? members.indexOf(activeId) : -1;
  const aroundActive = visibleRun(
    members.length,
    capacity,
    runStartRef.current,
    activeIndex >= 0 ? activeIndex : routedIndex,
  );
  // The column the address bar is about is always drawn — on the render
  // after a navigation the keyboard has not followed the route yet, and a
  // window that did not show the workspace its URL names would be wrong.
  const runStart =
    routedIndex < aroundActive || routedIndex >= aroundActive + runLength
      ? visibleRun(members.length, capacity, aroundActive, routedIndex)
      : aroundActive;
  const visible = members.slice(runStart, runStart + runLength);
  const visibleKey = visible.join(" ");
  useEffect(() => {
    runStartRef.current = runStart;
  }, [runStart]);

  /*
   * What is mounted, which outlives what is visible for the length of a
   * close: unmounting on the same tick would make a column disappear rather
   * than collapse. Brought up to date during render rather than in an effect,
   * so a route onto some other workspace never draws one frame of the old one.
   */
  const [columns, setColumns] = useState<MountedColumn[]>(() => settledColumns(visible));
  const [mountedKey, setMountedKey] = useState(visibleKey);
  if (mountedKey !== visibleKey) {
    setMountedKey(visibleKey);
    setColumns(mountColumns(columns, visible));
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

  useIsoLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setCapacity(columnCapacity(container.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      setCapacity(columnCapacity(entry?.contentRect.width ?? 0));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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

  useEffect(() => {
    splitStore.reconcile(knownIds);
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
  const shares = settledShares(columns, members, sizes);

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
  const routeRef = useRef(workspaceId);
  routeRef.current = workspaceId;
  const routerRef = useRef(router);
  routerRef.current = router;
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

  /** Move seam `seam` of the drawn run to `boundary`, a share of the canvas. */
  const placeSeam = (seam: number, boundary: number) => {
    const current = splitStore.get().group;
    if (!current) return;
    const { start, length } = runRef.current;
    const moved = moveSeam(runShares(current.sizes, start, length), seam, boundary);
    splitStore.setSizes(withRunShares(current.sizes, start, moved));
  };

  /*
   * The sidebar's grip, at `AppShell.startSidebarResize`, with the container's
   * bounds standing in for the aside's: listeners on the document rather than
   * the button so the pointer may leave the 8px target, and `resizing` drops
   * the transition for the length of the gesture so the columns track the
   * cursor exactly instead of easing towards it. Only the two columns either
   * side of the seam change; every other seam stays where it is.
   */
  const startSeamResize = (seam: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    event.preventDefault();
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      placeSeam(seam, (moveEvent.clientX - bounds.left) / bounds.width);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onUp, { once: true });
  };

  /** Arrows step the seam; Home and End take it as far as either neighbour allows. */
  const nudgeSeam = (seam: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = splitStore.get().group;
    if (!current) return;
    const { start, length } = runRef.current;
    const at = seamPosition(runShares(current.sizes, start, length), seam);
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
    placeSeam(seam, target);
  };

  /*
   * Which column owns the document-level gestures: the one the user last
   * worked in, or the one the URL is about until they have.
   */
  const showing = columns.filter(({ state }) => state !== "leaving").map(({ id }) => id);
  const activeColumn =
    activeId && showing.includes(activeId)
      ? activeId
      : showing.includes(workspaceId)
        ? workspaceId
        : (showing[0] ?? workspaceId);

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
                  className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize focus-visible:outline-none disabled:pointer-events-none"
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
