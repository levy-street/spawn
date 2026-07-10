import { normalizeCommandText } from "@/lib/argv";

export function normalizeCwdForHost(value: string, homeDir: string): string {
  const home = trimTrailingSlash(normalizeCommandText(homeDir).trim() || "/") || "/";
  const raw = normalizeCommandText(value).trim();
  if (!raw) return home;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return normalizeAbsolutePath(joinPath(home, raw.slice(2)));
  if (raw.startsWith("/")) return normalizeAbsolutePath(raw);
  return normalizeAbsolutePath(joinPath(home, raw));
}

export function splitForDirectorySuggestions(
  value: string,
  homeDir: string,
): { base: string; prefix: string } {
  const raw = normalizeCommandText(value).trim();
  const resolved = normalizeCwdForHost(value, homeDir);
  if (!raw || raw.endsWith("/")) return { base: resolved, prefix: "" };
  return { base: parentDir(resolved), prefix: basename(resolved) };
}

export function withTrailingSlash(path: string): string {
  const normalized = normalizeAbsolutePath(path.trim() || "/");
  return normalized === "/" ? normalized : `${normalized}/`;
}

export function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

export function parentDir(path: string): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

export function basename(path: string): string {
  const normalized = trimTrailingSlash(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function joinPath(base: string, rest: string): string {
  if (!rest) return base;
  return `${trimTrailingSlash(base)}/${rest.replace(/^\/+/u, "")}`;
}

export function normalizeAbsolutePath(path: string): string {
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
