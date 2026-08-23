import type { HostDirEntry } from "@/components/files/types";

export function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
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

export function basename(path: string): string {
  const normalized = trimTrailingSlash(path);
  return normalized === "/" ? "/" : (normalized.split("/").at(-1) ?? normalized);
}

export function parentDir(path: string): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path));
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function joinDirectory(path: string, name: string): string {
  return normalizeAbsolutePath(`${trimTrailingSlash(path)}/${name}`);
}

export function homeRoot(homeDir: string): string {
  return trimTrailingSlash(normalizeAbsolutePath(homeDir));
}

export function isWithinHome(path: string, homeDir: string): boolean {
  const home = homeRoot(homeDir);
  const candidate = trimTrailingSlash(normalizeAbsolutePath(path));
  return candidate === home || candidate.startsWith(`${home}/`);
}

export function normalizeCwdForHost(path: string | null | undefined, homeDir: string): string {
  if (!path || path === "~") return homeRoot(homeDir);
  const resolved = path.startsWith("~/") ? joinDirectory(homeRoot(homeDir), path.slice(2)) : path;
  return isWithinHome(resolved, homeDir)
    ? trimTrailingSlash(normalizeAbsolutePath(resolved))
    : homeRoot(homeDir);
}

export function parentWithinHome(path: string, homeDir: string): string | null {
  const current = normalizeCwdForHost(path, homeDir);
  const home = homeRoot(homeDir);
  if (current === home) return null;
  const parent = parentDir(current);
  return isWithinHome(parent, home) ? parent : home;
}

export interface BreadcrumbPart {
  label: string;
  path: string;
}

export function breadcrumbParts(path: string, homeDir: string): BreadcrumbPart[] {
  const home = homeRoot(homeDir);
  const current = normalizeCwdForHost(path, home);
  const crumbs: BreadcrumbPart[] = [{ label: home === "/" ? "/" : "Home", path: home }];
  if (current === home) return crumbs;
  const relative = current.slice(home === "/" ? 1 : home.length + 1);
  let cursor = home;
  for (const part of relative.split("/").filter(Boolean)) {
    cursor = joinDirectory(cursor, part);
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}

export function visibleEntries(
  entries: readonly HostDirEntry[],
  showDotfiles: boolean,
): HostDirEntry[] {
  return entries.filter((entry) => showDotfiles || !entry.name.startsWith("."));
}

export function validateLeafName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "Choose a different name.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "Names cannot contain slashes.";
  for (const char of trimmed) {
    const point = char.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
      return "Names cannot contain control characters.";
  }
  if (new TextEncoder().encode(trimmed).byteLength > 255)
    return "Names must be 255 bytes or fewer.";
  return null;
}
