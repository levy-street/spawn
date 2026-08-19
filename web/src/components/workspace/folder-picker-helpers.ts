import { normalizeAbsolutePath, trimTrailingSlash } from "@/lib/paths";

export function joinDirectory(parent: string, child: string): string {
  return normalizeAbsolutePath(`${trimTrailingSlash(parent)}/${child}`);
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
