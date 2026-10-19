import { normalizeGroups } from "@/data/layout/tab-groups";
import type { TabGroup, WorkspaceTab } from "@/data/types/layout";
import { sizing } from "@/theme/sizing";

/**
 * What the tab strip draws, left to right, once groups are laid in: a label
 * before each group's first tab, and every tab a collapsed group is not
 * hiding. A collapsed group hides all its tabs but the selected one.
 *
 * Every item has a fixed width, so where each one sits is arithmetic rather
 * than a layout measurement — which is what lets the drag run on the UI thread
 * against a plain array of positions. A drag moves between *visible slots*;
 * `slotDestination` turns the slot it ends in back into an index in the whole
 * strip.
 */

const TAB_WIDTH = sizing.tab.minWidth;
const TAB_GAP = sizing.tab.itemGap;

export interface StripTabItem {
  kind: "tab";
  key: string;
  tab: WorkspaceTab;
  /** Index in the whole strip — what selection and the layout speak. */
  index: number;
  /** Index among the visible tabs — what the drag speaks. */
  slot: number;
  /** Left edge inside the strip's row of tabs. */
  left: number;
  group: TabGroup | null;
  /** The next thing drawn is a tab of the same group, so the group's rule bridges the gap. */
  joinsNext: boolean;
}

export interface StripLabelItem {
  kind: "label";
  key: string;
  group: TabGroup;
  left: number;
  width: number;
  /** The group's tabs a collapse is hiding right now. */
  hidden: WorkspaceTab[];
}

export type StripItem = StripTabItem | StripLabelItem;

export interface TabStripModel {
  items: StripItem[];
  /** Visible slot → index in the whole strip. */
  slots: number[];
  /** Visible slot → left edge. */
  slotLefts: number[];
  /** Index in the whole strip → left edge, or -1 for a hidden tab. */
  tabLefts: number[];
}

export function groupLabelWidth(group: Pick<TabGroup, "name">): number {
  return group.name.length > 0 ? sizing.tab.groupLabelWidth : sizing.tab.groupLabelCompactWidth;
}

export function tabStripModel(
  tabs: readonly WorkspaceTab[],
  groups: readonly TabGroup[],
  activeIndex: number,
): TabStripModel {
  const canonical = normalizeGroups(
    tabs.map((tab) => tab.id),
    groups,
  );
  const groupOf = new Map<string, TabGroup>();
  for (const group of canonical) for (const tabId of group.tab_ids) groupOf.set(tabId, group);

  const items: StripItem[] = [];
  const slots: number[] = [];
  const slotLefts: number[] = [];
  const tabLefts = tabs.map(() => -1);
  let x = 0;

  tabs.forEach((tab, index) => {
    const group = groupOf.get(tab.id) ?? null;
    if (group && group.tab_ids[0] === tab.id) {
      const width = groupLabelWidth(group);
      items.push({
        kind: "label",
        key: `group-${group.id}`,
        group,
        left: x,
        width,
        hidden: group.collapsed
          ? tabs.filter(
              (candidate, candidateIndex) =>
                group.tab_ids.includes(candidate.id) && candidateIndex !== activeIndex,
            )
          : [],
      });
      x += width + TAB_GAP;
    }
    if (group?.collapsed && index !== activeIndex) return;
    items.push({
      kind: "tab",
      key: tab.id,
      tab,
      index,
      slot: slots.length,
      left: x,
      group,
      joinsNext: false,
    });
    tabLefts[index] = x;
    slots.push(index);
    slotLefts.push(x);
    x += TAB_WIDTH + TAB_GAP;
  });

  for (const [position, item] of items.entries()) {
    const next = items[position + 1];
    if (item.kind === "tab" && item.group && next?.kind === "tab") {
      item.joinsNext = next.group?.id === item.group.id;
    }
  }
  return { items, slots, slotLefts, tabLefts };
}

/**
 * Where in the whole strip a tab dragged from visible slot `fromSlot` to
 * `toSlot` lands, as the index `reorderTab` takes.
 *
 * It lands beside the tab it was last carried past. When that tab stands for a
 * collapsed group, the group's hidden tabs move as one block with it: the drop
 * goes before the group's first tab or after its last, never between tabs no
 * one can see. Which group the tab then belongs to is `regroup`'s call.
 */
export function slotDestination(
  tabs: readonly WorkspaceTab[],
  groups: readonly TabGroup[],
  slots: readonly number[],
  fromSlot: number,
  toSlot: number,
): number {
  const fromIndex = slots[fromSlot];
  const anchorIndex = slots[toSlot];
  if (fromIndex === undefined || anchorIndex === undefined) return fromIndex ?? 0;
  if (fromSlot === toSlot) return fromIndex;
  const movedId = tabs[fromIndex]?.id;
  const anchorId = tabs[anchorIndex]?.id;
  if (movedId === undefined || anchorId === undefined) return fromIndex;
  const rest = tabs.map((tab) => tab.id).filter((tabId) => tabId !== movedId);
  const anchorGroup = normalizeGroups(
    tabs.map((tab) => tab.id),
    groups,
  ).find((group) => group.collapsed && group.tab_ids.includes(anchorId));
  const block = anchorGroup ? anchorGroup.tab_ids.filter((tabId) => tabId !== movedId) : [anchorId];
  return toSlot > fromSlot
    ? rest.indexOf(block.at(-1) as string) + 1
    : rest.indexOf(block[0] as string);
}

/**
 * The whole-strip destination for moving a tab one place left or right — the
 * accessible stand-in for a drag, and the tab menu's Move left and Move right.
 *
 * A place is a tab, or a whole collapsed group: a step goes past a collapsed
 * group as one block, never into its hidden run, and the tab a collapsed group
 * shows steps out past the group's start or end. Which group the tab then
 * belongs to is `regroup`'s call, as it is for a drop.
 */
export function stepDestination(
  tabs: readonly WorkspaceTab[],
  groups: readonly TabGroup[],
  tabId: string,
  offset: -1 | 1,
): number {
  const ids = tabs.map((tab) => tab.id);
  const index = ids.indexOf(tabId);
  if (index < 0) return index;
  const collapsedOf = new Map<string, string>();
  for (const group of normalizeGroups(ids, groups)) {
    if (group.collapsed) for (const id of group.tab_ids) collapsedOf.set(id, group.id);
  }
  // With the tab lifted out, it sat just before `rest[index]`.
  const rest = ids.filter((id) => id !== tabId);
  const sameBlock = (a: number, b: number) => {
    const group = collapsedOf.get(rest[a] as string);
    return group !== undefined && group === collapsedOf.get(rest[b] as string);
  };
  if (offset < 0) {
    if (index === 0) return 0;
    let first = index - 1;
    while (first > 0 && sameBlock(first - 1, first)) first -= 1;
    return first;
  }
  if (index >= rest.length) return index;
  let last = index;
  while (last < rest.length - 1 && sameBlock(last, last + 1)) last += 1;
  return last + 1;
}
