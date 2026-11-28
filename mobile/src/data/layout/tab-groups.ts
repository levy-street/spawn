/**
 * Tab groups: named, coloured runs of adjacent tabs in a workspace's strip.
 *
 * `proto/README.md` ("Tab groups") is the contract and
 * `tests/fixtures/tab-groups-fixtures.json` the conformance suite; the server's
 * `tab_groups.py` and the web's `lib/tab-groups.ts` implement the same rules and
 * run the same cases. Everything here is pure: inputs are never mutated.
 */
import type { TabGroup, TabId, WorkspaceLayoutV3 } from "@/data/types/layout";

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
export const DEFAULT_GROUP_COLOR: PresetColor = "blue";
export const MAX_GROUP_ID_LENGTH = 64;
export const MAX_GROUP_NAME_LENGTH = 64;
export const UNNAMED_GROUP = "Unnamed group";

export type TabGroupError =
  | "duplicate_group_id"
  | "bad_color"
  | "empty_group"
  | "unknown_tab"
  | "tab_in_two_groups"
  | "split_group";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isPresetColor(value: unknown): value is PresetColor {
  return typeof value === "string" && (PRESET_COLORS as readonly string[]).includes(value);
}

/**
 * The stored form of a group colour: a preset name, or a custom colour as
 * lowercase `#rrggbb`. Null when `value` is neither.
 */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (isPresetColor(value)) return value;
  if (HEX_COLOR.test(value)) return value.toLowerCase();
  return null;
}

/**
 * The colour a group is drawn in: a preset as the theme sets it, a custom hex
 * as stored. `palette` is the theme's `tabGroup`.
 */
export function resolveGroupColor(
  color: string,
  palette: { readonly [Preset in PresetColor]: string },
): string {
  if (isPresetColor(color)) return palette[color];
  return normalizeColor(color) ?? palette[DEFAULT_GROUP_COLOR];
}

/** What a person reads for a group: its name, or "Unnamed group". */
export function groupLabel(group: Pick<TabGroup, "name">): string {
  return group.name.length > 0 ? group.name : UNNAMED_GROUP;
}

/** Cut by code points, as the server counts them, so a surrogate pair is never split. */
function clampName(name: string): string {
  const points = Array.from(name);
  return points.length > MAX_GROUP_NAME_LENGTH
    ? points.slice(0, MAX_GROUP_NAME_LENGTH).join("")
    : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted positions split into runs of consecutive integers. */
function runs(positions: readonly number[]): number[][] {
  const result: number[][] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    const last = result.at(-1);
    if (last && last.at(-1) === position - 1) last.push(position);
    else result.push([position]);
  }
  return result;
}

/**
 * The lenient read: what a stored or carried-over `groups` value becomes
 * against the strip `tabIds`.
 *
 * Malformed groups are skipped and malformed fields read as their defaults; a
 * tab that is gone leaves its group, a tab claimed twice stays with the first
 * group listed, a split group keeps its longest run (the first, on a tie), an
 * empty group is dropped, and groups come back in strip order.
 */
export function normalizeGroups(tabIds: readonly TabId[], groups: unknown): TabGroup[] {
  if (!Array.isArray(groups)) return [];
  const position = new Map(tabIds.map((tabId, index) => [tabId, index]));
  const seenIds = new Set<string>();
  const claimed = new Set<TabId>();
  const result: TabGroup[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const id = group["id"];
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_GROUP_ID_LENGTH) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const rawTabs = group["tab_ids"];
    const members = new Set<number>();
    for (const tabId of Array.isArray(rawTabs) ? rawTabs : []) {
      if (typeof tabId !== "string" || claimed.has(tabId)) continue;
      const index = position.get(tabId);
      if (index !== undefined) members.add(index);
    }
    for (const index of members) claimed.add(tabIds[index] as TabId);
    // The first of equal runs wins, as Python's max() keeps it.
    let longest: number[] = [];
    for (const run of runs([...members])) if (run.length > longest.length) longest = run;
    if (longest.length === 0) continue;
    const name = group["name"];
    const collapsed = group["collapsed"];
    result.push({
      id,
      name: typeof name === "string" ? clampName(name) : "",
      color: normalizeColor(group["color"]) ?? DEFAULT_GROUP_COLOR,
      collapsed: typeof collapsed === "boolean" ? collapsed : false,
      tab_ids: longest.map((index) => tabIds[index] as TabId),
    });
  }
  const first = (group: TabGroup) => position.get(group.tab_ids[0] as TabId) ?? 0;
  return result.sort((a, b) => first(a) - first(b));
}

/**
 * The strict write check for groups about to be sent: null when valid, else
 * the first problem's code. Shapes are the schema's job; this checks what only
 * the strip can answer.
 */
export function validateGroups(
  tabIds: readonly TabId[],
  groups: readonly TabGroup[],
): TabGroupError | null {
  const position = new Map(tabIds.map((tabId, index) => [tabId, index]));
  const seenIds = new Set<string>();
  const claimed = new Set<TabId>();
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
  tabIds: readonly TabId[],
  groups: readonly TabGroup[],
  moved: TabId,
): TabGroup[] {
  const groupOf = new Map<TabId, string>();
  for (const group of groups) for (const tabId of group.tab_ids) groupOf.set(tabId, group.id);
  const index = tabIds.indexOf(moved);
  const left = index > 0 ? groupOf.get(tabIds[index - 1] as TabId) : undefined;
  const right = index + 1 < tabIds.length ? groupOf.get(tabIds[index + 1] as TabId) : undefined;
  const own = groupOf.get(moved);
  let target = own;
  if (left !== undefined && left === right) {
    target = left;
  } else if (own !== undefined && own !== left && own !== right) {
    const alone = [...groupOf.values()].filter((groupId) => groupId === own).length === 1;
    target = alone ? own : undefined;
  }
  const regrouped = groups.map((group) => ({
    ...group,
    tab_ids: [
      ...group.tab_ids.filter((tabId) => tabId !== moved),
      ...(group.id === target ? [moved] : []),
    ],
  }));
  return normalizeGroups(tabIds, regrouped);
}

/** The first preset no group wears yet; once all nine are taken, round again. */
export function nextGroupColor(groups: readonly Pick<TabGroup, "color">[]): PresetColor {
  const used = new Set(groups.map((group) => group.color));
  return (
    PRESET_COLORS.find((color) => !used.has(color)) ??
    (PRESET_COLORS[groups.length % PRESET_COLORS.length] as PresetColor)
  );
}

// ---------------------------------------------------------------------------
// Layout operations. Each returns a layout whose `groups` are canonical for
// its strip, or the layout unchanged when there is nothing to do.

function tabIdsOf(layout: WorkspaceLayoutV3): TabId[] {
  return layout.tabs.map((tab) => tab.id);
}

/** The layout's groups, read leniently against its own strip. */
export function layoutGroups(layout: WorkspaceLayoutV3): TabGroup[] {
  return normalizeGroups(tabIdsOf(layout), layout.groups ?? []);
}

export function groupOfTab(layout: WorkspaceLayoutV3, tabId: TabId): TabGroup | null {
  return layoutGroups(layout).find((group) => group.tab_ids.includes(tabId)) ?? null;
}

/** Moves `tabId` so it sits immediately after `afterId` (which is never itself). */
function placeAfter(layout: WorkspaceLayoutV3, tabId: TabId, afterId: TabId): WorkspaceLayoutV3 {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tabId === afterId) return layout;
  const tabs = layout.tabs.filter((candidate) => candidate.id !== tabId);
  const anchor = tabs.findIndex((candidate) => candidate.id === afterId);
  if (anchor < 0) return layout;
  tabs.splice(anchor + 1, 0, tab);
  return { ...layout, tabs };
}

/**
 * Takes `tabId` out of whatever group holds it. A tab at either end of its
 * group simply leaves; one from the middle first moves just past the group's
 * end, so what is left of the group stays one run.
 */
function detach(layout: WorkspaceLayoutV3, tabId: TabId): WorkspaceLayoutV3 {
  const groups = layoutGroups(layout);
  const group = groups.find((candidate) => candidate.tab_ids.includes(tabId));
  if (!group) return { ...layout, groups };
  const at = group.tab_ids.indexOf(tabId);
  const last = group.tab_ids.at(-1) as TabId;
  const placed = at > 0 && at < group.tab_ids.length - 1 ? placeAfter(layout, tabId, last) : layout;
  return {
    ...placed,
    groups: normalizeGroups(
      tabIdsOf(placed),
      groups.map((candidate) =>
        candidate.id === group.id
          ? { ...candidate, tab_ids: candidate.tab_ids.filter((id) => id !== tabId) }
          : candidate,
      ),
    ),
  };
}

export interface NewTabGroup {
  id: string;
  name: string;
  color: string;
}

/**
 * Puts `tabId` in a group of its own. It leaves the group it was in first —
 * from the middle of one, it moves just past that group's end. Null when the
 * tab is not in the strip, the id is taken or unusable, or the colour is not one.
 */
export function createGroup(
  layout: WorkspaceLayoutV3,
  tabId: TabId,
  group: NewTabGroup,
): WorkspaceLayoutV3 | null {
  const color = normalizeColor(group.color);
  if (
    !layout.tabs.some((tab) => tab.id === tabId) ||
    group.id.length === 0 ||
    group.id.length > MAX_GROUP_ID_LENGTH ||
    color === null ||
    layoutGroups(layout).some((candidate) => candidate.id === group.id)
  ) {
    return null;
  }
  const detached = detach(layout, tabId);
  return {
    ...detached,
    groups: normalizeGroups(tabIdsOf(detached), [
      ...(detached.groups ?? []),
      { id: group.id, name: clampName(group.name), color, collapsed: false, tab_ids: [tabId] },
    ]),
  };
}

/** Moves `tabId` to just after the group's last tab and into the group. */
export function addTabToGroup(
  layout: WorkspaceLayoutV3,
  tabId: TabId,
  groupId: string,
): WorkspaceLayoutV3 {
  const groups = layoutGroups(layout);
  const target = groups.find((group) => group.id === groupId);
  if (!target || !layout.tabs.some((tab) => tab.id === tabId)) return layout;
  if (target.tab_ids.includes(tabId)) return layout;
  const last = target.tab_ids.at(-1) as TabId;
  const placed = placeAfter(layout, tabId, last);
  return {
    ...placed,
    groups: normalizeGroups(
      tabIdsOf(placed),
      groups.map((group) => {
        const rest = group.tab_ids.filter((id) => id !== tabId);
        return group.id === groupId
          ? { ...group, tab_ids: [...rest, tabId] }
          : { ...group, tab_ids: rest };
      }),
    ),
  };
}

/** Takes `tabId` out of its group; from the middle, it moves just past the group's end. */
export function removeTabFromGroup(layout: WorkspaceLayoutV3, tabId: TabId): WorkspaceLayoutV3 {
  if (!groupOfTab(layout, tabId)) return layout;
  return detach(layout, tabId);
}

/** Dissolves a group; its tabs stay where they are. */
export function ungroup(layout: WorkspaceLayoutV3, groupId: string): WorkspaceLayoutV3 {
  const groups = layoutGroups(layout);
  if (!groups.some((group) => group.id === groupId)) return layout;
  return { ...layout, groups: groups.filter((group) => group.id !== groupId) };
}

export type TabGroupPatch = Partial<Pick<TabGroup, "name" | "color" | "collapsed">>;

/**
 * Renames, recolours or collapses a group. A colour that is not a preset or a
 * hex is ignored rather than stored, and a name is cut to 64 characters.
 */
export function updateGroup(
  layout: WorkspaceLayoutV3,
  groupId: string,
  patch: TabGroupPatch,
): WorkspaceLayoutV3 {
  const groups = layoutGroups(layout);
  const current = groups.find((group) => group.id === groupId);
  if (!current) return layout;
  const color = patch.color === undefined ? null : normalizeColor(patch.color);
  const next: TabGroup = {
    ...current,
    ...(patch.name === undefined ? {} : { name: clampName(patch.name) }),
    ...(color === null ? {} : { color }),
    ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }),
  };
  if (
    next.name === current.name &&
    next.color === current.color &&
    next.collapsed === current.collapsed
  ) {
    return layout;
  }
  return { ...layout, groups: groups.map((group) => (group.id === groupId ? next : group)) };
}
