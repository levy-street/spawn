import { MAX_TABS } from "@/data/layout/tabs";
import { validateGridLayout } from "@/data/layout/tiles";
import type {
  GridLayoutV3,
  Tile,
  TileWidget,
  WorkspaceLayoutV3,
  WorkspaceTab,
} from "@/data/types/layout";

export interface WorkspaceLayoutError {
  path: string;
  message: string;
}

export interface WorkspaceLayoutValidation {
  ok: boolean;
  errors: WorkspaceLayoutError[];
}

export class LayoutV3ParseError extends Error {
  readonly errors: WorkspaceLayoutError[];

  constructor(errors: WorkspaceLayoutError[]) {
    super("Invalid LayoutV3 envelope");
    this.name = "LayoutV3ParseError";
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateLayoutV3(value: unknown): WorkspaceLayoutValidation {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "$", message: "layout must be an object" }] };
  }

  const errors: WorkspaceLayoutError[] = [];
  if (value["version"] !== 3) errors.push({ path: "version", message: "version must be 3" });
  const activeTab = value["active_tab"];
  if (activeTab !== null && typeof activeTab !== "string") {
    errors.push({ path: "active_tab", message: "active_tab must be a string or null" });
  }
  const tabs = value["tabs"];
  if (!Array.isArray(tabs)) {
    errors.push({ path: "tabs", message: "tabs must be an array" });
    return { ok: false, errors };
  }
  if (tabs.length < 1 || tabs.length > MAX_TABS) {
    errors.push({ path: "tabs", message: `tabs must contain between 1 and ${MAX_TABS} items` });
  }

  const tabIds = new Map<string, number>();
  for (const [index, candidate] of tabs.entries()) {
    const path = `tabs[${index}]`;
    if (!isRecord(candidate)) {
      errors.push({ path, message: "tab must be an object" });
      continue;
    }
    const id = candidate["id"];
    if (typeof id !== "string" || id.length < 1 || id.length > 64) {
      errors.push({ path: `${path}.id`, message: "tab id must contain 1 to 64 characters" });
    } else {
      const first = tabIds.get(id);
      if (first === undefined) tabIds.set(id, index);
      else errors.push({ path: `${path}.id`, message: `tab id duplicates tabs[${first}].id` });
    }
    const name = candidate["name"];
    if (typeof name !== "string" || name.length < 1 || name.length > 64) {
      errors.push({ path: `${path}.name`, message: "tab name must contain 1 to 64 characters" });
    }
    const hostId = candidate["host_id"] ?? null;
    const cwd = candidate["cwd"] ?? null;
    if (hostId !== null && typeof hostId !== "string") {
      errors.push({ path: `${path}.host_id`, message: "host_id must be a string or null" });
    }
    if (cwd !== null && (typeof cwd !== "string" || cwd.length > 1024)) {
      errors.push({
        path: `${path}.cwd`,
        message: "cwd must be a string of at most 1024 characters or null",
      });
    }
    if ((hostId === null) !== (cwd === null)) {
      errors.push({ path, message: "tab host_id and cwd must both be set or both be null" });
    }

    const grid = validateGridLayout(candidate["layout"]);
    for (const error of grid.errors) {
      const suffix = error.index === undefined ? "" : `.tiles[${error.index}]`;
      errors.push({ path: `${path}.layout${suffix}`, message: error.code });
    }
  }

  if (typeof activeTab === "string" && !tabIds.has(activeTab)) {
    errors.push({ path: "active_tab", message: "active_tab must identify a tab in this envelope" });
  }
  return { ok: errors.length === 0, errors };
}

function cloneWidget(widget: TileWidget | undefined): TileWidget | undefined {
  return widget ? { ...widget } : undefined;
}

function cloneTile(tile: Tile): Tile {
  const widget = cloneWidget(tile.widget);
  return widget ? { ...tile, widget } : { ...tile };
}

function normalizeGrid(grid: GridLayoutV3): GridLayoutV3 {
  return { ...grid, version: 3, tiles: grid.tiles.map(cloneTile) };
}

function normalizeTab(tab: WorkspaceTab): WorkspaceTab {
  return {
    ...tab,
    host_id: tab.host_id ?? null,
    cwd: tab.cwd ?? null,
    layout: normalizeGrid(tab.layout),
  };
}

export function parseLayoutV3(input: string | unknown): WorkspaceLayoutV3 {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new LayoutV3ParseError([{ path: "$", message: "layout is not valid JSON" }]);
    }
  }
  const validation = validateLayoutV3(value);
  if (!validation.ok) throw new LayoutV3ParseError(validation.errors);
  const layout = value as WorkspaceLayoutV3;
  return { ...layout, version: 3, tabs: layout.tabs.map(normalizeTab) };
}

export function serializeLayoutV3(layout: WorkspaceLayoutV3): string {
  const validation = validateLayoutV3(layout);
  if (!validation.ok) throw new LayoutV3ParseError(validation.errors);
  return JSON.stringify(layout);
}

export function cloneLayoutV3(layout: WorkspaceLayoutV3): WorkspaceLayoutV3 {
  return parseLayoutV3(serializeLayoutV3(layout));
}
