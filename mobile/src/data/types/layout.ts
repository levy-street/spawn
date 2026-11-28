export type WorkspaceId = string;
export type SessionId = string;
export type HostId = string;
export type AgentId = string;
export type TemplateId = string;
export type TabId = string;
export type PaneId = string;
export type ISODateString = string;

export interface FilesWidget {
  kind: "files";
  host_id: HostId;
  path: string;
  [key: string]: unknown;
}

/** Future widget payloads are retained even when this client cannot render them. */
export interface UnknownWidget {
  kind: string;
  [key: string]: unknown;
}

export type TileWidget = FilesWidget | UnknownWidget;

export interface Tile {
  session_id: PaneId;
  x: number;
  y: number;
  w: number;
  h: number;
  widget?: TileWidget;
  [key: string]: unknown;
}

export interface TilePlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridLayoutV3 {
  version: 3;
  tiles: Tile[];
  [key: string]: unknown;
}

export interface WorkspaceTab {
  id: TabId;
  name: string;
  host_id: HostId | null;
  cwd: string | null;
  layout: GridLayoutV3;
  [key: string]: unknown;
}

/**
 * A named, coloured run of adjacent tabs (`data/layout/tab-groups.ts`). Its
 * `tab_ids` are listed in strip order and always sit next to each other; a tab
 * belongs to at most one group. `color` is a preset name or a lowercase
 * `#rrggbb`, and an empty `name` reads as "Unnamed group".
 */
export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  tab_ids: TabId[];
}

export interface WorkspaceLayoutV3 {
  version: 3;
  active_tab: TabId | null;
  tabs: WorkspaceTab[];
  /** Listed in strip order. Absent reads as none; the wire always carries it. */
  groups?: TabGroup[];
  [key: string]: unknown;
}

export type LayoutErrorCode =
  | "shape"
  | "version"
  | "count"
  | "session_id"
  | "integer"
  | "bounds"
  | "size"
  | "duplicate"
  | "overlap";

export interface LayoutError {
  code: LayoutErrorCode;
  index?: number;
  other_index?: number;
}

export interface LayoutValidation {
  ok: boolean;
  errors: LayoutError[];
}

export type LegacySplitNode =
  | { type: "pane"; agent_id: string }
  | {
      type: "split";
      direction: "row" | "column";
      ratio: number;
      a: LegacySplitNode;
      b: LegacySplitNode;
    };

export function isFilesWidget(widget: TileWidget | null | undefined): widget is FilesWidget {
  return (
    widget?.kind === "files" &&
    typeof widget.host_id === "string" &&
    typeof widget.path === "string"
  );
}
