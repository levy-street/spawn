"use client";

import { type PointerEvent as ReactPointerEvent, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { SidebarIconSlot, SidebarRowLabel, WorkspaceAvatar } from "@/components/nav/sidebar-parts";
import {
  type Arrangement,
  type DropZone,
  dropZones,
  type PaneTarget,
  sideOf,
  splitDrop,
  zoneAt,
} from "@/components/nav/workspace-drag";
import { PANE_SCOPE_ATTR, paneRootAt } from "@/components/workspace/pane-scope";
import type { Workspace } from "@/lib/api";
import { type SplitSide, splitStore } from "@/lib/split-store";
import { cn } from "@/lib/utils";

/**
 * Carrying a workspace onto the canvas.
 *
 * The gesture belongs to the workspace, not to the rail it usually starts
 * from: the same carry runs from a sidebar row and from a split half's own
 * name in its tab strip, so rearranging a split is one thing to learn rather
 * than two. Everything that is specific to where the drag started — the
 * reorder half of the sidebar's gesture, the lifted row, which element the
 * ghost is cut from — stays with the caller; everything from "this workspace
 * is in flight" onwards is here.
 *
 * A module singleton with one overlay mounted in `AppShell`, for the same
 * reason `splitStore` is one: the two surfaces that start a carry are not in
 * one tree, and the sidebar itself is mounted twice on a narrow window (the
 * rail and the drawer), so an overlay owned by the sidebar would be drawn
 * twice or not at all depending on which copy the drag came from.
 */

/** A workspace in flight, and the halves it may be released into. */
export interface CarriedWorkspace {
  workspace: Workspace;
  /**
   * Where a release lands — and, drawn, the panels the preview is composed
   * of. Deliberately the same rectangles for both: the boundary the pointer
   * flips at has to be the boundary the user can see.
   */
  zones: DropZone[];
  /**
   * Every workspace that can appear in the preview: the one being carried,
   * plus whichever are on screen now. One panel is rendered per member and
   * then moved between halves, rather than panels being built and thrown away
   * per arrangement — a panel that persists can travel, and travelling is what
   * shows that two workspaces swapped rather than that one blinked.
   */
  cast: Workspace[];
  /** What is on screen at the moment the carry begins. */
  arrangement: Arrangement;
  /**
   * The element the ghost is cut from, at rest. The travel is the ghost's
   * transform and only its transform — folding it in here as well counted it
   * twice, and the ghost pulled away from the cursor at double rate.
   */
  origin: { left: number; top: number; width: number; height: number };
  /**
   * The travel at the moment the carry began, rendered as the ghost's opening
   * transform. `track` cannot reach the element until the commit after this
   * one, so without it the ghost would draw one frame back at the row it came
   * from and then jump to the pointer.
   */
  offset: { x: number; y: number };
}

const listeners = new Set<() => void>();
let carried: CarriedWorkspace | null = null;
/**
 * The overlay's own elements. Held as plain nodes rather than React state
 * because the gesture writes to them at pointer rate: the ghost's transform
 * and every panel's box are DOM writes, so a carry renders React exactly
 * twice — once to put the overlay up and once to take it down.
 */
let ghostEl: HTMLElement | null = null;
let previewEl: HTMLElement | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

const carryStore = {
  get: (): CarriedWorkspace | null => carried,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * The halves of the window as they stand right now. Measured fresh whenever
 * the answer is used rather than cached with the drag: a split that has just
 * been opened is still widening, and a drop has to land in the window the
 * user can see rather than the one that was there when they picked the row up.
 */
function measurePanes(): PaneTarget[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[${PANE_SCOPE_ATTR}]`),
    (root): PaneTarget => {
      // Copied edge by edge out of the DOMRect: it is handed to pure helpers
      // that build new rects from it, and a DOMRect cannot be spread — its
      // edges live on the prototype, so `{...rect}` is empty.
      const { left, top, right, bottom } = root.getBoundingClientRect();
      return {
        side: root.dataset.splitSide === "secondary" ? "secondary" : "primary",
        rect: { left, top, right, bottom },
      };
    },
  );
}

/**
 * Which workspace is in which half at this instant.
 *
 * The pair's own order, not the route's: a split draws left-to-right as the
 * arrangement says, and the address bar may be about either half of it — or,
 * once the pair is parked behind a third workspace, about neither.
 */
function shownArrangement(routedId: string | null): Arrangement {
  const { pair, renderedSecondaryId } = splitStore.get();
  if (pair && renderedSecondaryId) {
    return { primary: pair.primaryId, secondary: pair.secondaryId };
  }
  return { primary: routedId, secondary: null };
}

/** A workspace being carried: what the caller drives as the pointer moves. */
export interface WorkspaceCarry {
  /** Put the ghost and the drop preview up. */
  show(clientX: number, clientY: number): void;
  /** Take them down again, without ending the gesture (the rail's reorder). */
  hide(): void;
  /** The pointer moved while the overlay is up. */
  track(clientX: number, clientY: number): void;
  /** Release: apply whatever arrangement the pointer is offering. */
  drop(clientX: number, clientY: number): void;
  /** Done, committed or not. */
  end(): void;
}

export function createWorkspaceCarry({
  workspace,
  routedId,
  lookup,
  origin,
  start,
  navigate,
}: {
  workspace: Workspace;
  /** The workspace the address bar is about, or null off a workspace page. */
  routedId: string | null;
  /** Name a workspace by id, for the preview's panels. */
  lookup: (workspaceId: string) => Workspace | undefined;
  /** The resting box of whatever the ghost is cut from. */
  origin: { left: number; top: number; width: number; height: number };
  /** Where the pointer was when the press began. */
  start: { x: number; y: number };
  /** Go to a workspace — only ever called when a drop displaces the route. */
  navigate: (workspaceId: string) => void;
}): WorkspaceCarry {
  /** The half the preview is currently drawn for; null is off the canvas. */
  let lit: SplitSide | null = null;

  /**
   * Which half the pointer is offering to drop into. `paneRootAt` first, so
   * a pointer over something stacked above the canvas — a dialog, an open
   * menu — does not read as a drop into the half behind it.
   */
  const sideUnder = (clientX: number, clientY: number): SplitSide | null => {
    if (!paneRootAt(clientX, clientY)) return null;
    const zones = dropZones(measurePanes(), splitStore.get().ratio);
    return zoneAt(clientX, clientY, zones)?.side ?? null;
  };

  /**
   * Redraw the preview as the window a release here would leave behind. Each
   * panel is a workspace rather than a slot, so a workspace that changes
   * halves travels there and one that is being displaced fades where it
   * stands — which is the whole answer to "what happens if I let go here".
   */
  const draw = (side: SplitSide | null): void => {
    const layer = previewEl;
    if (!layer) return;
    // Off the canvas the preview withdraws but keeps its last arrangement,
    // so leaving reads as the preview fading rather than as it rearranging
    // itself into something nobody asked for on the way out.
    layer.dataset.live = String(side !== null);
    if (!side) return;
    const zones = dropZones(measurePanes(), splitStore.get().ratio);
    const shown = shownArrangement(routedId);
    const next = splitDrop(side, workspace.id, shown) ?? shown;
    for (const panel of layer.querySelectorAll<HTMLElement>("[data-preview-panel]")) {
      const memberId = panel.dataset.previewPanel ?? "";
      const zone = zones.find((candidate) => candidate.side === sideOf(memberId, next));
      panel.dataset.shown = String(Boolean(zone));
      panel.dataset.lit = String(memberId === workspace.id);
      if (!zone) continue;
      panel.style.transform = `translate(${zone.rect.left}px, ${zone.rect.top}px)`;
      panel.style.width = `${zone.rect.right - zone.rect.left}px`;
      panel.style.height = `${zone.rect.bottom - zone.rect.top}px`;
    }
  };

  return {
    show(clientX, clientY) {
      const arrangement = shownArrangement(routedId);
      carried = {
        workspace,
        zones: dropZones(measurePanes(), splitStore.get().ratio),
        // The carried workspace first, so a preview built while the workspace
        // list is still loading at least has the thing being dragged in it.
        cast: [workspace.id, arrangement.primary, arrangement.secondary]
          .filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)
          .map((id) => lookup(id))
          .filter((member): member is Workspace => Boolean(member)),
        arrangement,
        origin,
        offset: { x: clientX - start.x, y: clientY - start.y },
      };
      emit();
    },

    hide() {
      lit = null;
      if (!carried) return;
      carried = null;
      emit();
    },

    track(clientX, clientY) {
      // The overlay is one render behind the move that started the carry. It
      // renders itself already in position, so there is nothing to correct
      // until it exists — and `lit` must not advance without it, or the
      // arrangement it names would never be drawn.
      if (!ghostEl || !previewEl) return;
      ghostEl.style.transform = `translate(${clientX - start.x}px, ${clientY - start.y}px)`;
      const side = sideUnder(clientX, clientY);
      if (side === lit) return;
      lit = side;
      draw(side);
    },

    drop(clientX, clientY) {
      const side = sideUnder(clientX, clientY);
      if (!side) return;
      const shown = shownArrangement(routedId);
      const next = splitDrop(side, workspace.id, shown);
      // Null is the drop that asks for the arrangement already on screen —
      // released onto the half the workspace is in. Ending here rather than
      // reasserting it is what keeps that from flickering.
      if (!next?.primary || !next.secondary) return;
      splitStore.setPair(next.primary, next.secondary);
      // Whatever you just placed is what you meant to work in.
      splitStore.setActiveSide(sideOf(workspace.id, next) ?? "primary");
      // A split is only drawn while the URL names one of its members, so a
      // drop that displaces the routed workspace has to take the address bar
      // with it. One that does not — the ordinary case, including every swap
      // — leaves the route exactly where the user left it.
      if (routedId !== next.primary && routedId !== next.secondary) navigate(workspace.id);
    },

    end() {
      lit = null;
      if (!carried) return;
      carried = null;
      emit();
    },
  };
}

/**
 * The smallest a ghost may be drawn: a sidebar row's own 36px icon slot, and
 * enough width beside it for a workspace name to be read rather than clipped.
 */
const GHOST_MIN_WIDTH_PX = 176;
const GHOST_MIN_HEIGHT_PX = 36;

/**
 * The whole gesture, for a surface that only ever carries — no rail to
 * reorder against, so there is nothing to decide but whether the press became
 * a drag.
 *
 * The ghost is cut from whatever was pressed, so a workspace picked up by its
 * name in a tab strip lifts off that name. Past the threshold the click is
 * swallowed, which is what lets the same button be a menu on a press and a
 * grip on a drag.
 */
export function startCarryDrag({
  event,
  workspace,
  routedId,
  lookup,
  navigate,
}: {
  event: ReactPointerEvent<HTMLElement>;
  workspace: Workspace;
  routedId: string | null;
  lookup: (workspaceId: string) => Workspace | undefined;
  navigate: (workspaceId: string) => void;
}): void {
  // Touch scrolls and long-presses; a carry is a pointer gesture.
  if (event.button !== 0 || event.pointerType === "touch") return;
  const element = event.currentTarget;
  // The ghost is dressed as a sidebar row, so it needs a row's box. A name in
  // a tab strip is shorter and narrower than one, so the grabbed element's
  // box is floored rather than copied — and floored about its own middle, so
  // what grows stays under the cursor that grabbed it.
  const box = element.getBoundingClientRect();
  const width = Math.max(box.width, GHOST_MIN_WIDTH_PX);
  const height = Math.max(box.height, GHOST_MIN_HEIGHT_PX);
  const origin = {
    left: box.left + box.width / 2 - width / 2,
    top: box.top + box.height / 2 - height / 2,
    width,
    height,
  };
  const start = { x: event.clientX, y: event.clientY };
  let carry: WorkspaceCarry | null = null;
  let capturedPointer: number | null = null;

  const finish = (commit: boolean, clientX: number, clientY: number) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointercancel", onCancel);
    if (capturedPointer !== null && element.hasPointerCapture(capturedPointer)) {
      element.releasePointerCapture(capturedPointer);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    element.style.opacity = "";
    if (!carry) return;
    // The press became a drag, so the click it is about to fire is not one.
    const swallowClick = (clickEvent: Event) => {
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
    };
    document.addEventListener("click", swallowClick, { capture: true, once: true });
    window.setTimeout(() => document.removeEventListener("click", swallowClick, true), 0);
    if (commit) carry.drop(clientX, clientY);
    carry.end();
  };

  function onMove(moveEvent: PointerEvent) {
    if (!carry) {
      if (Math.abs(moveEvent.clientX - start.x) < 5 && Math.abs(moveEvent.clientY - start.y) < 5) {
        return;
      }
      // Claimed only now, never at pointerdown: capture retargets the
      // compatibility mouse events too, so a captured press that turned out to
      // be a plain click would fire it here rather than on the menu trigger.
      // From here the pointer has to cross the whole canvas — terminals and
      // grids that handle pointer events of their own, any one of which could
      // stop a move from reaching the document and strand the drag.
      try {
        element.setPointerCapture(moveEvent.pointerId);
        capturedPointer = moveEvent.pointerId;
      } catch {
        // The pointer went away; the document listeners still carry the drag.
      }
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      // What was pressed stays where it is, dimmed, while the ghost travels.
      element.style.opacity = "0.4";
      carry = createWorkspaceCarry({ workspace, routedId, lookup, origin, start, navigate });
      carry.show(moveEvent.clientX, moveEvent.clientY);
      return;
    }
    moveEvent.preventDefault();
    carry.track(moveEvent.clientX, moveEvent.clientY);
  }

  const onUp = (upEvent: PointerEvent) => finish(true, upEvent.clientX, upEvent.clientY);
  const onCancel = () => finish(false, start.x, start.y);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
  document.addEventListener("pointercancel", onCancel);
}

/**
 * A workspace on its way somewhere: the thing it was picked up by, lifted,
 * and a live picture of the window it is about to make.
 *
 * The preview is one panel per workspace, not one per half. A panel is a
 * workspace's own box that moves to whichever half it will occupy, so a drop
 * that swaps two workspaces is drawn as two boxes trading places and a drop
 * that displaces one is drawn as its box fading where it stood. Panels keyed
 * by half instead would only ever be able to cut from one label to another,
 * which says that something changed without saying what.
 *
 * Portalled to the body because the shell is a container query, and a
 * container establishes the containing block for `fixed` descendants — an
 * overlay rendered inside it would be positioned against the shell rather
 * than the viewport.
 *
 * Nothing here re-renders during the drag. The ghost's transform and every
 * panel's position are written straight to the DOM by the gesture; React's
 * style prop holds only the opening values.
 *
 * The ghost is dressed as an expanded sidebar row wherever it was picked up
 * from: it is a picture of the workspace itself, and the rail's row is the
 * form that workspace already has everywhere else in the product.
 */
export function WorkspaceCarryOverlay() {
  const inFlight = useSyncExternalStore(carryStore.subscribe, carryStore.get, () => null);
  if (!inFlight) return null;
  const zoneFor = (side: SplitSide | null) =>
    inFlight.zones.find((zone) => zone.side === side) ?? inFlight.zones[0];
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[105]">
      <div
        ref={(element) => {
          previewEl = element;
        }}
        data-live="false"
        className="opacity-0 transition-opacity duration-120 ease-swift data-[live=true]:opacity-100"
      >
        {inFlight.cast.map((member) => {
          const side = sideOf(member.id, inFlight.arrangement);
          // A member with nowhere to be yet — the carried workspace, which is
          // still in the rail — waits at the half it would most likely take,
          // so its first move is a short slide rather than a flight in from
          // the corner an unset transform would start it at.
          const zone = zoneFor(side);
          return (
            <div
              key={member.id}
              data-preview-panel={member.id}
              data-shown={String(side !== null)}
              data-lit="false"
              style={{
                transform: zone ? `translate(${zone.rect.left}px, ${zone.rect.top}px)` : undefined,
                width: zone ? zone.rect.right - zone.rect.left : undefined,
                height: zone ? zone.rect.bottom - zone.rect.top : undefined,
              }}
              className={cn(
                "fixed left-0 top-0 flex flex-col items-center justify-center gap-2.5 p-4",
                "rounded-xl border-2 border-dashed border-border bg-foreground/5",
                "backdrop-blur-[2px] text-center",
                "transition-[transform,width,height,opacity,border-color,background-color]",
                "duration-120 ease-swift",
                // Displaced: it is not in the window this drop would make.
                "data-[shown=false]:opacity-0",
                // The half the carried workspace lands in, in the same ink the
                // tab strip's duplicate ghost uses for the same promise.
                "data-[lit=true]:border-solid data-[lit=true]:border-ring data-[lit=true]:bg-ring/10",
              )}
            >
              <WorkspaceAvatar
                name={member.name}
                icon={member.icon}
                rail
                className="size-12 rounded-xl text-sm"
              />
              <span className="max-w-full truncate text-sm font-medium text-foreground">
                {member.name}
              </span>
            </div>
          );
        })}
      </div>
      <div
        ref={(element) => {
          ghostEl = element;
        }}
        style={{
          left: inFlight.origin.left,
          top: inFlight.origin.top,
          width: inFlight.origin.width,
          height: inFlight.origin.height,
          transform: `translate(${inFlight.offset.x}px, ${inFlight.offset.y}px)`,
        }}
        className={cn(
          "fixed z-[110] flex items-center rounded-lg bg-shell text-sm text-foreground",
          "shadow-[0_6px_16px_rgb(0_0_0/0.35)]",
        )}
      >
        <SidebarIconSlot>
          <WorkspaceAvatar name={inFlight.workspace.name} icon={inFlight.workspace.icon} />
        </SidebarIconSlot>
        <SidebarRowLabel collapsed={false} className="font-medium">
          {inFlight.workspace.name}
        </SidebarRowLabel>
      </div>
    </div>,
    document.body,
  );
}
