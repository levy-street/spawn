import { normalizeAbsolutePath, parentDir, trimTrailingSlash } from "@/lib/paths";

export function joinDirectory(parent: string, child: string): string {
  return normalizeAbsolutePath(`${trimTrailingSlash(parent)}/${child}`);
}

/**
 * The directories a picker list shows: subdirectories only, dot-folders
 * hidden unless asked for, narrowed by the filter box, sorted by name.
 */
export function visibleDirectories<T extends { name: string; is_dir: boolean }>(
  entries: readonly T[] | undefined,
  { filter = "", showHidden = false }: { filter?: string; showHidden?: boolean } = {},
): T[] {
  const needle = filter.trim().toLocaleLowerCase();
  return (entries ?? [])
    .filter((entry) => entry.is_dir)
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The host only ever serves paths under the account's home directory — the
 * daemon's file service is rooted there and answers anything above it with
 * `outside_root`. Every navigation affordance in the picker is therefore
 * measured against home, not `/`, so the UI can never offer a step the host
 * would refuse.
 */
export function homeRoot(homeDir: string): string {
  return trimTrailingSlash(normalizeAbsolutePath(homeDir || "/")) || "/";
}

/** True when `path` is the home root itself or sits beneath it. */
export function isWithinHome(path: string, homeDir: string): boolean {
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (home === "/") return true;
  return target === home || target.startsWith(`${home}/`);
}

/**
 * The folder to step up into, or `null` when there is nowhere left to go:
 * home is the ceiling, so the ".." row disappears there rather than walking
 * the user into an error.
 */
export function parentWithinHome(path: string, homeDir: string): string | null {
  if (!isWithinHome(path, homeDir)) return null;
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (target === home) return null;
  return parentDir(target);
}

/**
 * Crumbs from the home root down to `path`. Ancestors of home are omitted
 * entirely — they are not browsable, and a crumb that only ever errors is
 * worse than no crumb.
 */
export function breadcrumbParts(
  path: string,
  homeDir: string,
): Array<{ label: string; path: string }> {
  const home = homeRoot(homeDir);
  const breadcrumbs = [{ label: home === "/" ? "/" : "Home", path: home }];
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
