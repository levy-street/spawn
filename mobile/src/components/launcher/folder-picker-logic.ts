export interface HostDirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}

export interface HostDirList {
  path: string;
  home_dir: string;
  parent?: string | null;
  entries: HostDirEntry[];
  next_cursor?: number | null;
  truncated?: boolean;
}

export const FOLDER_PAGE_BUDGET = 12;

export function trimTrailingSlash(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

export function normalizeAbsolutePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function parentDir(path: string): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path));
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function pathBasename(path: string): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path));
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinDirectory(parent: string, child: string): string {
  return normalizeAbsolutePath(`${trimTrailingSlash(parent)}/${child}`);
}

export function visibleDirectories<T extends { name: string; is_dir: boolean }>(
  entries: readonly T[] | undefined,
  { filter = "", showHidden = false }: { filter?: string; showHidden?: boolean } = {},
): T[] {
  const needle = filter.trim().toLocaleLowerCase();
  return (entries ?? [])
    .filter((entry) => entry.is_dir)
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export function homeRoot(homeDir: string): string {
  return trimTrailingSlash(normalizeAbsolutePath(homeDir || "/")) || "/";
}

export function isWithinHome(path: string, homeDir: string): boolean {
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  return home === "/" || target === home || target.startsWith(`${home}/`);
}

export function normalizeCwdForHost(path: string, homeDir: string): string {
  const normalized = path === "~" ? homeRoot(homeDir) : normalizeAbsolutePath(path);
  return isWithinHome(normalized, homeDir) ? normalized : homeRoot(homeDir);
}

export function parentWithinHome(path: string, homeDir: string): string | null {
  if (!isWithinHome(path, homeDir)) return null;
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  return target === home ? null : parentDir(target);
}

export interface BreadcrumbPart {
  label: string;
  path: string;
}

export function breadcrumbParts(path: string, homeDir: string): BreadcrumbPart[] {
  const home = homeRoot(homeDir);
  const breadcrumbs: BreadcrumbPart[] = [{ label: home === "/" ? "/" : "Home", path: home }];
  if (!isWithinHome(path, home)) return breadcrumbs;
  const relative = trimTrailingSlash(normalizeAbsolutePath(path || "/")).slice(
    home === "/" ? 0 : home.length,
  );
  let current = home === "/" ? "" : home;
  for (const part of relative.split("/").filter(Boolean)) {
    current += `/${part}`;
    breadcrumbs.push({ label: part, path: current });
  }
  return breadcrumbs;
}

export async function listAllEntries(
  fetchPage: (cursor: number) => Promise<HostDirList>,
  budget = FOLDER_PAGE_BUDGET,
): Promise<{ entries: HostDirEntry[]; truncated: boolean }> {
  const entries: HostDirEntry[] = [];
  let cursor = 0;
  for (let page = 0; page < budget; page += 1) {
    const result = await fetchPage(cursor);
    entries.push(...result.entries);
    if (result.truncated === true) return { entries, truncated: true };
    if (typeof result.next_cursor !== "number") return { entries, truncated: false };
    cursor = result.next_cursor;
  }
  return { entries, truncated: true };
}

export function folderErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "outside_root" || code === "traversal_rejected") {
    return "That folder sits above your home folder, which is as far up as Spawn can browse.";
  }
  if (code === "permission_denied") return "You do not have permission to open this folder.";
  if (code === "not_found") return "This folder no longer exists.";
  if (code === "not_directory") return "That is a file, not a folder.";
  if (code === "symlink_rejected") {
    return "This is a symbolic link, which Spawn does not follow.";
  }
  return error instanceof Error && error.message ? error.message : "Could not list this folder.";
}
