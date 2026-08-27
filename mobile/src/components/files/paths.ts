import type { HostDirEntry } from "@/components/files/types";

export type PathFlavor = "posix" | "windows";

interface WindowsRoot {
  root: string;
  rest: string;
  kind: "drive" | "unc";
}

function normalizedSegments(parts: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized;
}

function windowsRoot(path: string): WindowsRoot | null {
  const canonical = path.replace(/\//gu, "\\");
  const drive = /^([A-Za-z]:)\\/u.exec(canonical);
  if (drive) {
    return {
      root: `${drive[1]}\\`,
      rest: canonical.slice(drive[0].length),
      kind: "drive",
    };
  }
  if (!canonical.startsWith("\\\\")) return null;
  const parts = canonical.slice(2).split("\\");
  const server = parts[0];
  const share = parts[1];
  if (!server || !share) return null;
  return {
    root: `\\\\${server}\\${share}`,
    rest: parts.slice(2).join("\\"),
    kind: "unc",
  };
}

function normalizeWindowsPath(path: string): string {
  const canonical = path.replace(/\//gu, "\\");
  const root = windowsRoot(canonical);
  if (root) {
    const rest = normalizedSegments(root.rest.split("\\")).join("\\");
    if (!rest) return root.root;
    return root.kind === "drive" ? `${root.root}${rest}` : `${root.root}\\${rest}`;
  }
  const driveRelative = /^([A-Za-z]:)(?!\\)(.*)$/u.exec(canonical);
  if (driveRelative) {
    const rest = normalizedSegments((driveRelative[2] ?? "").split("\\")).join("\\");
    return `${driveRelative[1]}${rest}`;
  }
  return normalizedSegments(canonical.split("\\")).join("\\");
}

export function pathFlavorForHostOS(hostOS: string | null | undefined): PathFlavor {
  return hostOS?.trim().toLocaleLowerCase() === "windows" ? "windows" : "posix";
}

export function trimTrailingSlash(path: string, flavor: PathFlavor = "posix"): string {
  if (flavor === "windows") {
    const normalized = normalizeWindowsPath(path);
    const root = windowsRoot(normalized);
    if (root && normalized === root.root) return normalized;
    return normalized.replace(/\\+$/u, "");
  }
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

export function normalizeAbsolutePath(path: string, flavor: PathFlavor = "posix"): string {
  if (flavor === "windows") return normalizeWindowsPath(path);
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts = normalizedSegments(absolute.split("/"));
  return `/${parts.join("/")}`;
}

export function basename(path: string, flavor: PathFlavor = "posix"): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor);
  if (flavor === "windows") {
    const root = windowsRoot(normalized);
    if (root && normalized === root.root) return root.root;
    return normalized.split("\\").at(-1) ?? normalized;
  }
  return normalized === "/" ? "/" : (normalized.split("/").at(-1) ?? normalized);
}

export function parentDir(path: string, flavor: PathFlavor = "posix"): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor);
  if (flavor === "windows") {
    const root = windowsRoot(normalized);
    if (root && normalized === root.root) return root.root;
    const slash = normalized.lastIndexOf("\\");
    if (!root || slash < root.root.length) return root?.root ?? normalized;
    const parent = normalized.slice(0, slash);
    return parent === root.root.replace(/\\$/u, "") ? root.root : parent;
  }
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function joinDirectory(path: string, name: string, flavor: PathFlavor = "posix"): string {
  const separator = flavor === "windows" ? "\\" : "/";
  return normalizeAbsolutePath(`${trimTrailingSlash(path, flavor)}${separator}${name}`, flavor);
}

export function homeRoot(homeDir: string, flavor: PathFlavor = "posix"): string {
  return trimTrailingSlash(normalizeAbsolutePath(homeDir, flavor), flavor);
}

export function pathEquals(left: string, right: string, flavor: PathFlavor = "posix"): boolean {
  const normalizedLeft = trimTrailingSlash(normalizeAbsolutePath(left, flavor), flavor);
  const normalizedRight = trimTrailingSlash(normalizeAbsolutePath(right, flavor), flavor);
  return flavor === "windows"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isWithinHome(path: string, homeDir: string, flavor: PathFlavor = "posix"): boolean {
  const home = homeRoot(homeDir, flavor);
  const candidate = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor);
  const separator = flavor === "windows" ? "\\" : "/";
  const comparableHome = flavor === "windows" ? home.toLocaleLowerCase() : home;
  const comparableCandidate = flavor === "windows" ? candidate.toLocaleLowerCase() : candidate;
  const homePrefix = comparableHome.endsWith(separator)
    ? comparableHome
    : `${comparableHome}${separator}`;
  return comparableCandidate === comparableHome || comparableCandidate.startsWith(homePrefix);
}

export function normalizeCwdForHost(
  path: string | null | undefined,
  homeDir: string,
  flavor: PathFlavor = "posix",
): string {
  const home = homeRoot(homeDir, flavor);
  if (!path || path === "~") return home;
  const homeRelative = flavor === "windows" ? /^~[\\/]/u : /^~\//u;
  const resolved = homeRelative.test(path) ? joinDirectory(home, path.slice(2), flavor) : path;
  return isWithinHome(resolved, home, flavor)
    ? trimTrailingSlash(normalizeAbsolutePath(resolved, flavor), flavor)
    : home;
}

export function parentWithinHome(
  path: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): string | null {
  const current = normalizeCwdForHost(path, homeDir, flavor);
  const home = homeRoot(homeDir, flavor);
  if (pathEquals(current, home, flavor)) return null;
  const parent = parentDir(current, flavor);
  if (pathEquals(parent, home, flavor)) return home;
  return isWithinHome(parent, home, flavor) ? parent : home;
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
  const home = homeRoot(homeDir, flavor);
  const current = normalizeCwdForHost(path, home, flavor);
  const windowsHomeIsRoot = flavor === "windows" && windowsRoot(home)?.root === home;
  const crumbs: BreadcrumbPart[] = [
    { label: home === "/" || windowsHomeIsRoot ? home : "Home", path: home },
  ];
  if (pathEquals(current, home, flavor)) return crumbs;
  const separator = flavor === "windows" ? "\\" : "/";
  const relative = current
    .slice(home.length)
    .replace(flavor === "windows" ? /^[\\/]+/u : /^\/+/, "");
  let cursor = home;
  for (const part of relative.split(separator).filter(Boolean)) {
    cursor = joinDirectory(cursor, part, flavor);
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

export function validateLeafName(name: string, flavor: PathFlavor = "posix"): string | null {
  const candidate = flavor === "windows" ? name : name.trim();
  if (candidate.length === 0 || candidate.trim().length === 0) return "Enter a name.";
  if (candidate === "." || candidate === "..") return "Choose a different name.";
  if (flavor === "windows") {
    if (/[<>:"/\\|?*]/u.test(candidate)) return "Names cannot contain Windows-reserved characters.";
    if (/[. ]$/u.test(candidate)) return "Windows names cannot end with a dot or space.";
    const basename = candidate.split(".", 1)[0]?.toLocaleUpperCase() ?? "";
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(basename))
      return "Choose a different name.";
  } else if (candidate.includes("/") || candidate.includes("\\")) {
    return "Names cannot contain slashes.";
  }
  for (const char of candidate) {
    const point = char.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
      return "Names cannot contain control characters.";
  }
  if (new TextEncoder().encode(candidate).byteLength > 255)
    return "Names must be 255 bytes or fewer.";
  return null;
}
