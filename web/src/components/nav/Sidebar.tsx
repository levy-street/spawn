"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { LegionStrip } from "@/components/legion/LegionStrip";
import { SidebarArchivedSection } from "@/components/nav/SidebarArchivedSection";
import { SidebarWorkspacePair, SidebarWorkspaceRow } from "@/components/nav/SidebarWorkspaceRow";
import {
  SidebarIconSlot,
  SidebarNoMatches,
  SidebarRowLabel,
  SidebarSearch,
  sidebarRowClass,
  WorkspaceAvatar,
} from "@/components/nav/sidebar-parts";
import {
  type Arrangement,
  arrangementAfter,
  type DragMode,
  type DropZone,
  dragModeAt,
  dropZones,
  type PaneTarget,
  pairRows,
  reorderShift,
  reorderTargetIndex,
  reorderWrites,
  sideOf,
  splitDropPlan,
  zoneAt,
} from "@/components/nav/workspace-drag";
import { openProfile } from "@/components/profile/profile-dialog-store";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { RailTooltip } from "@/components/ui/tooltip";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { PANE_SCOPE_ATTR, paneRootAt } from "@/components/workspace/pane-scope";
import { hosts, sessions, type Workspace, workspaces } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { type SplitSide, splitStore, useSplit } from "@/lib/split-store";
import { cn } from "@/lib/utils";
import {
  filterWorkspacesByName,
  workspaceAttentionCount,
  workspaceLiveSessionCount,
} from "@/lib/workspaces";

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

/** A workspace row in flight, and the halves it may be released into. */
interface CarriedWorkspace {
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
   * The row's resting box, with no drag applied. The travel is the ghost's
   * transform and only its transform — folding it in here as well counted it
   * twice, and the ghost pulled away from the cursor at double rate.
   */
  origin: { left: number; top: number; width: number; height: number };
  /**
   * The travel at the moment the carry began, rendered as the ghost's opening
   * transform. `trackCarry` cannot reach the element until the commit after
   * this one, so without it the ghost would draw one frame back at the row it
   * came from and then jump to the pointer.
   */
  offset: { x: number; y: number };
}

export function Sidebar({
  pathname,
  collapsed,
  onToggle,
  onNavigate,
  showCollapseControl = true,
}: {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  showCollapseControl?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Set only while a row is out on the canvas. Everything that changes on a
  // per-frame basis inside a carry — the ghost's transform, where each preview
  // panel sits — is written straight to the DOM through these refs, so React
  // renders the overlay once per carry rather than once per pointer move.
  const [carried, setCarried] = useState<CarriedWorkspace | null>(null);
  const carryGhostRef = useRef<HTMLDivElement>(null);
  const carryPreviewRef = useRef<HTMLDivElement>(null);

  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    refetchInterval: 30_000,
  });
  // Its own key: the archived list must never leak into ["workspaces"], which
  // seven other surfaces read as "the workspaces I have".
  const archivedQ = useQuery({
    queryKey: ["workspaces", "archived"],
    queryFn: () => workspaces.list({ archived: true }),
    staleTime: 30_000,
  });
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 30_000,
  });

  const orderedWorkspaces = useMemo(
    () => [...(workspacesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [workspacesQ.data],
  );
  // What the tree actually renders. Reordering is disabled while a search is
  // narrowing the list: a drop index counted over visible rows would mean
  // something different from the position the server writes.
  const visibleWorkspaces = useMemo(
    () => filterWorkspacesByName(orderedWorkspaces, query),
    [orderedWorkspaces, query],
  );
  const searching = query.trim().length > 0;
  // Archived rows are in here too: a workspace on screen can have been put
  // away since, and the drop preview still has to be able to name and draw
  // whatever is currently occupying a half.
  const workspaceById = useMemo(() => {
    const index = new Map<string, Workspace>();
    for (const item of [...orderedWorkspaces, ...(archivedQ.data ?? [])]) index.set(item.id, item);
    return index;
  }, [archivedQ.data, orderedWorkspaces]);
  const sessionsById = useMemo(
    () => new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
    [sessionsQ.data],
  );
  const onlineHosts = (hostsQ.data ?? []).filter((host) => host.status === "online");
  const currentWorkspaceId = /^\/w\/([^/?]+)/u.exec(pathname)?.[1] ?? null;
  // The workspace beside the routed one. It is on screen just as much as the
  // routed one is, so the rail has to say so — a row that reads as unvisited
  // while its workspace fills half the window is simply wrong. The *rendered*
  // one, not the stored pair: a window too narrow to draw a split is showing
  // one workspace, whatever arrangement it is holding for when it widens.
  const { renderedSecondaryId, activeSide } = useSplit();
  // What the tree draws, row by row: normally one workspace each, but a split
  // draws as a single paired row so the rail is a picture of the window
  // rather than a list that happens to contain it. The collapsed rail opts
  // out — two containers and a control between them do not survive a 56px
  // column, so there the pair stays two separately ringed tiles.
  const rowModel = useMemo(
    () =>
      pairRows(
        visibleWorkspaces.map((workspace) => workspace.id),
        collapsed ? null : currentWorkspaceId,
        collapsed ? null : renderedSecondaryId,
      ),
    [collapsed, currentWorkspaceId, renderedSecondaryId, visibleWorkspaces],
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    // Matches ["workspaces"] and ["workspaces", "archived"] both: archiving
    // moves a row from one list to the other, so they always move together.
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // The singular key the workspace page reads is a different cache entry —
    // and it is the one that decides whether that page draws a live canvas or
    // an archived snapshot.
    queryClient.invalidateQueries({ queryKey: ["workspace"] });
    queryClient.invalidateQueries({ queryKey: ["hosts"] });
  };

  const renameWorkspaceM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => workspaces.update(id, { name }),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const iconWorkspaceM = useMutation({
    // "custom" whichever way it went: a mark chosen here, and initials chosen
    // here, are both the owner's answer — the folder scan must not undo it.
    mutationFn: ({ id, icon }: { id: string; icon: string | null }) =>
      workspaces.update(id, { icon, icon_source: "custom" }),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const reorderWorkspaceM = useMutation({
    // The server reorders by removal + reinsertion, so a single position
    // write is a proper insert-at-index for the drag drop. A row can hold two
    // workspaces — a split draws as one paired row — so this takes a sequence
    // and applies it strictly in order: the second write's index is only
    // correct against the list the first one leaves behind.
    mutationFn: async (writes: { id: string; position: number }[]) => {
      for (const write of writes) await workspaces.update(write.id, { position: write.position });
    },
    // Optimistic: the drop lands instantly instead of snapping back for a
    // round-trip; refresh reconciles either way.
    onMutate: (writes) => {
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) => {
        if (!current) return current;
        let ordered = [...current].sort((a, b) => a.position - b.position);
        for (const write of writes) {
          const moving = ordered.find((workspace) => workspace.id === write.id);
          if (!moving) continue;
          const without = ordered.filter((workspace) => workspace.id !== write.id);
          without.splice(write.position, 0, moving);
          ordered = without;
        }
        return ordered.map((workspace, index) => ({ ...workspace, position: index }));
      });
    },
    onSuccess: refresh,
    onError: (error) => {
      refresh();
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });
  const deleteWorkspaceM = useMutation({
    mutationFn: (id: string) => workspaces.remove(id),
    onSuccess: (_result, id) => {
      setActionError(null);
      refresh();
      // A workspace on the right of a split is not the page it is on, so the
      // correction is to close that half. Routing away would take the
      // workspace on the left — which nothing happened to — with it. The
      // stored pair, not the rendered one: a deleted workspace must not be
      // left queued up to reappear when the window widens.
      if (splitStore.get().secondaryId === id) splitStore.close();
      else if (currentWorkspaceId === id) router.push("/app");
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const archiveWorkspaceM = useMutation({
    mutationFn: ({ id }: { id: string; name: string; nextId: string | null }) =>
      workspaces.archive(id),
    onSuccess: (_result, { id, name, nextId }) => {
      setActionError(null);
      refresh();
      // Said out loud, because the row leaves the list under your cursor and
      // the only other evidence is a drawer that is probably closed.
      toast(`Archived ${name}`);
      // Archived out of the right of a split: that half closes and the window
      // goes back to one workspace. Nothing about the left half changed, so
      // nothing about it should move. The stored pair again — an archived
      // workspace must not come back with the next widening.
      if (splitStore.get().secondaryId === id) {
        splitStore.close();
        return;
      }
      // And carry on next door: the workspace you were looking at is stopped
      // now, so the useful place to be is the one that took its slot.
      if (currentWorkspaceId === id) {
        router.push(nextId ? `/w/${nextId}` : "/app");
        onNavigate?.();
      }
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const unarchiveWorkspaceM = useMutation({
    mutationFn: (id: string) => workspaces.unarchive(id),
    onSuccess: (workspace) => {
      setActionError(null);
      refresh();
      router.push(`/w/${workspace.id}`);
      onNavigate?.();
    },
    // Restoring is a deliberate act with its own outcome, and the sidebar's
    // inline error sits above a list the restored row is not in yet.
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const workspaceBusy =
    renameWorkspaceM.isPending ||
    iconWorkspaceM.isPending ||
    reorderWorkspaceM.isPending ||
    deleteWorkspaceM.isPending ||
    archiveWorkspaceM.isPending ||
    unarchiveWorkspaceM.isPending;

  /**
   * Drag a workspace row. Pointer-based with a small threshold, so a plain
   * click still navigates, and the click that follows a real drag is
   * swallowed either way.
   *
   * Past the threshold the gesture has two modes, and which one is live is
   * decided by where the pointer is, freshly, on every move — so a row can be
   * taken out to the canvas and brought back without lifting. Over the rail
   * it reorders: the row translates with the pointer and the drop index is
   * the number of other rows whose midpoint sits above the release point.
   * Out on the canvas it is being carried into a half of the window instead,
   * the rail settles back into its resting order, and the reorder is off the
   * table until the pointer comes home.
   */
  const startWorkspaceDrag = (workspace: Workspace, event: ReactPointerEvent<HTMLLIElement>) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    // A paired row's halves are real buttons, so the usual "pressed a control,
    // not the row" guard would refuse to start a drag on one. They are the row
    // for dragging purposes; everything else that is a button still blocks.
    const pressedControl = (event.target as Element).closest?.("button, input, [role='menu']");
    if (pressedControl && !pressedControl.hasAttribute("data-pair-half")) return;
    const rowElement = event.currentTarget;
    const startY = event.clientY;
    const startX = event.clientX;
    let dragging = false;
    let mode: DragMode = "reorder";
    let litSide: SplitSide | null = null;
    let capturedPointer: number | null = null;
    // Geometry is captured up front: rows shift with transforms mid-drag, so
    // both the target index and the shift math must use the resting rects.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-row]"));
    const restingRects = rows.map((row) => row.getBoundingClientRect());
    // What each row actually holds. A paired row is one row and two
    // workspaces, so the index counted over rows is not the position the
    // server stores and this is what closes that gap.
    // Falling back to the row's own id rather than to nothing: an empty entry
    // here yields no writes at all, so a row type that ever forgets the
    // attribute would silently stop reordering rather than fail loudly.
    const rowIds = rows.map((row) => {
      const held = (row.dataset.rowIds ?? "").split(" ").filter(Boolean);
      return held.length > 0 ? held : [row.dataset.workspaceRow ?? ""].filter(Boolean);
    });
    const from = rows.indexOf(rowElement);
    const fromRect = restingRects[from];
    const rowStride = (fromRect?.height ?? 36) + 8; // + the list's space-y-2
    // The box the pointer has to leave for this to stop being a reorder. Read
    // once, because the rail does not resize under a drag it is hosting.
    const railRect = rowElement.closest("[data-sidebar-rail]")?.getBoundingClientRect() ?? null;
    let lastTarget = from;

    /** The lifted-off-the-list treatment, worn by whichever thing is moving. */
    const lift = (on: boolean) => {
      rowElement.style.zIndex = on ? "10" : "";
      rowElement.style.position = on ? "relative" : "";
      rowElement.style.background = on ? "var(--shell)" : "";
      rowElement.style.borderRadius = on ? "0.5rem" : "";
      rowElement.style.boxShadow = on ? "0 6px 16px rgb(0 0 0 / 0.35)" : "";
    };

    const enterCarry = (clientX: number, clientY: number) => {
      // The rows keep the transition they were displaced with, so clearing
      // the transforms springs them home rather than snapping them.
      rowElement.style.transition =
        "transform 150ms var(--ease-swift, ease-out), opacity 150ms var(--ease-swift, ease-out)";
      for (const row of rows) row.style.transform = "";
      lastTarget = from;
      lift(false);
      // The row itself stays in the rail, dimmed, and a ghost is what follows
      // the pointer: pulling the element out of flow would close the list up
      // under it and invalidate the very rects the reorder half measures from.
      rowElement.style.opacity = "0.4";
      const { ratio, renderedSecondaryId: rendered } = splitStore.get();
      const arrangement: Arrangement = { primary: currentWorkspaceId, secondary: rendered };
      setCarried({
        workspace,
        zones: dropZones(measurePanes(), ratio),
        // The carried workspace first, so a preview built while the workspace
        // list is still loading at least has the thing being dragged in it.
        cast: [workspace.id, arrangement.primary, arrangement.secondary]
          .filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)
          .map((id) => workspaceById.get(id))
          .filter((member): member is Workspace => Boolean(member)),
        arrangement,
        origin: {
          left: fromRect?.left ?? 0,
          top: fromRect?.top ?? 0,
          width: fromRect?.width ?? 0,
          height: fromRect?.height ?? 0,
        },
        offset: { x: clientX - startX, y: clientY - startY },
      });
    };

    const enterReorder = () => {
      rowElement.style.transition = "";
      rowElement.style.opacity = "";
      lift(true);
      litSide = null;
      setCarried(null);
    };

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
     * Redraw the preview as the window it would leave behind. Each panel is a
     * workspace rather than a slot, so a workspace that changes halves travels
     * there and one that is being displaced fades where it stands — which is
     * the whole answer to "what happens if I let go here".
     */
    const showArrangement = (side: SplitSide | null) => {
      const layer = carryPreviewRef.current;
      if (!layer) return;
      // Off the canvas the preview withdraws but keeps its last arrangement,
      // so leaving reads as the preview fading rather than as it rearranging
      // itself into something nobody asked for on the way out.
      layer.dataset.live = String(side !== null);
      if (!side) return;
      const { ratio, renderedSecondaryId: rendered } = splitStore.get();
      const zones = dropZones(measurePanes(), ratio);
      const next = arrangementAfter(
        splitDropPlan(side, workspace.id, currentWorkspaceId, rendered),
        currentWorkspaceId,
        rendered,
      );
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

    const trackCarry = (clientX: number, clientY: number) => {
      const ghost = carryGhostRef.current;
      // The overlay is one render behind the move that started the carry. It
      // renders itself already in position, so there is nothing to correct
      // until it exists — and `litSide` must not advance without it, or the
      // arrangement it names would never be drawn.
      if (!ghost || !carryPreviewRef.current) return;
      ghost.style.transform = `translate(${clientX - startX}px, ${clientY - startY}px)`;
      const side = sideUnder(clientX, clientY);
      if (side === litSide) return;
      litSide = side;
      showArrangement(side);
    };

    const drop = (clientX: number, clientY: number) => {
      const side = sideUnder(clientX, clientY);
      if (!side) return;
      // Judged against the half that is *rendered*, because that is what the
      // zones were drawn from: a window too narrow to draw a split offers the
      // two halves of its one pane, and reading the stored pair here would
      // answer a drop on those halves as though a split were already up.
      const plan = splitDropPlan(
        side,
        workspace.id,
        currentWorkspaceId,
        splitStore.get().renderedSecondaryId,
      );
      // Null is the drop that asks for the arrangement already on screen —
      // released onto the half the workspace is in. Ending here rather than
      // reasserting it is what keeps that from flickering.
      if (!plan) return;
      // The pair is set before the route changes, so the reconcile that
      // follows navigation sees the arrangement this drop asked for rather
      // than the one it is replacing.
      if (plan.setSecondary) splitStore.open(plan.setSecondary, plan.routeTo ?? currentWorkspaceId);
      if (plan.routeTo) {
        router.push(`/w/${plan.routeTo}`);
        onNavigate?.();
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientY - startY) < 5 && Math.abs(moveEvent.clientX - startX) < 5) {
          return;
        }
        dragging = true;
        // Claimed only now, never at pointerdown: capture retargets the
        // compatibility mouse events too, so a captured press that turns out
        // to be a plain click would fire that click on the row instead of the
        // anchor inside it and stop navigating. Past the threshold the click
        // is being swallowed anyway, and from here the pointer has to cross
        // the whole canvas — over terminals and grids that handle pointer
        // events of their own, any one of which could otherwise stop a move
        // from reaching the document and strand the drag mid-flight.
        try {
          rowElement.setPointerCapture(moveEvent.pointerId);
          capturedPointer = moveEvent.pointerId;
        } catch {
          // The pointer went away between the move and this call; the
          // document listeners below still carry the drag on their own.
        }
        lift(true);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      moveEvent.preventDefault();
      const nextMode = dragModeAt(moveEvent.clientX, moveEvent.clientY, railRect);
      if (nextMode !== mode) {
        mode = nextMode;
        if (mode === "carry") enterCarry(moveEvent.clientX, moveEvent.clientY);
        else enterReorder();
      }
      if (mode === "carry") {
        trackCarry(moveEvent.clientX, moveEvent.clientY);
        return;
      }
      rowElement.style.transform = `translateY(${moveEvent.clientY - startY}px)`;
      // Everything between the old and prospective slot slides one stride to
      // make room, so the drop target is always visible.
      const target = reorderTargetIndex(moveEvent.clientY, restingRects, from);
      if (target === lastTarget) return;
      lastTarget = target;
      rows.forEach((row, index) => {
        if (row === rowElement) return;
        const shift = reorderShift(index, from, target, rowStride);
        row.style.transition = "transform 150ms var(--ease-swift, ease-out)";
        row.style.transform = shift === 0 ? "" : `translateY(${shift}px)`;
      });
    };
    const finish = (commit: boolean, clientX: number, clientY: number) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointercancel", onCancel);
      if (capturedPointer !== null && rowElement.hasPointerCapture(capturedPointer)) {
        rowElement.releasePointerCapture(capturedPointer);
      }
      for (const row of rows) {
        row.style.transform = "";
        row.style.transition = "";
      }
      lift(false);
      rowElement.style.opacity = "";
      setCarried(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (!dragging) return;
      const swallowClick = (clickEvent: Event) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      };
      document.addEventListener("click", swallowClick, { capture: true, once: true });
      window.setTimeout(
        () => document.removeEventListener("click", swallowClick, { capture: true }),
        0,
      );
      if (!commit) return;
      if (mode === "carry") {
        drop(clientX, clientY);
        return;
      }
      const target = reorderTargetIndex(clientY, restingRects, from);
      if (target === from) return;
      // The whole row moves, however many workspaces it holds: a split was
      // dragged as one thing, so it arrives as one thing.
      const writes = reorderWrites(rowIds, from, target);
      if (writes.length > 0) reorderWorkspaceM.mutate(writes);
    };
    const onUp = (upEvent: PointerEvent) => finish(true, upEvent.clientX, upEvent.clientY);
    const onCancel = () => finish(false, startX, startY);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onCancel);
  };

  /**
   * Archiving stops the work and keeps everything else, so it only stops to
   * ask when there is work to stop: a workspace of stopped windows archives
   * on the click. The destructive copy stays on Delete, which keeps nothing.
   */
  const requestWorkspaceArchive = async (workspace: Workspace) => {
    const live = workspaceLiveSessionCount(workspace, sessionsById);
    if (live > 0) {
      const accepted = await confirm({
        title: `Archive ${workspace.name}?`,
        body: `${live} running ${live === 1 ? "session" : "sessions"} will be stopped. The layout is kept — restore it any time from Archived and every window starts again where it is.`,
        confirmLabel: "Archive workspace",
      });
      if (!accepted) return;
    }
    archiveWorkspaceM.mutate({
      id: workspace.id,
      name: workspace.name,
      // The row that will sit where this one did — or the one above it when
      // this was the last, and nothing at all when it was the only one.
      nextId: (() => {
        const index = orderedWorkspaces.findIndex((row) => row.id === workspace.id);
        if (index < 0) return null;
        return (orderedWorkspaces[index + 1] ?? orderedWorkspaces[index - 1])?.id ?? null;
      })(),
    });
  };

  const requestArchivedDelete = async (workspace: Workspace) => {
    const accepted = await confirm({
      title: `Delete ${workspace.name} forever?`,
      body: "Its layout is discarded. This cannot be undone.",
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (accepted) deleteWorkspaceM.mutate(workspace.id);
  };

  const requestWorkspaceDelete = async (workspace: Workspace) => {
    const accepted = await confirm({
      title: `Delete ${workspace.name}?`,
      body: "Every session in this workspace will be closed and its process will be killed.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (accepted) deleteWorkspaceM.mutate(workspace.id);
  };

  const newWorkspaceButton = (
    // Dressed exactly like the workspace rows below it.
    <button
      type="button"
      onClick={
        onlineHosts.length > 0
          ? undefined
          : () => {
              onNavigate?.();
              router.push("/device");
            }
      }
      className={cn(sidebarRowClass(false), "group/new")}
    >
      <SidebarIconSlot>
        <Plus className="size-4 transition-transform duration-150 group-hover/new:rotate-90" />
      </SidebarIconSlot>
      <SidebarRowLabel collapsed={collapsed}>New workspace</SidebarRowLabel>
    </button>
  );

  return (
    // `data-sidebar-rail` is what a workspace drag measures itself against:
    // leaving this box is the moment the gesture stops being a reorder.
    <div data-sidebar-rail className="group/rail flex h-full min-h-0 flex-col bg-shell">
      {/* h-9, not the --row-h nav rhythm: this row holds the 36px trident
       * plate and nothing that has to line up with the tree below it, so the
       * lockup sits tighter to the top edge than a nav row would. */}
      <div className="px-2.5 pb-1.5 pt-2.5">
        <div className="flex h-9 items-center">
          {/* The whole lockup goes home, not just the trident: the wordmark
           * carries a second link to the same place, hovering either lights
           * the trident's plate, and only the trident is in the tab order and
           * the accessibility tree — two stops reading "spawnd home" back to
           * back is noise, and the wordmark is the redundant one. */}
          <div className="group/home flex min-w-0 flex-1 items-center">
            {collapsed ? (
              <RailTooltip label="Expand sidebar">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Expand sidebar"
                  onClick={onToggle}
                  className="size-9 shrink-0"
                >
                  {/* Anywhere on the rail, not just this button: reaching for
                   * the sidebar at all is the intent, and the swap tells you
                   * the mark is a door back before you get to it. */}
                  <Trident className="size-5.5 group-hover/rail:hidden" />
                  <PanelLeftOpen
                    className="hidden size-4.5 text-muted-foreground group-hover/rail:block"
                    aria-hidden
                  />
                </Button>
              </RailTooltip>
            ) : (
              <Link
                href="/"
                onClick={onNavigate}
                className="grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors group-hover/home:bg-accent/50"
                aria-label="spawnd home"
              >
                <Trident className="size-5.5" />
              </Link>
            )}
            {/* The lockup, not two marks: `flex items-center` centres the
             * wordmark on the trident's axis (left to itself the mask is an
             * inline-block and sits on the row's text baseline, 3px high), and
             * hellfire is the brand ink the trident is drawn in — the chrome
             * accent would swap it to the dark-theme ember and split the pair. */}
            <SidebarRowLabel collapsed={collapsed} className="ml-1.5 flex items-center">
              <Link
                href="/"
                onClick={onNavigate}
                aria-hidden
                tabIndex={-1}
                className={cn(
                  "flex items-center text-hellfire",
                  // Faded out on the rail, so it must not still be a target
                  // sitting in the empty space beside the trident.
                  collapsed && "pointer-events-none",
                )}
              >
                <Wordmark className="h-[17px]" />
              </Link>
            </SidebarRowLabel>
          </div>
          {showCollapseControl ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Collapse sidebar"
              aria-hidden={collapsed}
              tabIndex={collapsed ? -1 : 0}
              onClick={onToggle}
              className={cn(
                // Muted like the expand control it mirrors: chrome, not a
                // destination.
                "size-7 shrink-0 text-muted-foreground hover:text-foreground",
                collapsed
                  ? "pointer-events-none opacity-0 duration-100"
                  : "opacity-100 delay-75 duration-150",
              )}
            >
              <PanelLeftClose className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close sidebar"
              onClick={onNavigate}
              className="size-8 shrink-0"
            >
              <X className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <div className="border-y border-border px-2.5 py-2">
        <RailTooltip label="New workspace" disabled={!collapsed}>
          {onlineHosts.length > 0 ? (
            <NewWorkspaceMenu
              trigger={newWorkspaceButton}
              onCreated={({ workspaceId, focusSessionId }) => {
                refresh();
                router.push(
                  focusSessionId
                    ? `/w/${workspaceId}?focus=${focusSessionId}`
                    : `/w/${workspaceId}`,
                );
                onNavigate?.();
              }}
            />
          ) : (
            newWorkspaceButton
          )}
        </RailTooltip>
      </div>

      <nav aria-label="Workspaces" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-2.5">
        {actionError && !collapsed && (
          <p className="px-1.5 pb-2 text-xs text-destructive" role="alert">
            {actionError}
          </p>
        )}
        {!collapsed && orderedWorkspaces.length > 1 && (
          // Full-bleed rule under the box, matching the section rules above
          // and below the tree: the search is chrome, the list beneath it is
          // the content it filters.
          <div className="-mx-2.5 mb-2.5 border-b border-border px-2.5 pb-2.5">
            <SidebarSearch value={query} onChange={setQuery} label="Search workspaces" />
          </div>
        )}
        {!collapsed && !workspacesQ.isLoading && orderedWorkspaces.length === 0 && (
          <p className="px-2 py-4 text-xs leading-5 text-muted-foreground">
            Your workspaces will appear here.
          </p>
        )}
        {!collapsed && searching && visibleWorkspaces.length === 0 && (
          <SidebarNoMatches query={query.trim()} />
        )}
        <ul className="space-y-2">
          {rowModel.map((ids) => {
            const [firstId, secondId] = ids;
            const workspace = firstId ? workspaceById.get(firstId) : undefined;
            if (!workspace) return null;
            const partner = secondId ? workspaceById.get(secondId) : undefined;
            if (partner) {
              return (
                <SidebarWorkspacePair
                  key={ids.join("+")}
                  primary={workspace}
                  secondary={partner}
                  activeSide={activeSide}
                  primaryAttention={workspaceAttentionCount(workspace, sessionsById)}
                  secondaryAttention={workspaceAttentionCount(partner, sessionsById)}
                  onActivate={(side) => splitStore.setActiveSide(side)}
                  onUnsplit={() => splitStore.close()}
                  onRowPointerDown={
                    searching
                      ? undefined
                      : (event) => {
                          // Which half was pressed decides what gets carried
                          // out to the canvas; the row as a whole is still
                          // what reorders.
                          const half = (event.target as Element).closest?.("[data-pair-half]");
                          const pressed = half?.getAttribute("data-pair-half");
                          startWorkspaceDrag(
                            (pressed ? workspaceById.get(pressed) : null) ?? workspace,
                            event,
                          );
                        }
                  }
                />
              );
            }
            return (
              <SidebarWorkspaceRow
                key={workspace.id}
                workspace={workspace}
                active={currentWorkspaceId === workspace.id}
                beside={renderedSecondaryId === workspace.id}
                collapsed={collapsed}
                attentionCount={workspaceAttentionCount(workspace, sessionsById)}
                busy={workspaceBusy}
                onNavigate={onNavigate}
                onRename={(name) => renameWorkspaceM.mutate({ id: workspace.id, name })}
                onIcon={(icon) => iconWorkspaceM.mutate({ id: workspace.id, icon })}
                onArchive={() => void requestWorkspaceArchive(workspace)}
                onDelete={() => void requestWorkspaceDelete(workspace)}
                onRowPointerDown={
                  searching ? undefined : (event) => startWorkspaceDrag(workspace, event)
                }
              />
            );
          })}
        </ul>
      </nav>

      <SidebarArchivedSection
        workspaces={archivedQ.data ?? []}
        collapsed={collapsed}
        busy={workspaceBusy}
        currentWorkspaceId={currentWorkspaceId}
        onNavigate={onNavigate}
        onRestore={(workspace) => unarchiveWorkspaceM.mutate(workspace.id)}
        onDelete={(workspace) => void requestArchivedDelete(workspace)}
      />

      {/* Below Archived and above Settings: the machines you own are footer
       * furniture like the drawer over them, not a live ticker competing with
       * the workspace tree. Fed from the queries above rather than its own —
       * the section must not cost a request, and its counts must never
       * disagree with the rows it sits under. */}
      <LegionStrip
        hosts={hostsQ.data ?? []}
        sessions={sessionsQ.data ?? []}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />

      <div className="border-y border-border px-2.5 py-2">
        <RailTooltip label="Settings" disabled={!collapsed}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onNavigate?.();
              openSettings("account");
            }}
            className={cn(sidebarRowClass(false), "justify-start px-0")}
          >
            <SidebarIconSlot>
              <Settings className="size-4" aria-hidden />
            </SidebarIconSlot>
            <SidebarRowLabel collapsed={collapsed}>Settings</SidebarRowLabel>
          </Button>
        </RailTooltip>

        <DropdownMenu
          side="top"
          align="start"
          className="block w-full"
          renderTrigger={(props) => (
            <RailTooltip label={user?.email ?? "Account"} disabled={!collapsed}>
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Account menu"
                className={cn(sidebarRowClass(false), "h-11 justify-start px-0")}
              >
                <SidebarIconSlot>
                  <span className="grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-secondary-foreground">
                    {(user?.email ?? "?").slice(0, 1)}
                  </span>
                </SidebarIconSlot>
                <SidebarRowLabel collapsed={collapsed} className="text-xs">
                  {user?.email ?? "—"}
                </SidebarRowLabel>
              </Button>
            </RailTooltip>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              onNavigate?.();
              openProfile();
            }}
          >
            <UserRound className="size-4" aria-hidden />
            Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Settings has its own rail row above; Access keeps the one-click
              reach the v5 Access UX asks for (docs/TRUST_UX.md). */}
          <DropdownMenuItem onSelect={() => openSettings("access")}>
            <ShieldCheck className="size-4" aria-hidden />
            Access
          </DropdownMenuItem>
          <DropdownMenuItem
            destructive
            onSelect={() => {
              void logout();
            }}
          >
            <LogOut className="size-4" aria-hidden />
            Log out
          </DropdownMenuItem>
        </DropdownMenu>
      </div>

      {carried && (
        <WorkspaceCarryOverlay
          carried={carried}
          ghostRef={carryGhostRef}
          previewRef={carryPreviewRef}
        />
      )}
    </div>
  );
}

/**
 * A workspace row on its way out of the rail: the row itself, lifted, and a
 * live picture of the window it is about to make.
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
 * than the viewport. It also keeps this out of the workspace tree entirely,
 * which is somebody else's file.
 *
 * Nothing here re-renders during the drag. The ghost's transform and every
 * panel's position are written to the DOM by the gesture through the two
 * refs; React's style prop holds only the opening values, so a sidebar
 * re-render (the session poll fires every five seconds) re-applies identical
 * values and therefore writes nothing.
 *
 * The ghost is dressed as an expanded row unconditionally: the collapsed rail
 * draws its workspaces as tiles that carry no `data-workspace-row`, so no drag
 * ever starts there and there is no rail-width ghost to draw.
 */
function WorkspaceCarryOverlay({
  carried,
  ghostRef,
  previewRef,
}: {
  carried: CarriedWorkspace;
  ghostRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
}) {
  const zoneFor = (side: SplitSide | null) =>
    carried.zones.find((zone) => zone.side === side) ?? carried.zones[0];
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[105]">
      <div
        ref={previewRef}
        data-live="false"
        className="opacity-0 transition-opacity duration-120 ease-swift data-[live=true]:opacity-100"
      >
        {carried.cast.map((member) => {
          const side = sideOf(member.id, carried.arrangement);
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
        ref={ghostRef}
        style={{
          left: carried.origin.left,
          top: carried.origin.top,
          width: carried.origin.width,
          height: carried.origin.height,
          transform: `translate(${carried.offset.x}px, ${carried.offset.y}px)`,
        }}
        className={cn(
          "fixed z-[110] flex items-center rounded-lg bg-shell text-sm text-foreground",
          "shadow-[0_6px_16px_rgb(0_0_0/0.35)]",
        )}
      >
        <SidebarIconSlot>
          <WorkspaceAvatar name={carried.workspace.name} icon={carried.workspace.icon} />
        </SidebarIconSlot>
        <SidebarRowLabel collapsed={false} className="font-medium">
          {carried.workspace.name}
        </SidebarRowLabel>
      </div>
    </div>,
    document.body,
  );
}
