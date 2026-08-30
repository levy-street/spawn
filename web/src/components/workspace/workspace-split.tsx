"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { workspaces } from "@/lib/api";
import { MAX_RATIO, MIN_RATIO, splitFor, splitStore, useSplit } from "@/lib/split-store";
import { cn } from "@/lib/utils";
import { WorkspaceView } from "./workspace-view";

/**
 * Opening is generous and closing is quick: a window rearranging itself is
 * worth watching, a window putting something away is not worth waiting for.
 */
const OPEN_MS = 220;
const CLOSE_MS = 180;
/** How far one arrow press moves the seam, as a share of the canvas. */
const RATIO_STEP = 0.02;

/**
 * The routed workspace, or the pair it belongs to.
 *
 * The arrangement is `splitStore`'s; this is the only place that turns it into
 * layout. Both halves are the same component, so the single-workspace window
 * is not a separate code path — it is this one with nothing on the right.
 *
 * The URL names a workspace, not a side: a split is drawn whenever the route
 * lands on either of the pair's members, in the pair's own left-to-right
 * order. So opening the right-hand workspace from the rail keeps the window
 * exactly as it was and simply moves which half the address bar is about,
 * and opening a third workspace draws it alone with the pair left standing.
 */
export function WorkspaceSplit({
  workspaceId,
  focusParam,
  tabParam,
}: {
  workspaceId: string;
  /** `?focus=` / `?tab=`, which reach the routed half only — see `WorkspaceView`. */
  focusParam: string | null;
  tabParam: string | null;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const { pair, ratio, activeSide } = useSplit();
  const [resizing, setResizing] = useState(false);

  /** The pair this route draws, or null when it draws one workspace. */
  const drawn = splitFor(pair, workspaceId);
  const primaryId = drawn ? drawn.primaryId : workspaceId;
  const secondaryId = drawn ? drawn.secondaryId : null;

  /**
   * The workspace mounted on the right, which outlives `secondaryId` for the
   * length of the close: unmounting on the same tick would make the half
   * disappear rather than collapse.
   */
  const [mounted, setMounted] = useState<string | null>(secondaryId);
  /** Whether the second half is out at its share rather than flat at the seam. */
  const [entered, setEntered] = useState(secondaryId !== null);

  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  /*
   * Null while the list is in flight. `reconcile` reads that as "no opinion
   * yet" and leaves the pair alone; handing it an empty set instead would drop
   * the arrangement on every cold load, before the list had said anything
   * about whether its workspaces still exist.
   */
  const knownIds = useMemo(
    () => (workspacesQ.data ? new Set(workspacesQ.data.map((workspace) => workspace.id)) : null),
    [workspacesQ.data],
  );

  useEffect(() => {
    splitStore.reconcile(knownIds);
  }, [knownIds]);

  /*
   * Arriving somewhere hands that half the keyboard. Keyed on the route
   * alone: within a split the active half is the user's own — clicking into
   * the other pane moves it — and only going somewhere should move it back.
   */
  useEffect(() => {
    splitStore.followRoute(workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    if (secondaryId) {
      setMounted(secondaryId);
      // One frame flat at the seam first, so the transition has a width to
      // start from; setting both in the same commit is a jump, not a sweep.
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    const timer = window.setTimeout(() => setMounted(null), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [secondaryId]);

  /** The workspace on the right, held through its own collapse. */
  const secondaryView = mounted;
  /*
   * Geometry and the arrangement disagree for the length of a close, so they
   * get a flag each.
   *
   * `split` is what is on screen, and everything that measures or clips reads
   * it: the halves' widths, the primary's clip, and — through `PaneScope` —
   * the grid's own layout. Reading the store there would tell the surviving
   * half it was alone while its canvas was still half-width, long enough for
   * the grid to reflow twice inside a 180ms animation.
   */
  const split = secondaryView !== null;
  /*
   * `paired` is what the store says, and the unsplit affordances read it, so
   * a control goes on the click rather than lingering on a window the user
   * has already dismissed. `onUnsplit` is how it reaches the tab strip —
   * "null when not split" is already its contract, so no second prop is
   * needed to say this.
   */
  const paired = drawn !== null;

  /*
   * The measurement only this component can make, published for the surfaces
   * that draw the split from outside it — the sidebar asking whether the
   * arrangement it lists is the window in front of you, most of all.
   *
   * In an effect rather than in render, because a store write during render
   * tears: the listeners fire while React is still deciding what this tree
   * looks like. The cleanup covers leaving the workspace route entirely,
   * which would otherwise leave the sidebar drawing a split for a page that
   * has neither half on it.
   */
  useEffect(() => {
    splitStore.setRendered(secondaryView);
    return () => splitStore.setRendered(null);
  }, [secondaryView]);

  /** End the split, keeping one half — and follow it if the route must. */
  const keepOnly = useCallback(
    (keepId: string) => {
      const destination = splitStore.unsplit(keepId, workspaceId);
      if (destination) router.push(`/w/${destination}`);
    },
    [router, workspaceId],
  );
  const keepPrimary = useCallback(() => keepOnly(primaryId), [keepOnly, primaryId]);
  const keepSecondary = useCallback(
    () => (secondaryId ? keepOnly(secondaryId) : undefined),
    [keepOnly, secondaryId],
  );
  const activatePrimary = useCallback(() => {
    splitStore.setActiveSide("primary");
  }, []);
  const activateSecondary = useCallback(() => {
    splitStore.setActiveSide("secondary");
  }, []);

  /*
   * The sidebar's grip, at `AppShell.startSidebarResize`, with the container's
   * bounds standing in for the aside's: listeners on the document rather than
   * the button so the pointer may leave the 8px target, and `resizing` drops
   * the transition for the length of the gesture so the halves track the
   * cursor exactly instead of easing towards it.
   */
  const startSeamResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    event.preventDefault();
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      splitStore.setRatio((moveEvent.clientX - bounds.left) / bounds.width);
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

  const nudgeSeam = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === "ArrowLeft" ? -RATIO_STEP : event.key === "ArrowRight" ? RATIO_STEP : 0;
    if (step !== 0) {
      event.preventDefault();
      splitStore.setRatio(ratio + step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      splitStore.setRatio(MIN_RATIO);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      splitStore.setRatio(MAX_RATIO);
    }
  };

  // Both halves move on the same clock, so the seam reads as one thing
  // sweeping across rather than two panels resizing next to each other.
  const durationMs = entered ? OPEN_MS : CLOSE_MS;

  return (
    <div ref={containerRef} className="flex min-w-0">
      <div
        className={cn(
          // Positioned, so anything a half places by hand is placed against
          // that half rather than against whatever ancestor happened to be
          // positioned first — which, with two halves up, is the other one.
          "relative min-w-0 shrink-0 grow-0",
          // Clipping only matters once there is a neighbour to bleed into; a
          // single-workspace window keeps whatever overflow it has today.
          secondaryView !== null && "overflow-hidden",
          !resizing && "transition-[flex-basis] ease-swift",
        )}
        style={{
          flexBasis: secondaryView !== null && entered ? `${ratio * 100}%` : "100%",
          transitionDuration: `${durationMs}ms`,
        }}
      >
        <WorkspaceView
          key={primaryId}
          workspaceId={primaryId}
          side="primary"
          split={split}
          routedId={workspaceId}
          active={!split || activeSide === "primary"}
          focusParam={primaryId === workspaceId ? focusParam : null}
          tabParam={primaryId === workspaceId ? tabParam : null}
          onActivate={activatePrimary}
          onUnsplit={paired ? keepPrimary : null}
          onRemoveFromSplit={paired ? keepSecondary : null}
        />
      </div>

      {secondaryView !== null ? (
        <>
          {/*
           * A zero-width flex item, so the seam sits exactly on the boundary
           * and sweeps with it for free — positioning it at `left: ratio%`
           * would leave it parked at its destination while the halves were
           * still on their way there.
           */}
          <div className="relative w-0 shrink-0 grow-0">
            <button
              type="button"
              aria-label="Resize split"
              title="Resize split"
              onPointerDown={startSeamResize}
              onKeyDown={nudgeSeam}
              // Above the strip chrome, not level with it: the workspace menu
              // pinned to the far half's left edge is sticky at z-20 with an
              // opaque plate, and being later in the DOM it wins that tie and
              // punches its own height out of the seam. The seam is one line
              // down the whole window or it is not a seam.
              className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize focus-visible:outline-none"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring" />
            </button>
          </div>

          <div
            className={cn(
              "relative min-w-0 shrink-0 grow-0 overflow-hidden",
              !resizing && "transition-[flex-basis,opacity] ease-swift",
            )}
            style={{
              flexBasis: entered ? `${(1 - ratio) * 100}%` : "0%",
              opacity: entered ? 1 : 0,
              transitionDuration: `${durationMs}ms`,
            }}
          >
            <WorkspaceView
              key={secondaryView}
              workspaceId={secondaryView}
              side="secondary"
              split={split}
              routedId={workspaceId}
              active={split && activeSide === "secondary"}
              focusParam={secondaryView === workspaceId ? focusParam : null}
              tabParam={secondaryView === workspaceId ? tabParam : null}
              onActivate={activateSecondary}
              onUnsplit={paired ? keepSecondary : null}
              onRemoveFromSplit={paired ? keepPrimary : null}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
