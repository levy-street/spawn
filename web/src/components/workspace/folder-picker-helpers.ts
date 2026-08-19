import { normalizeAbsolutePath, trimTrailingSlash } from "@/lib/paths";

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

export function breadcrumbParts(path: string): Array<{ label: string; path: string }> {
  const parts = normalizeAbsolutePath(path).split("/").filter(Boolean);
  const breadcrumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    breadcrumbs.push({ label: part, path: current });
  }
  return breadcrumbs;
}
