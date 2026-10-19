"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CircleMinus,
  Copy,
  Ellipsis,
  FolderInput,
  Group,
  ImagePlus,
  LayoutTemplate,
  Merge,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Button } from "@/components/ui/button";
import type { CascadeMenuHandle } from "@/components/ui/cascade-menu";
import { confirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { MenuAnchor } from "@/components/ui/menu-position";
import { toast } from "@/components/ui/toast";
import { WorkspaceIconDialog } from "@/components/workspace/workspace-icon-dialog";
import {
  ApiError,
  agents,
  sessionAccess,
  sessions,
  type Workspace,
  workspaces,
  workspaceTemplates,
} from "@/lib/api";
import type { Rect, Tile } from "@/lib/grid";
import { GRID_SIZE, isFilesWidget } from "@/lib/grid";
import { sessionAgent } from "@/lib/sessions";
import {
  addTabToGroup,
  createGroup,
  hiddenTabIds,
  layoutGroups,
  nextGroupColor,
  removeTabFromGroup,
  stripIndexForGap,
  stripIndexForSlot,
  UNNAMED_GROUP,
  ungroup,
  updateGroup,
} from "@/lib/tab-groups";
import {
  addTab,
  allTiles,
  copyTabName,
  duplicateTab,
  type LayoutV3,
  MAX_TABS,
  nextTabName,
  removeTab,
  renameTab,
  reorderTab,
  type TabGroup,
  tabById,
  tabTiles,
  type WorkspaceTab,
  withActiveTab,
} from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { templateSpecFromWorkspace } from "@/lib/workspace-templates";
import {
  type AttentionLevel,
  tabAttentionCount,
  tabAttentionLevel,
  workspaceFolder,
  workspaceLiveSessionCount,
} from "@/lib/workspaces";
import { agentLaunchCommand, newAgentConversationId } from "./agent-command";
import { NewSessionMenu } from "./new-session-menu";
import { queryInPane, useOptionalPaneScope } from "./pane-scope";
import { pendingLaunch } from "./pending-launch";
import { type SplitChrome, SplitWorkspaceMenu, UnsplitButton } from "./split-chrome";
import { groupColorStyle, TabGroupEditor } from "./tab-group-editor";
import { type MergeDrop, type MergeRefusal, planMerge, WHOLE_CANVAS } from "./tab-merge";
import { dockZoneAt, freeRects, wantsDuplicate } from "./workspace-grid-helpers";

/** Travel that tells a reorder drag apart from a click, as in the grid. */
const DRAG_THRESHOLD_PX = 4;

/**
 * How far below the strip a tab has to be carried before the drag stops being
 * a reorder and becomes a merge, and how far back up it comes before it is a
 * reorder again. Two figures rather than one so a hand resting on the
 * boundary does not flicker between the two gestures, and the deeper of them
 * so ordinary sideways travel with a little downward drift never trips it.
 */
const MERGE_ENTER_PX = 28;
const MERGE_EXIT_PX = 8;

/**
 * How long a group's name or colour waits for the next keystroke or drag step
 * before it is written. The strip shows each change at once; this only spares
 * the server a PATCH per letter, and a close or any other write sends what is
 * pending straight away.
 */
const GROUP_WRITE_DEBOUNCE_MS = 400;

/** The tab group panel, and which label it hangs from. */
type GroupEditorState = {
  groupId: string;
  mode: "create" | "manage";
  /** Measured off the label once it is on screen; a group just created has
   *  no label until the render that follows. */
  anchor: MenuAnchor | null;
};

/** A pointerdown on a tab, waiting to see whether it becomes a reorder. */
type ArmedTabDrag = {
  move: (event: PointerEvent) => void;
  end: () => void;
};

/** One tab's resting geometry, measured when a reorder drag begins. */
type TabSlot = { id: string; left: number; width: number };

type TabDrag = {
  tabId: string;
  /** The tabs on screen when the drag began, in strip order. A collapsed
   *  group keeps most of its tabs out of sight, so `from`, `to` and
   *  `insertAt` count these, and the drop maps them back to the whole strip
   *  (`stripIndexForSlot`, `stripIndexForGap`). */
  visibleIds: string[];
  from: number;
  /** The slot the tab would land in were the pointer lifted now. */
  to: number;
  startClientX: number;
  /** The pointer's last x, so pressing ⌘/⌥ alone re-previews from where the
   *  drag already is rather than waiting for the next move. */
  lastClientX: number;
  /** Travel bounds that keep the dragged tab inside the strip's own tabs. */
  minDx: number;
  maxDx: number;
  /** What a passed-over tab gives up: the dragged tab's width plus the gap. */
  step: number;
  /** True while ⌘/⌥ is held: the drop duplicates the tab instead of moving it,
   *  and `insertAt` — not `to` — is the slot that matters. */
  duplicating: boolean;
  /** The slot the copy would take were the pointer lifted now, counted in the
   *  visible strip as it stands (so `visibleIds.length` means the end). */
  insertAt: number;
  /** This half's canvas, for the hit-test that turns the drag into a merge.
   *  Null when the strip is not inside a workspace half. */
  canvas: HTMLElement | null;
  /** True while the pointer is over the canvas: the drop folds this tab's
   *  windows into the open one instead of reordering the strip. */
  merging: boolean;
  /** The envelope the merge would write, recomputed whenever the aim moves
   *  to another opening or dock zone. Null while merging means the drop is
   *  refused, and `mergeRefusal` says why. */
  mergeInto: LayoutV3 | null;
  mergeRefusal: MergeRefusal | null;
  move: (event: PointerEvent) => void;
  key: (event: KeyboardEvent) => void;
  end: () => void;
  cancel: () => void;
};

const slotMiddle = (slot: TabSlot) => slot.left + slot.width / 2;

/** What a merge drop is promising, as the outline over the canvas draws it. */
type MergeAim = {
  sourceName: string;
  targetName: string;
  /** How many windows are arriving, for the refusal's wording. */
  count: number;
  /** Where they land, in canvas cells. Empty when the drop is refused. */
  incoming: Tile[];
  /** The canvas in viewport pixels; the cells above are fractions of it. */
  canvas: { left: number; top: number; width: number; height: number };
  refusal: MergeRefusal | null;
};

/** The bounding box of a set of tiles, in canvas cells. */
function tilesBounds(tiles: Tile[]): Rect {
  if (tiles.length === 0) return WHOLE_CANVAS;
  const x = Math.min(...tiles.map((tile) => tile.x));
  const y = Math.min(...tiles.map((tile) => tile.y));
  return {
    x,
    y,
    w: Math.max(...tiles.map((tile) => tile.x + tile.w)) - x,
    h: Math.max(...tiles.map((tile) => tile.y + tile.h)) - y,
  };
}

/** What the outline says the drop will do, or why it cannot. */
function mergeAimLabel(aim: MergeAim): string {
  if (aim.refusal === "capacity") {
    const windows = aim.count === 1 ? "another window" : `${aim.count} more windows`;
    return `${aim.targetName} has no room for ${windows}`;
  }
  if (aim.refusal === "fit") return `Too small here for ${aim.sourceName}`;
  return `Merge ${aim.sourceName} into ${aim.targetName}`;
}

/**
 * The workspace's tab strip: one button per tab — click to switch, click the
 * active tab again to rename it in place, drag it sideways to reorder the
 * strip (Alt+Shift+Arrow does the same from the keyboard) — an always-visible
 * x to close, and a trailing + to add. Every button carries
 * `data-workspace-tab` so the grid's pane drag can hit-test the strip —
 * hovering a tab mid-drag switches to it, dropping on one moves the pane
 * into it (see WorkspaceGrid) — and `data-workspace-tab-owner`, which says
 * whose strip it is, since in a split window a hit-test finds either.
 *
 * Tabs can be gathered into groups, as Firefox has them: a coloured label
 * before the group's first tab (click to fold the group away, right-click for
 * its panel) and a line of the same colour over its tabs. Labels carry
 * `data-workspace-tab-group`, never `data-workspace-tab`, so nothing that
 * hit-tests the strip for tabs mistakes one for a tab.
 *
 * Tab CRUD writes the whole v3 envelope through PATCH and updates both query
 * caches optimistically, mirroring the grid's own save path.
 */
export function WorkspaceTabs({
  workspace,
  activeTabId,
  previewTiles,
  focusedId,
  splitChrome,
  onPreviewTiles,
  onSwitch,
  onError,
}: {
  workspace: Workspace;
  activeTabId: string;
  /** The grid's in-flight gesture preview; overrides the committed tiles for
   *  the connection measure so the tab restyles while a drag is still on. */
  previewTiles?: Tile[] | null;
  /** The focused session — a connected tab wears the same dim as the pane
   *  beneath it when that pane is not the focused one. */
  focusedId?: string | null;
  /** Set only when this strip is one of two on screen: it grows a label saying
   *  whose tabs these are and a control that keeps this half. Absent — every
   *  ordinary window — the strip is exactly what it was before split view. */
  splitChrome?: SplitChrome | null;
  /** The layout this strip's own gesture is promising — a tab dragged onto the
   *  canvas moves the windows already there aside to make its room, and the
   *  grid is what draws that. Null puts the canvas back. */
  onPreviewTiles?: (tiles: Tile[] | null) => void;
  onSwitch: (tabId: string) => void;
  onError?: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const stripRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /*
   * Whether the selected tab has canvas content directly beneath it: a tile
   * touching the grid's top row whose column span crosses under the tab (the
   * strip and the canvas share the panel's width, so tab pixels map straight
   * to grid columns). Connected, the tab extends down flush with the panel;
   * over shell ground it rests like the others, corners intact. An empty tab
   * always connects — its whole canvas wears the panel surface.
   */
  const [look, setLook] = useState<{
    connected: boolean;
    dimmed: boolean;
    /** What's directly beneath: the empty tab's panel, or a pane header. */
    surface: "panel" | "header";
  }>({ connected: true, dimmed: false, surface: "panel" });
  const [draft, setDraft] = useState("");
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  // One context menu serves the whole strip: right-click records which tab it
  // was aimed at and opens the menu at the cursor.
  const tabMenuRef = useRef<DropdownMenuHandle>(null);
  /*
   * "Add tab to group…" needs a list, and the menu has no submenus: picking it
   * closes the tab menu and opens this one at the same point, which is where
   * the right-click left the pointer.
   */
  const groupMenuRef = useRef<DropdownMenuHandle>(null);
  const menuPointRef = useRef({ x: 0, y: 0 });
  const [editor, setEditor] = useState<GroupEditorState | null>(null);
  /** "New tab in group": the group the next tab is for, and a count that
   *  re-opens the picker when asked twice for the same group. */
  const [groupNewTab, setGroupNewTab] = useState<{ groupId: string; nonce: number } | null>(null);
  const groupNewTabMenuRef = useRef<CascadeMenuHandle>(null);
  /** A name or colour change waiting to be written; see patchM. */
  const groupWriteRef = useRef<number | null>(null);
  const tabGhostRef = useRef<HTMLDivElement>(null);
  const tabGhostLabelRef = useRef<HTMLSpanElement>(null);
  // The merge drag's two pieces of chrome: the tab carried under the pointer
  // once it leaves the strip, and the outline over the canvas it would land
  // in. Both are fixed to the viewport — the strip scrolls sideways, and a
  // tab dragged out of it would otherwise be clipped by that overflow.
  const mergeGhostRef = useRef<HTMLDivElement>(null);
  const mergeGhostLabelRef = useRef<HTMLSpanElement>(null);
  const paneScope = useOptionalPaneScope();
  /*
   * What the merge drop is currently promising. React state, unlike the rest
   * of this drag's chrome, because the outline is a whole arrangement of rects
   * that changes shape as the aim moves from one opening to another — building
   * that by hand would be worse than a render. It only changes when the aim
   * lands somewhere new, so the pointer's own rate never reaches it; the ghost
   * under the cursor, which does move every frame, stays imperative.
   */
  const [mergeAim, setMergeAim] = useState<MergeAim | null>(null);
  const onPreviewTilesRef = useRef(onPreviewTiles);
  onPreviewTilesRef.current = onPreviewTiles;
  const [contextTabId, setContextTabId] = useState<string | null>(null);
  const sessionsQ = useQuery({ queryKey: ["sessions"], queryFn: () => sessions.list() });
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  // Where to look for the workspace's mark: the folder its first window runs in.
  const iconSource = workspaceFolder(workspace, sessionsQ.data ?? []);

  const writeCaches = (next: Workspace) => {
    queryClient.setQueryData(["workspace", next.id], next);
    queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
      current?.map((item) => (item.id === next.id ? next : item)),
    );
  };

  const cancelGroupWrite = () => {
    if (groupWriteRef.current === null) return;
    window.clearTimeout(groupWriteRef.current);
    groupWriteRef.current = null;
  };

  const patchM = useMutation({
    mutationFn: (layout: LayoutV3) => workspaces.update(workspace.id, { layout }),
    onMutate: (layout) => {
      // Every write carries the whole envelope, so it carries a pending group
      // edit too; the debounced write it was waiting for has nothing left to say.
      cancelGroupWrite();
      onError?.(null);
      writeCaches({ ...workspace, layout });
    },
    onSuccess: (saved) => {
      // A name still being typed is newer than what this write took with it:
      // keep showing it rather than flick back to the saved spelling for the
      // length of the debounce.
      writeCaches(groupWriteRef.current === null ? saved : { ...saved, layout: layoutRef.current });
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onError?.(error instanceof Error ? error.message : String(error));
    },
  });

  /**
   * Every strip write goes through here. The live layout moves at once rather
   * than when the optimistic write has rendered: two Alt+Shift+Arrow presses
   * inside a frame, or a fold straight after a regroup, must each start from
   * what the one before them did.
   */
  const writeLayout = (next: LayoutV3) => {
    layoutRef.current = next;
    patchM.mutate(next);
  };

  useEffect(() => {
    if (renamingId && !workspace.layout.tabs.some((tab) => tab.id === renamingId)) {
      setRenamingId(null);
    }
  }, [renamingId, workspace.layout.tabs]);

  /*
   * Reorder by drag. The tab itself is the drag surface, so the gesture only
   * commits past a few px of travel — anything shorter stays a click, which
   * switches tabs or opens the rename. Dragging, the grabbed tab tracks the
   * pointer while the tabs it passes slide one slot the other way; the drop
   * writes the new order through the same envelope PATCH as the rest of tab
   * CRUD. Touch is left alone so the strip still scrolls.
   */
  const tabElementsRef = useRef(new Map<string, HTMLElement>());
  const armedDragRef = useRef<ArmedTabDrag | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  /** A drag just ran: swallow the click that closes the same gesture. */
  const draggedRef = useRef(false);
  /** The strip's live layout, for the drag's reads between renders. */
  const layoutRef = useRef(workspace.layout);
  /** The dropped envelope, held until the optimistic write carries it —
   *  without it the strip paints one frame of the old order and reads as a
   *  snap-back. The whole envelope rather than the order, because a drop can
   *  regroup the tab as well as move it. */
  const [dropped, setDropped] = useState<LayoutV3 | null>(null);

  useEffect(() => {
    layoutRef.current = workspace.layout;
    // Whatever the patch settled on — the dropped order or a rollback — is the
    // truth now, so the local hold has done its one frame of work.
    setDropped(null);
  }, [workspace.layout]);

  // Unmounting mid-drag — a workspace switch, say — must not leave listeners
  // or a grabbing cursor behind.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag) {
        document.removeEventListener("pointermove", drag.move);
        document.removeEventListener("pointerup", drag.end);
        document.removeEventListener("pointercancel", drag.cancel);
      }
      const armed = armedDragRef.current;
      if (armed) {
        document.removeEventListener("pointermove", armed.move);
        document.removeEventListener("pointerup", armed.end);
        document.removeEventListener("pointercancel", armed.end);
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  /** The envelope the strip paints: the dropped one while it is held. */
  const view = useMemo(() => {
    const list = workspace.layout.tabs;
    if (!dropped) return workspace.layout;
    const held = dropped.tabs
      .map((item) => list.find((tab) => tab.id === item.id))
      .filter((tab): tab is WorkspaceTab => Boolean(tab));
    return held.length === list.length
      ? { ...workspace.layout, tabs: held, groups: dropped.groups }
      : workspace.layout;
  }, [dropped, workspace.layout]);
  const orderedTabs = view.tabs;
  const groups = useMemo(() => layoutGroups(view), [view]);
  /** Folded groups keep all but the open tab out of sight. */
  const hidden = useMemo(() => hiddenTabIds(view, activeTabId), [view, activeTabId]);

  const disarmDrag = () => {
    const armed = armedDragRef.current;
    if (!armed) return;
    armedDragRef.current = null;
    document.removeEventListener("pointermove", armed.move);
    document.removeEventListener("pointerup", armed.end);
    document.removeEventListener("pointercancel", armed.end);
  };

  /** The reason a merge drop was refused, worded as the outline worded it. */
  const mergeRefusalMessage = (drag: TabDrag): string => {
    const layout = layoutRef.current;
    return mergeAimLabel({
      sourceName: tabById(layout, drag.tabId)?.name ?? "That tab",
      targetName: tabById(layout, activeTabId)?.name ?? "this tab",
      count: tabTiles(layout, drag.tabId).length,
      incoming: [],
      canvas: { left: 0, top: 0, width: 0, height: 0 },
      refusal: drag.mergeRefusal,
    });
  };

  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.removeEventListener("pointermove", drag.move);
    document.removeEventListener("pointerup", drag.end);
    document.removeEventListener("pointercancel", drag.cancel);
    document.removeEventListener("keydown", drag.key);
    document.removeEventListener("keyup", drag.key);
    for (const element of tabElementsRef.current.values()) {
      // Order: dropping the transition first means clearing the transform is
      // an instant jump, not an animation back from the drag's offset while
      // the reordered strip has already moved underneath it.
      element.style.removeProperty("transition");
      element.style.transform = "";
      element.removeAttribute("data-dragging");
      element.removeAttribute("data-duplicating");
      element.removeAttribute("data-merging");
    }
    const ghost = tabGhostRef.current;
    if (ghost) {
      ghost.hidden = true;
      ghost.style.transform = "";
    }
    if (mergeGhostRef.current) mergeGhostRef.current.hidden = true;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (drag.merging) {
      setMergeAim(null);
      onPreviewTilesRef.current?.(null);
      // Whatever the outline last promised, rather than working the aim out
      // again from the pointer: the canvas underneath has already moved to
      // show this drop, and re-reading it would land the windows somewhere
      // they were never shown.
      if (!commit) return;
      if (drag.mergeInto) mergeM.mutate(drag.mergeInto);
      // Dropped where the outline said it would not go. Saying so beats a tab
      // that snaps back with nothing said, which reads as a gesture that
      // simply did not take.
      else if (drag.mergeRefusal) onError?.(mergeRefusalMessage(drag));
      return;
    }
    const layout = layoutRef.current;
    if (commit && drag.duplicating) {
      duplicateM.mutate({
        tabId: drag.tabId,
        index: stripIndexForGap(layout, drag.visibleIds, drag.insertAt),
      });
      return;
    }
    // The slot counts tabs on screen; the hidden tabs of a folded group move
    // with it as a block, so the drop never lands inside what nobody can see.
    const next = commit
      ? reorderTab(
          layout,
          drag.tabId,
          stripIndexForSlot(layout, drag.visibleIds, drag.tabId, drag.to),
        )
      : null;
    if (!next) return;
    setDropped(next);
    writeLayout(next);
  };

  const beginDrag = (
    tabId: string,
    startClientX: number,
    clientX: number,
    duplicating: boolean,
  ) => {
    // Only what is on screen is measured: a folded group's hidden tabs have no
    // element, and the drop maps the visible slot back to the whole strip.
    const list = layoutRef.current.tabs.filter((tab) => tabElementsRef.current.has(tab.id));
    const from = list.findIndex((tab) => tab.id === tabId);
    const elements = list.map((tab) => tabElementsRef.current.get(tab.id));
    if (from === -1 || elements.length === 0 || elements.some((element) => !element)) return;
    const slots: TabSlot[] = elements.map((element, index) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return { id: list[index].id, left: rect.left, width: rect.width };
    });
    const first = slots[0];
    const last = slots[slots.length - 1];
    const grabbed = slots[from];
    const secondSlot = slots[1];
    // The strip's own gap, measured between two tabs where there are two — a
    // lone tab can still be copied, and its ghost needs the same breathing
    // room, so fall back to what the flex row is set to.
    const gap = secondSlot
      ? Math.max(0, secondSlot.left - (first.left + first.width))
      : Number.parseFloat(stripRef.current ? getComputedStyle(stripRef.current).columnGap : "") ||
        0;
    /** Every place a copy can go: the resting left edge of each tab, and the
     *  strip's end — which is where the ghost already sits in flow. */
    const gaps = [...slots.map((slot) => slot.left), last.left + last.width + gap];
    const stripBottom = stripRef.current?.getBoundingClientRect().bottom ?? 0;
    /** The merge's own measurements, taken when the pointer crosses onto the
     *  canvas: where the canvas is, and the free space it is offering. */
    let canvasBox: DOMRect | null = null;
    let openings: Rect[] = [];
    /** The aim as last resolved, so an unchanged one costs nothing. */
    let aimKey: string | null = null;
    /** The ghost's resting geometry, read the first time it is shown. */
    let ghostLeft = 0;
    let ghostStep = 0;

    /**
     * Duplicating: open the gap the copy will drop into. The copy is carried
     * at the offset the tab was grabbed by — exactly as the reorder carries
     * the tab itself — so it stays under the hand however far the drag runs,
     * and the gap it claims is whichever one its leading edge is nearest. The
     * tabs from there on slide aside by a ghost's width, and the ghost travels
     * back from the end of the strip to sit in the space. The source tab keeps
     * its own slot throughout, the same bargain the pane drag strikes, where
     * the original stays put and only the ghost moves.
     */
    const previewCopy = (pointerX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const left = grabbed.left + (pointerX - drag.startClientX);
      let insertAt = 0;
      for (const [index, edge] of gaps.entries()) {
        if (Math.abs(edge - left) < Math.abs(gaps[insertAt] - left)) insertAt = index;
      }
      if (insertAt === drag.insertAt) return;
      drag.insertAt = insertAt;
      for (const [index, slot] of slots.entries()) {
        const element = tabElementsRef.current.get(slot.id);
        if (!element) continue;
        element.style.transform = index < insertAt ? "" : `translate3d(${ghostStep}px, 0, 0)`;
      }
      const ghost = tabGhostRef.current;
      if (ghost) ghost.style.transform = `translate3d(${gaps[insertAt] - ghostLeft}px, 0, 0)`;
    };

    /**
     * Reordering: the grabbed tab rides the pointer and the tabs it passes
     * slide one slot the other way, into the space it left behind.
     */
    const previewMove = (pointerX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = Math.min(drag.maxDx, Math.max(drag.minDx, pointerX - drag.startClientX));
      // The slot the tab has taken over: its leading edge against the resting
      // middles either side, so covering half a neighbour claims it. Middle
      // against middle would want a whole tab of travel, which the clamp at
      // each end of the strip never allows — the end slots were unreachable.
      const left = grabbed.left + dx;
      const right = left + grabbed.width;
      let to = drag.from;
      while (to > 0 && left < slotMiddle(slots[to - 1])) to -= 1;
      while (to < slots.length - 1 && right > slotMiddle(slots[to + 1])) to += 1;
      drag.to = to;
      for (const [index, slot] of slots.entries()) {
        const element = tabElementsRef.current.get(slot.id);
        if (!element) continue;
        let shift = 0;
        if (index === drag.from) shift = dx;
        else if (index > drag.from && index <= to) shift = -drag.step;
        else if (index < drag.from && index >= to) shift = drag.step;
        element.style.transform = shift === 0 ? "" : `translate3d(${shift}px, 0, 0)`;
      }
    };

    const apply = (pointerX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.lastClientX = pointerX;
      if (drag.duplicating) previewCopy(pointerX);
      else previewMove(pointerX);
    };

    /**
     * The pointer has crossed out of the strip onto the canvas — or come back.
     * Merging, the strip closes over the gap and the tab is carried under the
     * pointer instead, with the canvas outlined as what it would fold into:
     * the drop moves every window of the dragged tab into the open one and
     * closes the tab it emptied.
     */
    const setMerging = (wanted: boolean, pointerX: number, pointerY: number) => {
      const drag = dragRef.current;
      if (!drag || drag.merging === wanted) return;
      drag.merging = wanted;
      const element = tabElementsRef.current.get(drag.tabId);
      const ghost = mergeGhostRef.current;
      if (!wanted) {
        drag.mergeInto = null;
        drag.mergeRefusal = null;
        aimKey = null;
        setMergeAim(null);
        onPreviewTilesRef.current?.(null);
        if (element) {
          // Reordering, the tab is back under the cursor and has to snap;
          // copying, it eases home with the rest of the strip, exactly as
          // `setDuplicating` leaves it.
          element.style.transition = drag.duplicating ? "transform 150ms ease-out" : "none";
          element.removeAttribute("data-merging");
        }
        if (ghost) ghost.hidden = true;
        // The copy's ghost was put away on the way in; a drag still holding
        // ⌘/⌥ wants it back, and `setDuplicating` will not run again for a
        // modifier that never changed.
        if (drag.duplicating && tabGhostRef.current) tabGhostRef.current.hidden = false;
        document.body.style.cursor = drag.duplicating ? "copy" : "grabbing";
        // Re-preview from where the pointer is: the strip was left at rest.
        drag.insertAt = -1;
        drag.to = drag.from;
        apply(pointerX);
        return;
      }
      // Nothing in the strip should still be parting around a tab that is
      // being carried out of it.
      for (const slot of slots) {
        const sibling = tabElementsRef.current.get(slot.id);
        if (sibling) sibling.style.transform = "";
      }
      if (tabGhostRef.current) {
        tabGhostRef.current.hidden = true;
        tabGhostRef.current.style.transform = "";
      }
      if (element) {
        element.style.transition = "transform 150ms ease-out";
        element.style.transform = "";
        element.setAttribute("data-merging", "true");
      }
      const source = tabById(layoutRef.current, drag.tabId);
      if (ghost && source) {
        if (mergeGhostLabelRef.current) mergeGhostLabelRef.current.textContent = source.name;
        ghost.hidden = false;
        ghost.style.left = `${pointerX}px`;
        ghost.style.top = `${pointerY}px`;
      }
      // Measured once per crossing: the canvas does not move while a drag is
      // running, and the openings are worked out against the resting layout
      // rather than the one being previewed — a pane that has already slid
      // aside would keep re-answering where the pointer is aimed.
      canvasBox = drag.canvas?.getBoundingClientRect() ?? null;
      openings = freeRects(tabTiles(layoutRef.current, activeTabId));
      aim(pointerX, pointerY);
    };

    /**
     * Where on the canvas the block would land, and what that costs the
     * windows already there. Free canvas takes it whole; a window under the
     * pointer gives up the half nearest the edge you are aimed at; anything
     * else falls back to auto-placing them one by one. Recomputed only when
     * the answer changes — the pointer moves far more often than the aim does.
     */
    const aim = (pointerX: number, pointerY: number) => {
      const drag = dragRef.current;
      if (!drag?.merging || !canvasBox) return;
      const layout = layoutRef.current;
      const resting = tabTiles(layout, activeTabId);
      const cellX = ((pointerX - canvasBox.left) / canvasBox.width) * GRID_SIZE;
      const cellY = ((pointerY - canvasBox.top) / canvasBox.height) * GRID_SIZE;
      const covers = (rect: Rect) =>
        cellX >= rect.x && cellX < rect.x + rect.w && cellY >= rect.y && cellY < rect.y + rect.h;

      let drop: MergeDrop;
      if (resting.length === 0) {
        // An empty tab is all one opening, and the block arrives unchanged.
        drop = { kind: "region", rect: WHOLE_CANVAS };
      } else {
        const opening = openings.find(covers) ?? null;
        const hovered = opening ? null : (resting.find(covers) ?? null);
        if (opening) drop = { kind: "region", rect: opening };
        else if (hovered) {
          drop = {
            kind: "dock",
            paneId: hovered.session_id,
            zone: dockZoneAt((cellX - hovered.x) / hovered.w, (cellY - hovered.y) / hovered.h),
          };
        } else drop = { kind: "auto" };
      }

      const key = JSON.stringify(drop);
      if (key === aimKey) return;
      aimKey = key;
      const { plan, refusal } = planMerge(layout, drag.tabId, activeTabId, drop);
      drag.mergeInto = plan?.layout ?? null;
      drag.mergeRefusal = refusal;
      document.body.style.cursor = plan ? "grabbing" : "not-allowed";
      setMergeAim({
        sourceName: tabById(layout, drag.tabId)?.name ?? "this tab",
        targetName: tabById(layout, activeTabId)?.name ?? "this tab",
        count: tabTiles(layout, drag.tabId).length,
        incoming: plan?.incoming ?? [],
        canvas: {
          left: canvasBox.left,
          top: canvasBox.top,
          width: canvasBox.width,
          height: canvasBox.height,
        },
        refusal,
      });
      // Only a dock moves anything already on the canvas; the rest leave it be,
      // and passing the plan either way keeps one path.
      onPreviewTilesRef.current?.(plan ? plan.resting : null);
    };

    /**
     * ⌘/⌥ down or up, flipping a live drag between the two previews. Either
     * way the strip parts around what the hand is carrying; what differs is
     * what ends up in the gap — the tab itself, or the ghost of its copy.
     */
    const setDuplicating = (wanted: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.duplicating === wanted) return;
      drag.duplicating = wanted;
      document.body.style.cursor = wanted ? "copy" : "grabbing";
      const element = tabElementsRef.current.get(drag.tabId);
      if (element) {
        if (wanted) element.setAttribute("data-duplicating", "true");
        else element.removeAttribute("data-duplicating");
        // Copying, the source eases back to its slot along with the rest of
        // the strip; reordering, it is under the cursor again and must snap.
        element.style.transition = wanted ? "transform 150ms ease-out" : "none";
      }
      const ghost = tabGhostRef.current;
      if (ghost && wanted) {
        drag.to = drag.from;
        const source = layoutRef.current.tabs.find((tab) => tab.id === drag.tabId);
        if (tabGhostLabelRef.current && source) {
          tabGhostLabelRef.current.textContent = copyTabName(layoutRef.current, source.name);
        }
        // Shown, and shown untravelled, before it is measured: hidden it has
        // no geometry at all, and a stale transform would skew what it has.
        ghost.style.transform = "";
        ghost.hidden = false;
        const rect = ghost.getBoundingClientRect();
        ghostLeft = rect.left;
        ghostStep = rect.width + gap;
      } else if (ghost) {
        ghost.hidden = true;
        ghost.style.transform = "";
      }
      // Re-preview in the new mode from wherever the pointer already is: the
      // modifier can be pressed and released without the pointer moving.
      drag.insertAt = -1;
      apply(drag.lastClientX);
    };

    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      drag.lastClientX = event.clientX;
      // Over this half's canvas the gesture stops being about the strip. The
      // tab already open is the merge's target, so dragging it has nothing to
      // fold into and goes on reordering.
      const depth = event.clientY - stripBottom;
      const belowStrip = depth > (drag.merging ? MERGE_EXIT_PX : MERGE_ENTER_PX);
      const under = belowStrip ? document.elementFromPoint(event.clientX, event.clientY) : null;
      setMerging(
        drag.canvas !== null &&
          drag.tabId !== activeTabId &&
          under?.closest?.("[data-workspace-canvas]") === drag.canvas,
        event.clientX,
        event.clientY,
      );
      if (drag.merging) {
        const ghost = mergeGhostRef.current;
        if (ghost) {
          ghost.style.left = `${event.clientX}px`;
          ghost.style.top = `${event.clientY}px`;
        }
        aim(event.clientX, event.clientY);
        return;
      }
      setDuplicating(wantsDuplicate(event));
      apply(event.clientX);
    };

    const drag: TabDrag = {
      tabId,
      visibleIds: list.map((tab) => tab.id),
      from,
      to: from,
      startClientX,
      lastClientX: clientX,
      minDx: first.left - grabbed.left,
      maxDx: last.left + last.width - (grabbed.left + grabbed.width),
      step: grabbed.width + gap,
      duplicating: false,
      insertAt: -1,
      // This half's canvas, not the document's first — in a split window the
      // other workspace's grid is on screen too, and a tab can only be folded
      // into a tab of its own workspace.
      canvas: queryInPane<HTMLElement>(
        paneScope?.rootRef.current ?? null,
        "[data-workspace-canvas]",
      ),
      merging: false,
      mergeInto: null,
      mergeRefusal: null,
      move,
      key: (event) => {
        // Escape abandons the drag; the strip closes back over the gap.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finishDrag(false);
          return;
        }
        setDuplicating(wantsDuplicate(event));
      },
      end: () => finishDrag(true),
      cancel: () => finishDrag(false),
    };
    dragRef.current = drag;
    draggedRef.current = true;
    for (const [index, element] of elements.entries()) {
      // The tabs being passed ease into their new slot; the grabbed one rides
      // the pointer, so it stays untransitioned.
      if (index !== from) (element as HTMLElement).style.transition = "transform 150ms ease-out";
    }
    elements[from]?.setAttribute("data-dragging", "true");
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    setDuplicating(duplicating);
    apply(clientX);
    document.addEventListener("pointermove", drag.move, { passive: false });
    document.addEventListener("keydown", drag.key);
    document.addEventListener("keyup", drag.key);
    document.addEventListener("pointerup", drag.end, { once: true });
    document.addEventListener("pointercancel", drag.cancel, { once: true });
  };

  const armDrag = (tabId: string, event: ReactPointerEvent<HTMLElement>) => {
    draggedRef.current = false;
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (renamingId) return;
    // A lone tab has nowhere to be reordered to, but it can still be copied,
    // and ⌘/⌥ is as often pressed after the drag is under way as before it —
    // so the gesture arms whatever the strip holds, and a reorder with nowhere
    // to go simply comes to nothing on the drop.
    const duplicating = wantsDuplicate(event);
    disarmDrag();
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      if (
        Math.abs(moveEvent.clientX - startClientX) < DRAG_THRESHOLD_PX &&
        Math.abs(moveEvent.clientY - startClientY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      disarmDrag();
      beginDrag(tabId, startClientX, moveEvent.clientX, duplicating || wantsDuplicate(moveEvent));
    };
    const armed: ArmedTabDrag = { move, end: disarmDrag };
    armedDragRef.current = armed;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", armed.end, { once: true });
    document.addEventListener("pointercancel", armed.end, { once: true });
  };

  /** The same reorder without a pointer. Alt+Arrow alone walks the grid's
   *  panes, so the shift keeps the two apart. A step is one tab on screen: a
   *  folded group is passed over whole, the way a drag passes it. */
  const nudge = (tabId: string, delta: number) => {
    const layout = layoutRef.current;
    const folded = hiddenTabIds(layout, activeTabId);
    const visibleIds = layout.tabs.map((tab) => tab.id).filter((id) => !folded.has(id));
    const from = visibleIds.indexOf(tabId);
    if (from === -1) return;
    const to = Math.min(Math.max(from + delta, 0), visibleIds.length - 1);
    const next = reorderTab(layout, tabId, stripIndexForSlot(layout, visibleIds, tabId, to));
    if (next) writeLayout(next);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies(renamingId): the rename input swaps a tab for an input, changing every tab's width — re-measure.
  useLayoutEffect(() => {
    const measure = () => {
      const strip = stripRef.current;
      const button = strip?.querySelector(`[data-workspace-tab="${activeTabId}"]`);
      const tiles = previewTiles ?? tabById(workspace.layout, activeTabId)?.layout.tiles ?? [];
      if (!strip || !button || tiles.length === 0) {
        setLook({ connected: true, dimmed: false, surface: "panel" });
        return;
      }
      const stripRect = strip.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const from = ((rect.left - stripRect.left) / stripRect.width) * GRID_SIZE;
      const to = ((rect.right - stripRect.left) / stripRect.width) * GRID_SIZE;
      // Fully connected or not at all: the top row must cover the tab's whole
      // span — sweep the merged y=0 intervals across it (half-cell slack for
      // pixel rounding).
      const spans = tiles
        .filter((tile) => tile.y === 0)
        .map((tile) => [tile.x, tile.x + tile.w] as const)
        .sort((a, b) => a[0] - b[0]);
      let reach = from + 0.05;
      for (const [start, end] of spans) {
        if (start > reach) break;
        reach = Math.max(reach, end);
      }
      // Matching dim: when every pane under the tab is unfocused (so washed),
      // the connected tab wears the same wash — one sheet, one shade.
      const underTab = tiles.filter(
        (tile) => tile.y === 0 && tile.x < to - 0.05 && from + 0.05 < tile.x + tile.w,
      );
      setLook({
        connected: reach >= to - 0.05,
        dimmed: tiles.length > 1 && !underTab.some((tile) => tile.session_id === focusedId),
        surface: "header",
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTabId, focusedId, previewTiles, renamingId, workspace.layout]);

  /**
   * The "+" makes the tab and the first window in it in one gesture: this runs
   * when the picker's choice is made, writes the tab and makes it active —
   * which is what tells the create that follows where its window goes — and
   * hands back the undo for a create that never lands.
   */
  const addTabForWindow = async (groupId?: string) => {
    const layout = layoutRef.current;
    const id = crypto.randomUUID();
    const added = addTab(layout, id, nextTabName(layout));
    if (!added) throw new Error(`A workspace holds at most ${MAX_TABS} tabs.`);
    // "New tab in group" puts the tab at the group's end in the same write, so
    // there is never a moment where it sits ungrouped at the end of the strip.
    const next = (groupId && addTabToGroup(added, id, groupId)) || added;
    const wasActive = activeTabId;
    writeCaches(await workspaces.update(workspace.id, { layout: next }));
    onSwitch(id);
    return () => {
      const rolled = removeTab(layoutRef.current, id);
      if (!rolled) return;
      onSwitch(wasActive);
      workspaces
        .update(workspace.id, { layout: withActiveTab(rolled, wasActive) })
        .then(writeCaches)
        .catch(() => queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] }));
    };
  };

  /**
   * Fold one tab's windows into the open one and close the tab it emptied —
   * the drop at the end of dragging a tab down onto the canvas. Pure layout:
   * the sessions are the same sessions, moved, so nothing is created or
   * killed and the drag is undone by dragging a window back out.
   */
  const mergeM = useMutation({
    mutationFn: (next: LayoutV3) => workspaces.update(workspace.id, { layout: next }),
    // Optimistic, like every other tab write: the canvas has been showing this
    // arrangement all the way through the drag, and letting it snap back to
    // the old one for the length of a round trip would undo the drop on screen.
    onMutate: (next) => {
      onError?.(null);
      writeCaches({ ...workspace, layout: next });
    },
    onSuccess: (saved) => {
      writeCaches(saved);
      onSwitch(saved.layout.active_tab ?? activeTabId);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      onError?.(error instanceof Error ? error.message : String(error));
    },
  });

  /**
   * Duplicate a tab: same geometry, a second pane per pane, each on the same
   * host and folder with the same agent relaunched in it. The sessions are
   * real and new — this copies the workspace's shape and its intent, not the
   * running processes. `index` is the slot the copy takes — where a ⌘/⌥ drag
   * was dropped; left out, as the menu leaves it, the copy goes on the end.
   */
  const duplicateM = useMutation({
    mutationFn: async ({ tabId, index }: { tabId: string; index?: number }) => {
      const layout = layoutRef.current;
      const tab = tabById(layout, tabId);
      if (!tab) throw new Error("That tab is gone.");
      if (layout.tabs.length >= MAX_TABS) {
        throw new Error(`A workspace holds at most ${MAX_TABS} tabs.`);
      }
      const sessionsById = new Map((sessionsQ.data ?? []).map((item) => [item.id, item]));
      // Awaited rather than read from the hook: a duplicate fired before the
      // registry query settles would silently copy every agent pane as a bare
      // shell. Failure falls back to the empty list it used to read.
      const definitions = await queryClient
        .ensureQueryData({ queryKey: ["agents"], queryFn: agents.list })
        .catch(() => []);
      const copiedIds = new Map<string, string>();
      const created: string[] = [];
      try {
        for (const tile of tab.layout.tiles) {
          // A widget is pure layout: its copy needs no round trip. One from a
          // newer SPAWN D is left out of the copy (see duplicateTab).
          if (tile.widget) {
            if (isFilesWidget(tile.widget)) copiedIds.set(tile.session_id, crypto.randomUUID());
            continue;
          }
          const source = sessionsById.get(tile.session_id);
          if (!source) continue; // a tile whose session is already gone
          const access = await sessionAccess.get(source.id).catch(() => null);
          const skillIds = access?.skills.map((skill) => skill.id) ?? [];
          const agent = sessionAgent(source, definitions);
          const conversation = agent ? newAgentConversationId(agent.kind) : null;
          const copy = await sessions.create({
            host_id: source.host_id,
            cwd: source.cwd,
            ...(agent && { agent_id: agent.id, agent_session_id: conversation }),
            ...(skillIds.length > 0 && { skill_ids: skillIds }),
          });
          created.push(copy.id);
          copiedIds.set(tile.session_id, copy.id);
          if (agent)
            pendingLaunch.set(copy.id, copy.host_id, agentLaunchCommand(agent, conversation));
        }
        const next = duplicateTab(
          layout,
          tabId,
          crypto.randomUUID(),
          copyTabName(layout, tab.name),
          copiedIds,
          index,
        );
        if (!next) throw new Error("This workspace has no room for another tab.");
        const saved = await workspaces.update(workspace.id, { layout: next });
        return { saved, tabId: next.active_tab as string };
      } catch (error) {
        // Never strand half a tab's worth of shells with nothing pointing at
        // them: the layout write is the only thing that makes them visible.
        await Promise.allSettled(created.map((id) => sessions.remove(id)));
        throw error;
      }
    },
    onSuccess: ({ saved, tabId }) => {
      writeCaches(saved);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onError?.(null);
      onSwitch(tabId);
    },
    onError: (error) => onError?.(error instanceof Error ? error.message : String(error)),
  });

  const close = async (tabId: string) => {
    const tab = workspace.layout.tabs.find((item) => item.id === tabId);
    const next = removeTab(workspace.layout, tabId);
    if (!tab || !next) return;
    const sessionIds = tab.layout.tiles
      .filter((tile) => !tile.widget)
      .map((tile) => tile.session_id);
    // Only sessions that still exist earn the "process killed" warning — a
    // tab holding nothing but dead panes closes without ceremony. Until the
    // session list has loaded, assume everything is live rather than skip a
    // destructive confirmation.
    const known = sessionsQ.data;
    const liveCount = known
      ? sessionIds.filter((id) => known.some((session) => session.id === id)).length
      : sessionIds.length;
    if (liveCount > 0) {
      const accepted = await confirm({
        title: `Close ${tab.name}?`,
        body: `${liveCount === 1 ? "Its session" : `Its ${liveCount} sessions`} will be closed and the running ${liveCount === 1 ? "process" : "processes"} killed.`,
        confirmLabel: "Close tab",
        destructive: true,
      });
      if (!accepted) return;
    }
    if (sessionIds.length > 0) {
      const results = await Promise.allSettled(sessionIds.map((id) => sessions.remove(id)));
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected" &&
          // A session the server has already dropped is the outcome closing
          // asked for; only a failure that leaves one running keeps the tab.
          !(result.reason instanceof ApiError && result.reason.status === 404),
      );
      if (failed) {
        onError?.(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
        return;
      }
    }
    writeLayout(next);
    if (tabId === activeTabId) onSwitch(next.active_tab as string);
  };

  const settingsM = useMutation({
    mutationFn: (body: {
      name?: string;
      cwd?: string;
      host_id?: string;
      icon?: string | null;
      icon_source?: "auto" | "custom" | "none";
    }) => workspaces.update(workspace.id, body),
    onSuccess: (saved) => {
      writeCaches(saved);
      onError?.(null);
    },
    onError: (error) => onError?.(error instanceof Error ? error.message : String(error)),
  });

  const saveTemplateM = useMutation({
    mutationFn: (name: string) =>
      workspaceTemplates.create({
        name,
        // So does the mark: every workspace made from this template opens
        // wearing it, rather than scanning its way back to the same image.
        ...(workspace.icon ? { icon: workspace.icon, icon_source: workspace.icon_source } : {}),
        spec: templateSpecFromWorkspace(
          workspace.layout,
          new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
          agentsQ.data ?? [],
        ),
      }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["workspace-templates"] });
      toast(`Saved "${saved.name}" as a template.`);
    },
    onError: (error) => onError?.(error instanceof Error ? error.message : String(error)),
  });

  const submitSaveTemplate = (event?: FormEvent) => {
    event?.preventDefault();
    const name = templateNameDraft.trim();
    setSaveTemplateOpen(false);
    if (name) saveTemplateM.mutate(name.slice(0, 128));
  };

  /**
   * Where to go once this workspace has been archived or deleted. Only the
   * half the address bar is about has anywhere to be: the other half of a
   * split is not the page you are on, and the arrangement it was in is
   * dissolved by the workspace list refresh above, which leaves the workspace
   * you were actually working in filling the window.
   */
  const leaveAfterRemoval = () => {
    if (paneScope && !paneScope.routed) return;
    router.replace("/app");
  };

  const deleteWorkspace = async () => {
    const sessionCount = allTiles(workspace.layout).filter((tile) => !tile.widget).length;
    const accepted = await confirm({
      title: `Delete ${workspace.name}?`,
      body:
        sessionCount > 0
          ? `Every session in this workspace (${sessionCount}) will be closed and its process killed.`
          : "The workspace and its tabs will be removed.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (!accepted) return;
    try {
      await workspaces.remove(workspace.id);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    leaveAfterRemoval();
  };

  const submitWorkspaceRename = (event?: FormEvent) => {
    event?.preventDefault();
    const name = workspaceNameDraft.trim();
    setRenameWorkspaceOpen(false);
    if (name && name !== workspace.name) settingsM.mutate({ name: name.slice(0, 128) });
  };

  const submitRename = (tabId: string, event?: FormEvent) => {
    event?.preventDefault();
    const name = draft.trim();
    const tab = workspace.layout.tabs.find((item) => item.id === tabId);
    setRenamingId(null);
    if (!tab || !name || name === tab.name) return;
    writeLayout(renameTab(workspace.layout, tabId, name.slice(0, 64)));
  };

  // The middle of the arriving block, where the outline's label sits.
  const mergeAimCentre = mergeAim
    ? (() => {
        const bounds = tilesBounds(mergeAim.incoming);
        return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
      })()
    : null;

  const canClose = workspace.layout.tabs.length > 1;
  const sessionsById = useMemo(
    () => new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
    [sessionsQ.data],
  );

  // ---------------------------------------------------------------------------
  // Tab groups.
  // ---------------------------------------------------------------------------

  const groupOfTabId = useMemo(
    () => new Map(groups.flatMap((group) => group.tab_ids.map((id) => [id, group] as const))),
    [groups],
  );

  /** A group's label in this strip: what the panel hangs from and where the
   *  focus goes back to when it closes. */
  const groupLabel = (groupId: string) =>
    stripRef.current?.querySelector<HTMLElement>(
      `[data-workspace-tab-group="${CSS.escape(groupId)}"]`,
    ) ?? null;

  const tabButton = (tabId: string) =>
    stripRef.current?.querySelector<HTMLElement>(`[data-workspace-tab="${CSS.escape(tabId)}"]`) ??
    null;

  /**
   * Show a name or colour change at once and write it when the typing or the
   * dragging stops. The caches carry it in the meantime, so anything else
   * written first — a reorder, a collapse — takes it along (and patchM then
   * drops the timer, having said it already).
   */
  const editGroup = (groupId: string, patch: { name?: string; color?: string }) => {
    const next = updateGroup(layoutRef.current, groupId, patch);
    if (!next) return;
    layoutRef.current = next;
    const current = queryClient.getQueryData<Workspace>(["workspace", workspace.id]) ?? workspace;
    writeCaches({ ...current, layout: next });
    cancelGroupWrite();
    groupWriteRef.current = window.setTimeout(() => {
      groupWriteRef.current = null;
      writeLayout(layoutRef.current);
    }, GROUP_WRITE_DEBOUNCE_MS);
  };

  const flushGroupWrite = () => {
    if (groupWriteRef.current === null) return;
    cancelGroupWrite();
    writeLayout(layoutRef.current);
  };

  // A name still waiting to be written when the strip goes — a workspace
  // switch mid-word — is sent rather than dropped.
  useEffect(
    () => () => {
      if (groupWriteRef.current === null) return;
      window.clearTimeout(groupWriteRef.current);
      groupWriteRef.current = null;
      workspaces.update(workspace.id, { layout: layoutRef.current }).catch(() => undefined);
    },
    [workspace.id],
  );

  // The panel hangs from its label, which a group made a moment ago does not
  // have until the optimistic write lands; and a group that goes away under
  // an open panel — its last tab closed from another device — takes it along.
  useLayoutEffect(() => {
    if (!editor) return;
    const label = groupLabel(editor.groupId);
    if (!label) {
      if (editor.anchor) setEditor(null);
      return;
    }
    if (editor.anchor) return;
    label.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = label.getBoundingClientRect();
    setEditor({
      ...editor,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    });
  });

  // "New tab in group" opens the strip's own new-tab picker, hung from the
  // label, once the panel that asked for it has gone.
  useEffect(() => {
    if (!groupNewTab) return;
    const frame = requestAnimationFrame(() => groupNewTabMenuRef.current?.open());
    return () => cancelAnimationFrame(frame);
  }, [groupNewTab]);

  const closeEditor = (restoreFocus: boolean) => {
    const groupId = editor?.groupId;
    flushGroupWrite();
    setEditor(null);
    if (restoreFocus && groupId) requestAnimationFrame(() => groupLabel(groupId)?.focus());
  };

  /** Put a tab in a group of its own and open the panel to name it. */
  const groupTab = (tabId: string) => {
    const layout = layoutRef.current;
    const id = crypto.randomUUID();
    const next = createGroup(layout, tabId, { id, name: "", color: nextGroupColor(layout) });
    if (!next) return;
    writeLayout(next);
    setEditor({ groupId: id, mode: "create", anchor: null });
  };

  const moveTabToGroup = (tabId: string, groupId: string) => {
    const next = addTabToGroup(layoutRef.current, tabId, groupId);
    if (next) writeLayout(next);
  };

  const toggleGroup = (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    const next = group && updateGroup(layoutRef.current, groupId, { collapsed: !group.collapsed });
    if (next) writeLayout(next);
  };

  const contextGroup = contextTabId ? (groupOfTabId.get(contextTabId) ?? null) : null;
  const otherGroups = groups.filter((group) => group.id !== contextGroup?.id);
  const editorGroup = editor ? groups.find((group) => group.id === editor.groupId) : undefined;

  /**
   * The label before a group's first tab: its colour, its name, and — folded —
   * how many tabs it is keeping out of sight and whether any of them wants
   * you. Click folds or unfolds it; right-click, Shift+F10 or the menu key
   * opens its panel.
   */
  const renderGroupLabel = (group: TabGroup) => {
    const { fill, ink } = groupColorStyle(group.color);
    const name = group.name || UNNAMED_GROUP;
    const folded = group.tab_ids.filter((id) => hidden.has(id));
    let attention: AttentionLevel | null = null;
    for (const id of folded) {
      const tab = tabById(view, id);
      const level = tab ? tabAttentionLevel(tab, sessionsById) : null;
      if (level === "dead") {
        attention = "dead";
        break;
      }
      if (level === "waiting") attention = "waiting";
    }
    const count = group.tab_ids.length;
    const attentionText =
      attention === "dead"
        ? "A hidden tab has a window that stopped or needs you"
        : attention === "waiting"
          ? "A hidden tab has a window waiting on you"
          : null;
    return (
      <div key={`group:${group.id}`} className="relative mb-1 shrink-0">
        <button
          type="button"
          data-workspace-tab-group={group.id}
          data-workspace-tab-group-owner={workspace.id}
          aria-label={name}
          aria-expanded={!group.collapsed}
          title={[`${name} — ${count} ${count === 1 ? "tab" : "tabs"}`, attentionText]
            .filter(Boolean)
            .join(". ")}
          onClick={() => toggleGroup(group.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setEditor({ groupId: group.id, mode: "manage", anchor: null });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            setEditor({ groupId: group.id, mode: "manage", anchor: null });
          }}
          style={{ backgroundColor: fill, color: ink }}
          className={cn(
            "flex h-6 min-w-6 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold outline-none transition-[filter]",
            "hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-shell",
          )}
        >
          {group.name && <span className="min-w-0 truncate">{group.name}</span>}
          {folded.length > 0 && (
            <span data-group-hidden-count className="shrink-0 tabular-nums opacity-85">
              +{folded.length}
            </span>
          )}
        </button>
        {/* Folded tabs still owe their news: the same tones the badge on a
            tab wears, as a dot, since there is no tab left to wear one. */}
        {attention && attentionText && (
          <span
            role="img"
            aria-label={attentionText}
            data-group-attention={attention}
            className={cn(
              "pointer-events-none absolute -right-1 -top-1 size-2.5 rounded-full ring-2 ring-shell",
              attention === "dead" ? "bg-destructive" : "bg-warning",
            )}
          />
        )}
        {groupNewTab?.groupId === group.id && (
          <NewSessionMenu
            key={groupNewTab.nonce}
            mode="session"
            workspaceId={workspace.id}
            tabId={null}
            heading="New tab in group"
            hideHeading
            menuRef={groupNewTabMenuRef}
            beforeCreate={() => addTabForWindow(group.id)}
            className="absolute bottom-0 left-0"
            menuClassName="w-72"
            trigger={<span hidden />}
          />
        )}
      </div>
    );
  };

  /**
   * Put the workspace away: its shape is kept and its sessions stop. Only
   * asks when there is something running to stop — the destructive copy
   * belongs to Delete, which keeps nothing.
   */
  const archiveWorkspace = async () => {
    const live = workspaceLiveSessionCount(workspace, sessionsById);
    if (live > 0) {
      const accepted = await confirm({
        title: `Archive ${workspace.name}?`,
        body: `${live} running ${live === 1 ? "session" : "sessions"} will be closed. The layout is kept — restore it any time from Archived in the sidebar.`,
        confirmLabel: "Archive workspace",
      });
      if (!accepted) return;
    }
    try {
      await workspaces.archive(workspace.id);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    leaveAfterRemoval();
  };

  return (
    /*
     * Shaped like real tabs: the strip is a band of the shell ground with a
     * sliver of ground beneath the resting tabs; the selected tab alone
     * extends down through it — a few px more room at its bottom — staying
     * flush with the content so tab and panel read as one connected sheet.
     * The strip starts flush with the panel's left edge — with the first tab,
     * or in a split window with the label saying whose tabs these are.
     */
    <div
      ref={stripRef}
      role="tablist"
      // Two strips are two tablists, and "Workspace tabs" twice over says
      // nothing about which workspace either one holds.
      aria-label={splitChrome ? `${splitChrome.workspaceName} tabs` : "Workspace tabs"}
      // Stamped for the grid's pane drag, the same contract as each tab
      // button below: the strip's own ground (not a tab, not a control) is
      // where a dragged pane can be dropped to get a tab of its own, and the
      // owner says whose envelope that tab would join (a split shows two
      // strips; see ownStripGroundAt in WorkspaceGrid).
      data-workspace-tab-strip
      data-workspace-tab-strip-owner={workspace.id}
      // Scrolls sideways without a scrollbar: the wheel scrolls it, and the
      // ends fade out where tabs continue past the edge.
      onWheel={(event) => {
        if (event.deltaX !== 0 || event.shiftKey) return;
        event.currentTarget.scrollLeft += event.deltaY;
      }}
      className={cn(
        "flex h-11 shrink-0 items-end gap-1 overflow-x-auto bg-shell pr-1.5 pb-1.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]",
      )}
    >
      {splitChrome && (
        <SplitWorkspaceMenu
          chrome={splitChrome}
          onRename={() => {
            setWorkspaceNameDraft(workspace.name);
            setRenameWorkspaceOpen(true);
          }}
          onChangeIcon={() => setIconOpen(true)}
          onArchive={() => void archiveWorkspace()}
          onDelete={() => void deleteWorkspace()}
        />
      )}
      {orderedTabs.flatMap((tab) => {
        const group = groupOfTabId.get(tab.id) ?? null;
        // The label goes before the group's first tab whether or not that tab
        // is on show, so a folded group keeps its place in the strip.
        const label = group?.tab_ids[0] === tab.id ? renderGroupLabel(group) : null;
        if (hidden.has(tab.id)) return label ? [label] : [];
        // A line of the group's colour over its tabs — over, not under: the
        // open tab is joined to the panel below it, and a rule there would
        // cut the two apart. It runs on across the gap to the next tab of the
        // group, so the group reads as one run.
        const lastOnShow = group
          ? group.tab_ids.filter((id) => !hidden.has(id)).at(-1) === tab.id
          : false;
        const groupLine = group ? (
          <span
            aria-hidden
            key="group-line"
            data-tab-group-line={group.id}
            style={{ backgroundColor: groupColorStyle(group.color).fill }}
            className={cn(
              "pointer-events-none absolute -top-1 left-0 h-0.5 rounded-full",
              lastOnShow ? "right-0" : "-right-1",
            )}
          />
        ) : null;
        const active = tab.id === activeTabId;
        const attention = tabAttentionCount(tab, sessionsById);
        const attentionLevel = tabAttentionLevel(tab, sessionsById);
        // The tab's shape, shared by the tab and by its rename: renaming
        // swaps the label for a field and changes nothing else, so the tab
        // keeps its place in the strip and its footing on the panel.
        const shape = cn(
          "flex h-8 min-w-24 max-w-56 items-center gap-1.5 rounded-md pl-3 text-xs font-medium transition-colors",
          // The label stays level with the resting tabs: the extra
          // height is all bottom padding, swallowed by flex centering.
          // A connected tab continues the surface directly beneath it:
          // a pane's header tint (card over background), washed exactly
          // like the pane when that pane is unfocused; the empty tab's
          // plain panel otherwise.
          active && "bg-[var(--tab-surface)] text-foreground",
          active &&
            (look.connected && look.surface === "header"
              ? look.dimmed
                ? "[--tab-surface:color-mix(in_oklab,var(--foreground)_3.5%,color-mix(in_oklab,var(--card)_75%,var(--background)))] dark:[--tab-surface:color-mix(in_oklab,black_25%,color-mix(in_oklab,var(--card)_75%,var(--background)))]"
                : "[--tab-surface:color-mix(in_oklab,var(--card)_75%,var(--background))]"
              : "[--tab-surface:var(--background)]"),
          // `tab-connected` flares the foot into the panel: see globals.
          active && look.connected && "tab-connected -mb-1.5 h-[38px] rounded-b-none pb-1.5",
          !active && "text-muted-foreground hover:bg-background/50 hover:text-foreground",
        );
        if (renamingId === tab.id) {
          return [
            label,
            <div key={tab.id} className="relative shrink-0">
              {groupLine}
              <form
                onSubmit={(event) => submitRename(tab.id, event)}
                className={cn(shape, "pr-3.5")}
              >
                <input
                  // biome-ignore lint/a11y/noAutofocus: the field replaces the label of the tab that was just clicked to rename it — landing in it is the gesture, not a surprise.
                  autoFocus
                  aria-label={`Rename ${tab.name}`}
                  value={draft}
                  // The field is the label's own text with a rule under it —
                  // no box, no ring — and it is as wide as the name it holds:
                  // `size` is its natural width, the tab's floor is its
                  // minimum, and the label's ceiling is its maximum, so a
                  // long name grows the tab exactly as the label would.
                  size={Math.max(12, draft.length + 1)}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={() => submitRename(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  className={cn(
                    "mt-0.5 h-auto min-w-0 max-w-48 flex-auto border-0 border-b bg-transparent p-0 pb-0.5 text-xs font-medium leading-5 text-inherit outline-none",
                    // A hairline of the label's own colour, faint: a rule to
                    // write on, not a box drawn around the words.
                    "border-current/15 focus:border-current/30",
                  )}
                />
              </form>
            </div>,
          ];
        }
        return [
          label,
          // The wrapper is what a reorder slides: the dragged tab rides the
          // pointer with no transition, the tabs it passes ease into its slot.
          <div
            key={tab.id}
            ref={(element) => {
              if (element) tabElementsRef.current.set(tab.id, element);
              else tabElementsRef.current.delete(tab.id);
            }}
            className="group/tab relative shrink-0 data-[dragging]:z-10 data-[merging]:opacity-35"
          >
            {groupLine}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              data-workspace-tab={tab.id}
              data-workspace-tab-owner={workspace.id}
              onPointerDown={(event) => armDrag(tab.id, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextTabId(tab.id);
                menuPointRef.current = { x: event.clientX, y: event.clientY };
                tabMenuRef.current?.openAt(event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
                const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
                if (delta === 0) return;
                event.preventDefault();
                event.stopPropagation();
                nudge(tab.id, delta);
              }}
              onClick={() => {
                // The pointerup that ends a reorder still fires a click here.
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                if (active) {
                  setDraft(tab.name);
                  setRenamingId(tab.id);
                } else {
                  onSwitch(tab.id);
                }
              }}
              className={cn(
                shape,
                canClose ? "pr-6.5" : "pr-3.5",
                // The badge is its own visual edge, so it sits closer in than
                // a bare label wants to.
                attention > 0 && "pl-2",
              )}
            >
              {/* What is waiting behind this tab, the same rollup the sidebar
                  puts on a workspace row — read before the name. */}
              <AttentionBadge count={attention} level={attentionLevel} />
              <span className="min-w-0 truncate">{tab.name}</span>
            </button>
            {canClose && (
              <button
                type="button"
                aria-label={`Close ${tab.name}`}
                onClick={() => void close(tab.id)}
                className={cn(
                  "absolute right-1.5 top-4 grid size-4.5 -translate-y-1/2 place-items-center rounded-sm transition-[color,background-color,opacity]",
                  "text-muted-foreground hover:bg-accent hover:text-foreground",
                  // Quiet until it is wanted: on the tab you are on, or under
                  // the pointer. Keyboard focus and touch always show it.
                  !active &&
                    "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100",
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </div>,
        ];
      })}
      {/* Where a ⌘/⌥ drag will drop the copy. It lives in flow past the last
          tab — the strip makes room for it while the drag is live — and rides
          a transform back to whichever gap the pointer has opened, which is
          the slot `duplicateTab` is told to insert into. The source tab never
          leaves its own slot. */}
      <div
        ref={tabGhostRef}
        hidden
        aria-hidden
        data-workspace-tab-ghost
        className="flex h-8 min-w-24 shrink-0 items-center gap-1.5 rounded-md border-2 border-dashed border-ring bg-ring/10 px-3 text-xs font-medium text-foreground transition-transform duration-150 ease-out"
      >
        <Copy className="size-3.5 shrink-0" aria-hidden />
        <span ref={tabGhostLabelRef} className="max-w-48 truncate" />
      </div>
      {/* The pane drag's promise, dressed as the tab ghost above: resting a
          dragged window on the strip's open ground lights this chip where the
          new tab would land, and the drop makes that tab and carries the
          window into it. The grid owns the hover — it stamps data-newtab-hover
          here mid-gesture (see WorkspaceGrid), the same wiring as the
          launcher's bin morph — so nothing about the drag re-renders React. */}
      <div
        aria-hidden
        data-workspace-newtab-ghost
        className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md border-2 border-dashed border-ring bg-ring/10 px-3 text-xs font-medium text-foreground data-[newtab-hover]:flex"
      >
        <Plus className="size-3.5 shrink-0" aria-hidden />
        New tab
      </div>
      {/* A tab is only ever wanted for what goes in it, so the "+" asks what
          that is first and makes the tab and the window together. The tab is
          empty until a choice is made, so nothing is left behind by closing
          the picker. */}
      <NewSessionMenu
        mode="session"
        workspaceId={workspace.id}
        // The tab does not exist yet: what it inherits is the workspace's
        // home, which is where these choices will open.
        tabId={null}
        // The "+" is already labelled New tab, so the menu does not repeat it
        // — only the sheet, which opens with the button out of sight, does.
        heading="New tab"
        hideHeading
        // A new tab opens at the workspace's folder and "Change tab folder"
        // re-points it, so the "somewhere else" row says nothing new here.
        beforeCreate={addTabForWindow}
        className="mb-0.5 shrink-0"
        // Roomier than the default: agent rows carry a command underneath the
        // name, and at w-60 the longer ones truncate mid-flag.
        menuClassName="w-72"
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="New tab"
            disabled={workspace.layout.tabs.length >= MAX_TABS || patchM.isPending}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        }
      />

      {/* Right-click on any tab. Rendered once for the whole strip and opened
          at the cursor, so it is not eight menus deep in the DOM. */}
      <DropdownMenu ref={tabMenuRef} align="start" className="hidden" renderTrigger={() => null}>
        <DropdownMenuItem
          disabled={
            contextTabId === null ||
            workspace.layout.tabs.length >= MAX_TABS ||
            duplicateM.isPending
          }
          onSelect={() => {
            if (contextTabId) duplicateM.mutate({ tabId: contextTabId });
          }}
        >
          <Copy className="size-4" aria-hidden />
          Duplicate tab
          <span className="ml-auto shrink-0 pl-3 text-xs tracking-wide text-muted-foreground">
            ⌘/⌥ drag
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={contextTabId === null}
          onSelect={() => {
            const tab = contextTabId ? tabById(workspace.layout, contextTabId) : null;
            if (!tab) return;
            if (tab.id !== activeTabId) onSwitch(tab.id);
            setDraft(tab.name);
            setRenamingId(tab.id);
          }}
        >
          <Pencil className="size-4" aria-hidden />
          Rename tab
        </DropdownMenuItem>
        {/* Firefox's wording: "Add" while the tab is loose, "Move" once it
            already belongs somewhere and the choice takes it out of there. */}
        <DropdownMenuItem
          disabled={contextTabId === null}
          onSelect={() => {
            if (contextTabId) groupTab(contextTabId);
          }}
        >
          <Group className="size-4" aria-hidden />
          {contextGroup ? "Move tab to new group" : "Add tab to new group"}
        </DropdownMenuItem>
        {otherGroups.length > 0 && (
          <DropdownMenuItem
            disabled={contextTabId === null}
            onSelect={() => {
              // Opened once this menu has finished closing, at the point the
              // right-click left — the list is this item's submenu.
              const { x, y } = menuPointRef.current;
              requestAnimationFrame(() => groupMenuRef.current?.openAt(x, y));
            }}
          >
            <FolderInput className="size-4" aria-hidden />
            {contextGroup ? "Move tab to group…" : "Add tab to group…"}
          </DropdownMenuItem>
        )}
        {contextGroup && (
          <DropdownMenuItem
            onSelect={() => {
              const next = contextTabId
                ? removeTabFromGroup(layoutRef.current, contextTabId)
                : null;
              if (next) writeLayout(next);
            }}
          >
            <CircleMinus className="size-4" aria-hidden />
            Remove from group
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          disabled={contextTabId === null || workspace.layout.tabs.length <= 1}
          onSelect={() => {
            if (contextTabId) void close(contextTabId);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
          Close tab
        </DropdownMenuItem>
      </DropdownMenu>

      {/* "Add tab to group…": every group the tab is not already in, each
          with its colour, and a fresh one first. */}
      <DropdownMenu
        ref={groupMenuRef}
        align="start"
        className="hidden"
        menuClassName="max-w-72"
        renderTrigger={() => null}
      >
        <DropdownMenuItem
          disabled={contextTabId === null}
          onSelect={() => {
            if (contextTabId) groupTab(contextTabId);
          }}
        >
          <Plus className="size-4" aria-hidden />
          New group
        </DropdownMenuItem>
        {otherGroups.length > 0 && <DropdownMenuSeparator />}
        {otherGroups.map((group) => (
          <DropdownMenuItem
            key={group.id}
            disabled={contextTabId === null}
            onSelect={() => {
              if (contextTabId) moveTabToGroup(contextTabId, group.id);
            }}
          >
            <span
              aria-hidden
              style={{ backgroundColor: groupColorStyle(group.color).fill }}
              className="mx-0.5 size-3 shrink-0 rounded-full"
            />
            <span className="min-w-0 truncate">{group.name || UNNAMED_GROUP}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenu>

      {editor?.anchor && editorGroup && (
        <TabGroupEditor
          // One panel per group: another group opens on its own name.
          key={editorGroup.id}
          mode={editor.mode}
          group={editorGroup}
          anchor={editor.anchor}
          canAddTab={workspace.layout.tabs.length < MAX_TABS && !patchM.isPending}
          onEdit={(patch) => editGroup(editorGroup.id, patch)}
          onDone={closeEditor}
          onCancel={() => {
            // Creating, Cancel takes the group back off again; its tab stays
            // where it is, and keeps the focus the panel had.
            const first = editorGroup.tab_ids[0];
            cancelGroupWrite();
            setEditor(null);
            const next = ungroup(layoutRef.current, editorGroup.id);
            if (next) writeLayout(next);
            if (first) requestAnimationFrame(() => tabButton(first)?.focus());
          }}
          onToggleCollapsed={() => {
            closeEditor(true);
            toggleGroup(editorGroup.id);
          }}
          onUngroup={() => {
            const first = editorGroup.tab_ids[0];
            closeEditor(false);
            const next = ungroup(layoutRef.current, editorGroup.id);
            if (next) writeLayout(next);
            if (first) requestAnimationFrame(() => tabButton(first)?.focus());
          }}
          onNewTab={() => {
            closeEditor(false);
            setGroupNewTab((current) => ({
              groupId: editorGroup.id,
              nonce: (current?.nonce ?? 0) + 1,
            }));
          }}
        />
      )}

      {/* Core workspace settings live at the strip's far right; adding panes
          is the floating launcher's job (bottom-right of the viewport). */}
      <DropdownMenu
        align="end"
        className={cn(
          "mb-0.5 ml-auto shrink-0",
          // Pinned beside the unsplit control at a half-width strip's end.
          // Left scrolling, it would come to rest exactly underneath that
          // button at full scroll and be unreachable; 2.125rem is that
          // button's width plus the strip's gap, so pinned and resting
          // positions coincide and nothing shifts as the tabs scroll past.
          splitChrome && "sticky right-8.5 z-20 bg-shell",
        )}
        renderTrigger={(props) => (
          <Button
            {...props}
            ref={settingsButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={props.onClick}
            aria-label={`${workspace.name} settings`}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            <Ellipsis className="size-4" aria-hidden />
          </Button>
        )}
      >
        <DropdownMenuItem
          onSelect={() => {
            setWorkspaceNameDraft(workspace.name);
            setRenameWorkspaceOpen(true);
          }}
        >
          <Pencil className="size-4" aria-hidden />
          Rename workspace
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setIconOpen(true)}>
          <ImagePlus className="size-4" aria-hidden />
          Change workspace icon…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setTemplateNameDraft(workspace.name);
            setSaveTemplateOpen(true);
          }}
        >
          <LayoutTemplate className="size-4" aria-hidden />
          Save workspace as template
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void archiveWorkspace()}>
          <Archive className="size-4" aria-hidden />
          Archive workspace
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => void deleteWorkspace()}>
          <Trash2 className="size-4" aria-hidden />
          Delete workspace
        </DropdownMenuItem>
      </DropdownMenu>

      {splitChrome && (
        <UnsplitButton
          workspaceName={splitChrome.workspaceName}
          side={splitChrome.side}
          onUnsplit={splitChrome.onUnsplit}
        />
      )}

      <WorkspaceIconDialog
        open={iconOpen}
        onOpenChange={setIconOpen}
        name={workspace.name}
        icon={workspace.icon}
        hostId={iconSource?.host_id ?? null}
        cwd={iconSource?.cwd ?? null}
        busy={settingsM.isPending}
        onSelect={(icon) => settingsM.mutate({ icon, icon_source: "custom" })}
      />

      <Dialog open={renameWorkspaceOpen} onOpenChange={setRenameWorkspaceOpen}>
        <DialogContent size="sm">
          <form onSubmit={submitWorkspaceRename}>
            <DialogHeader>
              <DialogTitle>Rename workspace</DialogTitle>
            </DialogHeader>
            <div className="px-6 py-2">
              <Input
                autoFocus
                aria-label="Workspace name"
                value={workspaceNameDraft}
                onChange={(event) => setWorkspaceNameDraft(event.currentTarget.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRenameWorkspaceOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!workspaceNameDraft.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
        <DialogContent size="sm">
          <form onSubmit={submitSaveTemplate}>
            <DialogHeader>
              <DialogTitle>Save as template</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 px-6 py-2">
              <Input
                autoFocus
                aria-label="Template name"
                value={templateNameDraft}
                onChange={(event) => setTemplateNameDraft(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">
                Saves this workspace's tabs, window arrangement, and what runs in each window. New
                workspaces created from it pick their own folder.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setSaveTemplateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!templateNameDraft.trim()}>
                Save template
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* What a tab dragged onto the canvas is promising: one outline per
          arriving window, laid out exactly where the drop would put them, and
          the tab itself carried under the pointer. Both sit outside the strip's
          flow — it scrolls sideways, so anything moved out of it would be
          clipped — and both are inert to hit-testing, which the drag does
          against the canvas every move. */}
      {mergeAim && (
        <div
          aria-hidden
          style={{
            left: `${mergeAim.canvas.left}px`,
            top: `${mergeAim.canvas.top}px`,
            width: `${mergeAim.canvas.width}px`,
            height: `${mergeAim.canvas.height}px`,
          }}
          className="pointer-events-none fixed z-[105]"
        >
          {mergeAim.incoming.length > 0 ? (
            mergeAim.incoming.map((tile) => (
              <div
                key={tile.session_id}
                data-merge-window={tile.session_id}
                style={{
                  left: `${(tile.x / GRID_SIZE) * 100}%`,
                  top: `${(tile.y / GRID_SIZE) * 100}%`,
                  width: `${(tile.w / GRID_SIZE) * 100}%`,
                  height: `${(tile.h / GRID_SIZE) * 100}%`,
                }}
                // The padding is the seam between neighbouring outlines, so a
                // pair that share an edge read as two windows, not one.
                className="absolute p-px"
              >
                <div className="size-full rounded-md border-2 border-dashed border-ring bg-ring/10" />
              </div>
            ))
          ) : (
            // Refused: nothing lands, so the whole canvas says so at once.
            <div className="absolute inset-px rounded-md border-2 border-dashed border-destructive bg-destructive/10" />
          )}
          {/* Over the middle of what is arriving, so the words sit on the
              thing they describe rather than on the canvas at large. */}
          <span
            style={{
              left: `${((mergeAimCentre?.x ?? 0) / GRID_SIZE) * 100}%`,
              top: `${((mergeAimCentre?.y ?? 0) / GRID_SIZE) * 100}%`,
            }}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3 py-1.5",
              "text-xs font-medium shadow-lg",
              mergeAim.refusal
                ? "border-destructive/40 bg-popover text-destructive"
                : "border-border bg-popover text-foreground",
            )}
          >
            {mergeAimLabel(mergeAim)}
          </span>
        </div>
      )}
      <div
        ref={mergeGhostRef}
        hidden
        aria-hidden
        className="pointer-events-none fixed z-[110] flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-lg"
      >
        <Merge className="size-3.5 shrink-0" aria-hidden />
        <span ref={mergeGhostLabelRef} className="max-w-48 truncate" />
      </div>
    </div>
  );
}
