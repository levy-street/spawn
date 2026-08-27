import { normalizeCommandText } from "@/lib/argv";

export type PathFlavor = "posix" | "windows";

export function pathFlavorForHostOS(os: string | null | undefined): PathFlavor {
  return os?.trim().toLowerCase() === "windows" ? "windows" : "posix";
}

export function normalizeCwdForHost(
  value: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): string {
  const fallback = flavor === "windows" ? "\\" : "/";
  const home =
    trimTrailingSlash(
      normalizeAbsolutePath(normalizeCommandText(homeDir).trim() || fallback, flavor),
      flavor,
    ) || fallback;
  const raw = normalizeCommandText(value).trim();
  if (!raw || raw === "~") return home;
  if (/^~[\\/]/u.test(raw)) {
    return normalizeAbsolutePath(joinPath(home, raw.slice(2), flavor), flavor);
  }
  if (flavor === "windows") {
    const driveRelative = /^(?<drive>[A-Za-z]):(?<rest>[^\\/].*)$/u.exec(raw);
    if (driveRelative?.groups) {
      const homeDrive = /^([A-Za-z]):/u.exec(home)?.[1];
      if (homeDrive?.toLowerCase() === driveRelative.groups.drive.toLowerCase()) {
        return normalizeAbsolutePath(joinPath(home, driveRelative.groups.rest, flavor), flavor);
      }
      return normalizeAbsolutePath(raw, flavor);
    }
  }
  if (isAbsolutePath(raw, flavor)) return normalizeAbsolutePath(raw, flavor);
  return normalizeAbsolutePath(joinPath(home, raw, flavor), flavor);
}

export function splitForDirectorySuggestions(
  value: string,
  homeDir: string,
  flavor: PathFlavor = "posix",
): { base: string; prefix: string } {
  const raw = normalizeCommandText(value).trim();
  const resolved = normalizeCwdForHost(value, homeDir, flavor);
  if (!raw || (flavor === "windows" ? /[\\/]$/u.test(raw) : raw.endsWith("/"))) {
    return { base: resolved, prefix: "" };
  }
  return { base: parentDir(resolved, flavor), prefix: basename(resolved, flavor) };
}

export function withTrailingSlash(path: string, flavor: PathFlavor = "posix"): string {
  const fallback = flavor === "windows" ? "\\" : "/";
  const normalized = normalizeAbsolutePath(path.trim() || fallback, flavor);
  const root = pathRoot(normalized, flavor);
  if (normalized === root && root.endsWith(pathSeparator(flavor))) return normalized;
  return `${normalized}${pathSeparator(flavor)}`;
}

export function trimTrailingSlash(path: string, flavor: PathFlavor = "posix"): string {
  if (flavor === "posix") return path.length > 1 ? path.replace(/\/+$/u, "") : path;
  if (/^[A-Za-z]:[\\/]$/u.test(path)) return `${path[0]}:\\`;
  const normalizedSeparators = path.replace(/\//gu, "\\");
  const root = pathRoot(normalizedSeparators, "windows");
  if (normalizedSeparators.toLowerCase() === root.toLowerCase()) return root;
  return normalizedSeparators.replace(/\\+$/u, "");
}

export function parentDir(path: string, flavor: PathFlavor = "posix"): string {
  const fallback = flavor === "windows" ? "\\" : "/";
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path || fallback, flavor), flavor);
  const root = pathRoot(normalized, flavor);
  if (pathsEqual(normalized, root, flavor)) return root;
  const idx = normalized.lastIndexOf(pathSeparator(flavor));
  if (idx < root.length) return root;
  return normalized.slice(0, idx) || root;
}

export function basename(path: string, flavor: PathFlavor = "posix"): string {
  const normalized = trimTrailingSlash(path, flavor);
  if (pathsEqual(normalized, pathRoot(normalized, flavor), flavor)) return "";
  return normalized.slice(normalized.lastIndexOf(pathSeparator(flavor)) + 1);
}

export function joinPath(base: string, rest: string, flavor: PathFlavor = "posix"): string {
  if (!rest) return base;
  const separator = pathSeparator(flavor);
  const leading = flavor === "windows" ? /^[\\/]+/u : /^\/+/u;
  const cleanRest =
    flavor === "windows"
      ? rest.replace(leading, "").replace(/[\\/]+/gu, separator)
      : rest.replace(/^\/+/u, "");
  const cleanBase = trimTrailingSlash(base, flavor);
  if (flavor === "windows") {
    return `${cleanBase}${cleanBase.endsWith(separator) ? "" : separator}${cleanRest}`;
  }
  return `${cleanBase}${separator}${cleanRest}`;
}

export function isAbsolutePath(path: string, flavor: PathFlavor = "posix"): boolean {
  if (flavor === "posix") return path.startsWith("/");
  return /^[A-Za-z]:[\\/]/u.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(path);
}

export function pathRoot(path: string, flavor: PathFlavor = "posix"): string {
  if (flavor === "posix") return "/";
  const canonical = path.replace(/\//gu, "\\");
  const drive = /^([A-Za-z]):(?:\\|$)/u.exec(canonical);
  if (drive) return `${drive[1]}:\\`;
  const unc = /^\\\\([^\\]+)\\([^\\]+)/u.exec(canonical);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  return "\\";
}

export function normalizeAbsolutePath(path: string, flavor: PathFlavor = "posix"): string {
  if (flavor === "posix") {
    const absolute = path.startsWith("/") ? path : `/${path}`;
    const parts: string[] = [];
    for (const part of absolute.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  const canonical = path.replace(/\//gu, "\\");
  let root: string;
  let rest: string;
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/u.exec(canonical);
  const drive = /^([A-Za-z]):(?:\\|$)/u.exec(canonical);
  const driveRelative = /^([A-Za-z]):(.*)$/u.exec(canonical);
  if (unc) {
    root = `\\\\${unc[1]}\\${unc[2]}`;
    rest = canonical.slice(unc[0].length);
  } else if (drive) {
    root = `${drive[1]}:\\`;
    rest = canonical.slice(drive[0].length);
  } else if (driveRelative) {
    root = `${driveRelative[1]}:\\`;
    rest = driveRelative[2];
  } else {
    root = "\\";
    rest = canonical.replace(/^\\+/u, "");
  }

  const parts: string[] = [];
  for (const part of rest.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) return root;
  return `${root}${root.endsWith("\\") ? "" : "\\"}${parts.join("\\")}`;
}

export function pathsEqual(left: string, right: string, flavor: PathFlavor = "posix"): boolean {
  const a = trimTrailingSlash(normalizeAbsolutePath(left, flavor), flavor);
  const b = trimTrailingSlash(normalizeAbsolutePath(right, flavor), flavor);
  return flavor === "windows" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isPathWithin(path: string, root: string, flavor: PathFlavor = "posix"): boolean {
  const target = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor);
  const normalizedRoot = trimTrailingSlash(normalizeAbsolutePath(root, flavor), flavor);
  if (pathsEqual(target, normalizedRoot, flavor)) return true;
  const separator = pathSeparator(flavor);
  const boundary = `${normalizedRoot}${normalizedRoot.endsWith(separator) ? "" : separator}`;
  return flavor === "windows"
    ? target.toLowerCase().startsWith(boundary.toLowerCase())
    : target.startsWith(boundary);
}

export function isValidPathLeafName(value: string, flavor: PathFlavor = "posix"): boolean {
  if (!value || value === "." || value === ".." || value.includes("/")) return false;
  if (flavor === "posix") return true;
  if ([...value].some((character) => character.charCodeAt(0) < 32)) return false;
  if (/[<>:"/\\|?*]/u.test(value) || /[. ]$/u.test(value)) return false;
  const basename = value.split(".", 1)[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(basename);
}

function pathSeparator(flavor: PathFlavor): "/" | "\\" {
  return flavor === "windows" ? "\\" : "/";
}
