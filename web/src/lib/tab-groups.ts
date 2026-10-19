import type { LayoutV3, TabGroup, WorkspaceTab } from "@/lib/tabs";

/**
 * Tab groups: named, coloured runs of adjacent tabs in a workspace's strip,
 * as Firefox has them. Contract: proto/README.md, "Tab groups";
 * proto/tab-groups-fixtures.json is the conformance suite, and
 * `spawn_server/tab_groups.py` and the phone's `data/layout/tab-groups.ts`
 * answer every case in it the same way this file does.
 *
 * Everything here is pure: inputs are never mutated. A group's `tab_ids` are
 * listed in strip order and always sit next to each other in the strip; a tab
 * belongs to at most one group.
 */

/** Firefox's nine, in Firefox's order — which is also the order a fresh group
 *  takes the next unused one. */
export const PRESET_COLORS = [
  "blue",
  "purple",
  "cyan",
  "orange",
  "yellow",
  "pink",
  "green",
  "gray",
  "red",
] as const;
export type PresetColor = (typeof PRESET_COLORS)[number];

export const DEFAULT_COLOR: PresetColor = "blue";
export const MAX_GROUP_ID_LENGTH = 64;
export const MAX_GROUP_NAME_LENGTH = 64;

/** What a group with an empty name is called wherever it has to be named. */
export const UNNAMED_GROUP = "Unnamed group";

export type GroupError =
  | "duplicate_group_id"
  | "bad_color"
  | "empty_group"
  | "unknown_tab"
  | "tab_in_two_groups"
  | "split_group";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

export function isPresetColor(value: unknown): value is PresetColor {
  return typeof value === "string" && (PRESET_COLORS as readonly string[]).includes(value);
}

/**
 * The stored form of a group colour: a preset name, or a custom colour as
 * lowercase `#rrggbb`. Null when `value` is neither — presets are
 * case-sensitive, and the short `#rgb` form is something a person may type,
 * not something that is stored (`parseHex` in `lib/color` widens it first).
 */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (isPresetColor(value)) return value;
  if (HEX_COLOR.test(value)) return value.toLowerCase();
  return null;
}

/** Length in code points, which is what the server's 64-character limits
 *  count — a name full of emoji is not twice as long as it looks. */
function codePoints(value: string): string[] {
  return Array.from(value);
}

/** Sorted positions split into runs of consecutive integers. */
function runs(positions: number[]): number[][] {
  const result: number[][] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    const last = result.at(-1);
    if (last && last[last.length - 1] === position - 1) last.push(position);
    else result.push([position]);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The lenient read: what a stored or carried-over `groups` value becomes
 * against the strip `tabIds`.
 *
 * Malformed groups are skipped and malformed fields read as their defaults;
 * a tab that is gone leaves its group, a tab claimed twice stays with the
 * first group listed, a split group keeps its longest run (the first, on a
 * tie), an empty group is dropped, and groups come back in strip order. What
 * comes out always passes `validateGroups`, which is why every write is run
 * through it on the way to the server.
 */
export function normalizeGroups(tabIds: readonly string[], groups: unknown): TabGroup[] {
  if (!Array.isArray(groups)) return [];
  const position = new Map(tabIds.map((id, index) => [id, index]));
  const seenIds = new Set<string>();
  const claimed = new Set<string>();
  const result: TabGroup[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const id = group.id;
    if (typeof id !== "string" || !id || codePoints(id).length > MAX_GROUP_ID_LENGTH) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const rawTabs = Array.isArray(group.tab_ids) ? group.tab_ids : [];
    const members = new Set<number>();
    for (const tabId of rawTabs) {
      if (typeof tabId !== "string" || claimed.has(tabId)) continue;
      const at = position.get(tabId);
      if (at !== undefined) members.add(at);
    }
    for (const at of members) claimed.add(tabIds[at] as string);
    const found = runs([...members]);
    if (found.length === 0) continue;
    // The first of equal runs wins, as Python's max() keeps it.
    let longest = found[0] as number[];
    for (const run of found) if (run.length > longest.length) longest = run;
    const name = group.name;
    result.push({
      id,
      name:
        typeof name === "string" ? codePoints(name).slice(0, MAX_GROUP_NAME_LENGTH).join("") : "",
      color: normalizeColor(group.color) ?? DEFAULT_COLOR,
      collapsed: typeof group.collapsed === "boolean" ? group.collapsed : false,
      tab_ids: longest.map((at) => tabIds[at] as string),
    });
  }
  const first = (group: TabGroup) => position.get(group.tab_ids[0] as string) ?? 0;
  return result.sort((a, b) => first(a) - first(b));
}

/**
 * The strict write check, as the server runs it on what a client sent: null
 * when valid, else the first problem's code. Shapes (types, lengths) are the
 * schema's job; this checks what only the strip can answer.
 */
export function validateGroups(
  tabIds: readonly string[],
  groups: readonly TabGroup[],
): GroupError | null {
  const position = new Map(tabIds.map((id, index) => [id, index]));
  const seenIds = new Set<string>();
  const claimed = new Set<string>();
  for (const group of groups) {
    if (seenIds.has(group.id)) return "duplicate_group_id";
    seenIds.add(group.id);
    if (normalizeColor(group.color) === null) return "bad_color";
    if (group.tab_ids.length === 0) return "empty_group";
    for (const tabId of group.tab_ids) {
      if (!position.has(tabId)) return "unknown_tab";
      if (claimed.has(tabId)) return "tab_in_two_groups";
      claimed.add(tabId);
    }
    if (runs(group.tab_ids.map((tabId) => position.get(tabId) as number)).length > 1) {
      return "split_group";
    }
  }
  return null;
}

/**
 * Group membership after `moved` lands at its slot in `tabIds`.
 *
 * A tab between two tabs of one group joins that group; a grouped tab still
 * touching its group stays; a group's only tab carries the group with it; any
 * other grouped tab leaves. `groups` are valid for the strip before the move.
 * Called on every reorder and insert.
 */
export function regroup(
  tabIds: readonly string[],
  groups: readonly TabGroup[],
  moved: string,
): TabGroup[] {
  const index = tabIds.indexOf(moved);
  if (index === -1) return normalizeGroups(tabIds, groups);
  const groupOf = new Map<string, string>();
  for (const group of groups) for (const tabId of group.tab_ids) groupOf.set(tabId, group.id);
  const left = index > 0 ? groupOf.get(tabIds[index - 1] as string) : undefined;
  const right = index + 1 < tabIds.length ? groupOf.get(tabIds[index + 1] as string) : undefined;
  const own = groupOf.get(moved);
  let target = own;
  if (left !== undefined && left === right) target = left;
  else if (own !== undefined && own !== left && own !== right) {
    const alone = [...groupOf.values()].filter((id) => id === own).length === 1;
    target = alone ? own : undefined;
  }
  return normalizeGroups(
    tabIds,
    groups.map((group) => ({
      ...group,
      tab_ids: [
        ...group.tab_ids.filter((tabId) => tabId !== moved),
        ...(group.id === target ? [moved] : []),
      ],
    })),
  );
}

// ---------------------------------------------------------------------------
// Envelope operations. Each answers a new LayoutV3, or null where the caller
// must know nothing changed ("nothing to persist"), the same bargain the tab
// operations in `lib/tabs` strike.
// ---------------------------------------------------------------------------

/** The envelope's groups, read leniently against its own strip. */
export function layoutGroups(layout: LayoutV3): TabGroup[] {
  return normalizeGroups(
    layout.tabs.map((tab) => tab.id),
    layout.groups ?? [],
  );
}

export function groupById(layout: LayoutV3, groupId: string): TabGroup | null {
  return layoutGroups(layout).find((group) => group.id === groupId) ?? null;
}

/** The group holding `tabId`, or null. */
export function groupOfTab(layout: LayoutV3, tabId: string): TabGroup | null {
  return layoutGroups(layout).find((group) => group.tab_ids.includes(tabId)) ?? null;
}

/** The colour a new group takes: the first preset nobody in this workspace is
 *  wearing yet, then round again once all nine are taken. */
export function nextGroupColor(layout: LayoutV3): PresetColor {
  const groups = layoutGroups(layout);
  const used = new Set(groups.map((group) => group.color));
  return (
    PRESET_COLORS.find((color) => !used.has(color)) ??
    (PRESET_COLORS[groups.length % PRESET_COLORS.length] as PresetColor)
  );
}

/** `tabs` with `tabId` taken out and put back at `index` of what remains. */
function moveTo(tabs: readonly WorkspaceTab[], tabId: string, index: number): WorkspaceTab[] {
  const moving = tabs.find((tab) => tab.id === tabId);
  if (!moving) return [...tabs];
  const rest = tabs.filter((tab) => tab.id !== tabId);
  rest.splice(Math.min(Math.max(index, 0), rest.length), 0, moving);
  return rest;
}

/**
 * Where a tab leaving `group` goes so the group stays in one piece: nowhere,
 * when it sits at either end, else just past the group's last tab — as
 * Firefox does it. Returns the strip after that move.
 */
function stepOutOf(tabs: readonly WorkspaceTab[], group: TabGroup, tabId: string): WorkspaceTab[] {
  const at = group.tab_ids.indexOf(tabId);
  if (at <= 0 || at === group.tab_ids.length - 1) return [...tabs];
  const last = group.tab_ids[group.tab_ids.length - 1] as string;
  const rest = tabs.filter((tab) => tab.id !== tabId);
  return moveTo(tabs, tabId, rest.findIndex((tab) => tab.id === last) + 1);
}

/** The envelope with `tabs` as its strip and `groups` read against it. */
function withGroups(layout: LayoutV3, tabs: WorkspaceTab[], groups: readonly TabGroup[]) {
  return {
    ...layout,
    tabs,
    groups: normalizeGroups(
      tabs.map((tab) => tab.id),
      groups,
    ),
  };
}

/**
 * Put `tabId` in a new group of its own. A tab already grouped leaves that
 * group first, stepping out past its end if it sat in the middle, so the new
 * group never splits the old one. Null when the tab is unknown or the id is
 * taken.
 */
export function createGroup(
  layout: LayoutV3,
  tabId: string,
  init: { id: string; name?: string; color?: string },
): LayoutV3 | null {
  if (!layout.tabs.some((tab) => tab.id === tabId)) return null;
  const groups = layoutGroups(layout);
  if (groups.some((group) => group.id === init.id)) return null;
  const old = groups.find((group) => group.tab_ids.includes(tabId));
  const tabs = old ? stepOutOf(layout.tabs, old, tabId) : [...layout.tabs];
  return withGroups(layout, tabs, [
    ...groups.map((group) =>
      group === old ? { ...group, tab_ids: group.tab_ids.filter((id) => id !== tabId) } : group,
    ),
    {
      id: init.id,
      name: codePoints(init.name ?? "")
        .slice(0, MAX_GROUP_NAME_LENGTH)
        .join(""),
      color: normalizeColor(init.color) ?? DEFAULT_COLOR,
      collapsed: false,
      tab_ids: [tabId],
    },
  ]);
}

/**
 * Move `tabId` into `groupId`, at the group's end — where Firefox puts a tab
 * added to a group, however far away it started. Null when either is unknown
 * or the tab is already there.
 */
export function addTabToGroup(layout: LayoutV3, tabId: string, groupId: string): LayoutV3 | null {
  if (!layout.tabs.some((tab) => tab.id === tabId)) return null;
  const groups = layoutGroups(layout);
  const target = groups.find((group) => group.id === groupId);
  if (!target || target.tab_ids.includes(tabId)) return null;
  const last = target.tab_ids[target.tab_ids.length - 1] as string;
  const rest = layout.tabs.filter((tab) => tab.id !== tabId);
  const tabs = moveTo(layout.tabs, tabId, rest.findIndex((tab) => tab.id === last) + 1);
  return withGroups(
    layout,
    tabs,
    groups.map((group) => ({
      ...group,
      tab_ids:
        group.id === groupId
          ? [...group.tab_ids, tabId]
          : group.tab_ids.filter((id) => id !== tabId),
    })),
  );
}

/** Take `tabId` out of its group, stepping it past the group's end if it sat
 *  in the middle. Null when it is in none. */
export function removeTabFromGroup(layout: LayoutV3, tabId: string): LayoutV3 | null {
  const groups = layoutGroups(layout);
  const own = groups.find((group) => group.tab_ids.includes(tabId));
  if (!own) return null;
  return withGroups(
    layout,
    stepOutOf(layout.tabs, own, tabId),
    groups.map((group) =>
      group === own ? { ...group, tab_ids: group.tab_ids.filter((id) => id !== tabId) } : group,
    ),
  );
}

/** Dissolve a group; its tabs stay exactly where they are. Null when unknown. */
export function ungroup(layout: LayoutV3, groupId: string): LayoutV3 | null {
  const groups = layoutGroups(layout);
  if (!groups.some((group) => group.id === groupId)) return null;
  return withGroups(
    layout,
    [...layout.tabs],
    groups.filter((group) => group.id !== groupId),
  );
}

/**
 * Rename, recolour, fold or unfold a group. The name is cut to its limit and a
 * colour that is not a stored form is ignored rather than written — the
 * server refuses the whole envelope over one. Null when the group is unknown.
 */
export function updateGroup(
  layout: LayoutV3,
  groupId: string,
  patch: { name?: string; color?: string; collapsed?: boolean },
): LayoutV3 | null {
  const groups = layoutGroups(layout);
  if (!groups.some((group) => group.id === groupId)) return null;
  const color = patch.color === undefined ? null : normalizeColor(patch.color);
  return withGroups(
    layout,
    [...layout.tabs],
    groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            ...(patch.name !== undefined && {
              name: codePoints(patch.name).slice(0, MAX_GROUP_NAME_LENGTH).join(""),
            }),
            ...(color !== null && { color }),
            ...(patch.collapsed !== undefined && { collapsed: patch.collapsed }),
          }
        : group,
    ),
  );
}

/**
 * The tabs a collapsed group keeps out of sight: every member but the open
 * tab, which a folded group still shows.
 */
export function hiddenTabIds(layout: LayoutV3, activeTabId: string | null): Set<string> {
  const hidden = new Set<string>();
  for (const group of layoutGroups(layout)) {
    if (!group.collapsed) continue;
    for (const tabId of group.tab_ids) if (tabId !== activeTabId) hidden.add(tabId);
  }
  return hidden;
}

/**
 * Where a tab dragged among the *visible* tabs lands in the whole strip.
 *
 * A collapsed group hides most of its tabs, so a drag measures only what is on
 * screen and its slot `to` counts visible tabs. Each visible tab carries the
 * hidden tabs of its own group that sit beside it — they are one block on
 * screen — so landing after a tab means landing after its block, and before
 * one means before its block. Hidden tabs therefore never get separated from
 * their group, and a drop beside a collapsed group lands at its edge rather
 * than inside the part nobody can see.
 *
 * Answers an index into the strip with `moved` taken out, which is what
 * `reorderTab` takes.
 */
export function stripIndexForSlot(
  layout: LayoutV3,
  visibleIds: readonly string[],
  moved: string,
  to: number,
): number {
  const ids = layout.tabs.map((tab) => tab.id);
  const from = visibleIds.indexOf(moved);
  const rest = ids.filter((id) => id !== moved);
  if (from === -1 || to === from) return ids.indexOf(moved);
  const restVisible = visibleIds.filter((id) => id !== moved);
  const visible = new Set(visibleIds);
  const groupOf = new Map<string, string>();
  for (const group of layoutGroups(layout)) {
    for (const tabId of group.tab_ids) groupOf.set(tabId, group.id);
  }
  /** Does the hidden tab at `index` of `rest` travel with `anchor`? */
  const carried = (index: number, anchor: string) => {
    const id = rest[index];
    return (
      id !== undefined &&
      !visible.has(id) &&
      groupOf.get(id) !== undefined &&
      groupOf.get(id) === groupOf.get(anchor)
    );
  };
  if (to > from) {
    const anchor = restVisible[Math.min(to, restVisible.length) - 1];
    if (anchor === undefined) return rest.length;
    let end = rest.indexOf(anchor);
    while (carried(end + 1, anchor)) end += 1;
    return end + 1;
  }
  const anchor = restVisible[Math.max(to, 0)];
  if (anchor === undefined) return 0;
  let start = rest.indexOf(anchor);
  while (carried(start - 1, anchor)) start -= 1;
  return start;
}

/**
 * The same mapping for a copy dropped into gap `insertAt` of the visible
 * strip (`visibleIds.length` is its end): before the block of the visible tab
 * that gap sits in front of. Counted in the strip as it stands, which is what
 * `duplicateTab` takes.
 */
export function stripIndexForGap(
  layout: LayoutV3,
  visibleIds: readonly string[],
  insertAt: number,
): number {
  const ids = layout.tabs.map((tab) => tab.id);
  const anchor = visibleIds[insertAt];
  if (anchor === undefined) return ids.length;
  const visible = new Set(visibleIds);
  const group = groupOfTab(layout, anchor);
  let start = ids.indexOf(anchor);
  while (start > 0) {
    const before = ids[start - 1] as string;
    if (visible.has(before) || !group?.tab_ids.includes(before)) break;
    start -= 1;
  }
  return start;
}
