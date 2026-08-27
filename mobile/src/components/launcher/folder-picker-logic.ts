import {
  type PathFlavor,
  pathFlavorForHostOS,
  basename as sharedBasename,
  breadcrumbParts as sharedBreadcrumbParts,
  homeRoot as sharedHomeRoot,
  isWithinHome as sharedIsWithinHome,
  joinDirectory as sharedJoinDirectory,
  normalizeAbsolutePath as sharedNormalizeAbsolutePath,
  normalizeCwdForHost as sharedNormalizeCwdForHost,
  parentDir as sharedParentDir,
  parentWithinHome as sharedParentWithinHome,
  pathEquals as sharedPathEquals,
  trimTrailingSlash as sharedTrimTrailingSlash,
} from "@/components/files/paths";

export type { PathFlavor };
export { pathFlavorForHostOS };

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

export function trimTrailingSlash(path: string, flavor: PathFlavor = "posix"): string {
  return sharedTrimTrailingSlash(path, flavor);
}

export function normalizeAbsolutePath(path: string, flavor: PathFlavor = "posix"): string {
  return sharedNormalizeAbsolutePath(path, flavor);
}

export function parentDir(path: string, flavor: PathFlavor = "posix"): string {
  return sharedParentDir(path, flavor);
}

export function pathBasename(path: string, flavor: PathFlavor = "posix"): string {
  return sharedBasename(path, flavor);
}

export function joinDirectory(parent: string, child: string, flavor: PathFlavor = "posix"): string {
  return sharedJoinDirectory(parent, child, flavor);
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

export function homeRoot(homeDir: string, flavor: PathFlavor = "posix"): string {
  return sharedHomeRoot(homeDir || (flavor === "posix" ? "/" : ""), flavor);
}

export function isWithinHome(path: string, homeDir: string, flavor: PathFlavor = "posix"): boolean {
  return sharedIsWithinHome(path, homeDir, flavor);
}

export function normalizeCwdForHost(
  path: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): string {
  return sharedNormalizeCwdForHost(path, homeDir, flavor);
}

export function parentWithinHome(
  path: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): string | null {
  return sharedParentWithinHome(path, homeDir, flavor);
}

export function pathEquals(left: string, right: string, flavor: PathFlavor = "posix"): boolean {
  return sharedPathEquals(left, right, flavor);
}

export interface BreadcrumbPart {
  label: string;
  path: string;
}

export function breadcrumbParts(
  path: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): BreadcrumbPart[] {
  return sharedBreadcrumbParts(path, homeDir, flavor);
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
    return "That folder sits above your home folder, which is as far up as SPAWN D can browse.";
  }
  if (code === "permission_denied") return "You do not have permission to open this folder.";
  if (code === "not_found") return "This folder no longer exists.";
  if (code === "not_directory") return "That is a file, not a folder.";
  if (code === "symlink_rejected") {
    return "This is a symbolic link, which SPAWN D does not follow.";
  }
  return error instanceof Error && error.message ? error.message : "Could not list this folder.";
}
