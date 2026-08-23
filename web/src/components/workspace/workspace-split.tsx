"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { workspaces } from "@/lib/api";
import { MAX_RATIO, MIN_RATIO, splitStore, useSplit } from "@/lib/split-store";
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
 * How much canvas a split needs before it is worth having. The grid's own
 * split-aware threshold is 560px, under which it stacks its panes into a
 * mobile list, so two halves at the default even seam want ~1120px before
 * either is a real grid; 1024 is the round number just below that, and the
 * seam's `MIN_RATIO` is what covers the rest — a deliberately lopsided split
 * at this width still gives its wide half 768px.
 *
 * Measured on the container rather than the viewport because those are not
 * the same number: the sidebar in front of it is resizable between 216 and
 * 420px and collapses to a rail, so the same window sits on either side of
 * this gate depending only on how wide the rail is. Answered in JS rather
 * than by hiding the second half in CSS, because a hidden half is still a
 * mounted grid with its own queries and its own terminals.
 */
const SPLIT_MIN_CONTAINER_PX = 1024;

/**
 * The routed workspace, and optionally a second one beside it.
 *
 * The arrangement is `splitStore`'s; this is the only place that turns it into
 * layout. Both halves are the same component, so the single-workspace window
 * is not a separate code path — it is this one with nothing on the right.
 */
export function WorkspaceSplit({
  workspaceId,
  focusParam,
  tabParam,
}: {
  workspaceId: string;
  /** `?focus=` / `?tab=`, which reach the primary only — see `WorkspaceView`. */
  focusParam: string | null;
  tabParam: string | null;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const { secondaryId, ratio, activeSide } = useSplit();
  const [wide, setWide] = useState(false);
  const [resizing, setResizing] = useState(false);
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
   * the second workspace on every cold load, before the list had said anything
   * about whether it still exists.
   */
  const knownIds = useMemo(
    () => (workspacesQ.data ? new Set(workspacesQ.data.map((workspace) => workspace.id)) : null),
    [workspacesQ.data],
  );

  useEffect(() => {
    splitStore.reconcile(workspaceId, knownIds);
  }, [knownIds, workspaceId]);

  /*
   * Measured before the first paint rather than from the observer's first
   * callback: a restored split that had to wait for that callback would show
   * one frame of full-width primary before the second half appeared.
   */
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setWide(container.getBoundingClientRect().width >= SPLIT_MIN_CONTAINER_PX);
    const observer = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= SPLIT_MIN_CONTAINER_PX);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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

  /** The workspace on the right, or null on a window too narrow to hold one. */
  const secondaryView = wide ? mounted : null;
  /*
   * Geometry and the arrangement disagree for the length of a close, so they
   * get a flag each.
   *
   * `split` is what is on screen, and everything that measures or clips reads
   * it: the halves' widths, the primary's clip, and — through `PaneScope` —
   * the grid's own narrow-canvas threshold. Reading the store there would
   * tell the surviving half it was alone while its canvas was still
   * half-width, long enough for the grid to fall into its stacked layout and
   * reflow back out of it inside a 180ms animation.
   */
  const split = secondaryView !== null;
  /*
   * `paired` is what the store says, and the unsplit affordance reads it, so
   * the control goes on the click rather than lingering on a window the user
   * has already dismissed. `onUnsplit` is how it reaches the tab strip —
   * "null when not split" is already its contract, so no second prop is
   * needed to say this.
   */
  const paired = wide && secondaryId !== null;

  /*
   * The measurement only this component can make, published for the surfaces
   * that draw the split from outside it — the sidebar marking a row as
   * shown-beside, most of all, which has no other way to know that a window
   * too narrow for a second half is showing one workspace.
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

  const closeSplit = useCallback(() => {
    splitStore.close();
  }, []);
  const keepSecondary = useCallback(() => {
    const promoted = splitStore.promoteSecondary();
    if (promoted) router.push(`/w/${promoted}`);
  }, [router]);
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
          key={workspaceId}
          workspaceId={workspaceId}
          side="primary"
          split={split}
          active={!split || activeSide === "primary"}
          focusParam={focusParam}
          tabParam={tabParam}
          onActivate={activatePrimary}
          onUnsplit={paired ? closeSplit : null}
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
              className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize focus-visible:outline-none"
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
              active={split && activeSide === "secondary"}
              focusParam={null}
              tabParam={null}
              onActivate={activateSecondary}
              onUnsplit={paired ? keepSecondary : null}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
