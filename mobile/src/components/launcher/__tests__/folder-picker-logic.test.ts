import {
  breadcrumbParts,
  type HostDirEntry,
  type HostDirList,
  isWithinHome,
  joinDirectory,
  listAllEntries,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  parentWithinHome,
  pathBasename,
  visibleDirectories,
} from "@/components/launcher/folder-picker-logic";
import { loadLauncherRecents } from "@/data/queries/launcher";

const entries = [
  { name: "src", path: "/home/ada/src", kind: "directory", is_dir: true },
  { name: ".git", path: "/home/ada/.git", kind: "directory", is_dir: true },
  { name: "README.md", path: "/home/ada/README.md", kind: "file", is_dir: false },
  { name: "Archive", path: "/home/ada/Archive", kind: "directory", is_dir: true },
] satisfies HostDirEntry[];

describe("folder picker", () => {
  test("keeps directories only, hides dot-folders, filters, and sorts without case", () => {
    expect(visibleDirectories(entries).map((entry) => entry.name)).toEqual(["Archive", "src"]);
    expect(visibleDirectories(entries, { showHidden: true }).map((entry) => entry.name)).toEqual([
      ".git",
      "Archive",
      "src",
    ]);
    expect(visibleDirectories(entries, { filter: " ARCH " }).map((entry) => entry.name)).toEqual([
      "Archive",
    ]);
    expect(visibleDirectories(entries, { filter: "git" })).toEqual([]);
  });

  test("normalizes navigation and clamps stale paths to host home", () => {
    expect(joinDirectory("/home/ada/project", "../archive")).toBe("/home/ada/archive");
    expect(isWithinHome("/home/ada/project", "/home/ada")).toBe(true);
    expect(isWithinHome("/home/adaptive", "/home/ada")).toBe(false);
    expect(parentWithinHome("/home/ada/project", "/home/ada")).toBe("/home/ada");
    expect(parentWithinHome("/home/ada", "/home/ada")).toBeNull();
    expect(normalizeCwdForHost("/etc", "/home/ada")).toBe("/home/ada");
  });

  test("derives breadcrumbs from one canonical path", () => {
    expect(breadcrumbParts("/home/ada/dev/spawn", "/home/ada")).toEqual([
      { label: "Home", path: "/home/ada" },
      { label: "dev", path: "/home/ada/dev" },
      { label: "spawn", path: "/home/ada/dev/spawn" },
    ]);
  });

  test("navigates Windows drive paths without POSIX normalization", () => {
    const home = "C:\\Users\\Ada";
    expect(normalizeAbsolutePath("C:/Users\\Ada/Work/../src", "windows")).toBe(
      "C:\\Users\\Ada\\src",
    );
    expect(joinDirectory(home, "project/src", "windows")).toBe("C:\\Users\\Ada\\project\\src");
    expect(isWithinHome("c:\\users\\ada\\project", home, "windows")).toBe(true);
    expect(isWithinHome("C:\\Users\\Adaptive", home, "windows")).toBe(false);
    expect(parentWithinHome("c:\\users\\ada\\project", home, "windows")).toBe(home);
    expect(normalizeCwdForHost("C:project", home, "windows")).toBe(home);
    expect(pathBasename("C:\\Users\\Ada\\project", "windows")).toBe("project");
    expect(breadcrumbParts("C:\\Users\\Ada\\project\\src", home, "windows")).toEqual([
      { label: "Home", path: home },
      { label: "project", path: "C:\\Users\\Ada\\project" },
      { label: "src", path: "C:\\Users\\Ada\\project\\src" },
    ]);
  });

  test("navigates UNC paths at the reported share ceiling", () => {
    const home = "\\\\server\\share";
    expect(normalizeCwdForHost("//SERVER/share/home/Ada", home, "windows")).toBe(
      "\\\\SERVER\\share\\home\\Ada",
    );
    expect(parentWithinHome(home, home, "windows")).toBeNull();
    expect(breadcrumbParts("\\\\server\\share\\home", home, "windows")).toEqual([
      { label: home, path: home },
      { label: "home", path: "\\\\server\\share\\home" },
    ]);
  });

  test("drains cursor pages and stops after at most twelve", async () => {
    const cursors: number[] = [];
    const result = await listAllEntries((cursor) => {
      cursors.push(cursor);
      return Promise.resolve({
        path: "/home/ada",
        home_dir: "/home/ada",
        entries: [entries[0] as HostDirEntry],
        next_cursor: cursor + 1,
      } satisfies HostDirList);
    });
    expect(cursors).toHaveLength(12);
    expect(result.entries).toHaveLength(12);
    expect(result.truncated).toBe(true);
  });

  test("stops after a complete page", async () => {
    const fetch = jest.fn(async () => ({
      path: "/home/ada",
      home_dir: "/home/ada",
      entries,
      next_cursor: null,
    }));
    const result = await listAllEntries(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  test("loads the host's eight recents through the authenticated API loader", async () => {
    const recent = [{ path: "/home/ada/spawn", last_used_at: "2026-08-22T00:00:00.000Z" }];
    const load = jest.fn(async () => ({ dirs: recent }));
    await expect(loadLauncherRecents("host-1", load)).resolves.toEqual(recent);
    expect(load).toHaveBeenCalledWith("host-1");
  });
});
