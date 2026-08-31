import {
  HOST_DIRECTORY_PAGE_ENTRIES,
  retainDirectoryPages,
  validateDirectoryPage,
} from "@/components/files/pagination";
import {
  basename,
  breadcrumbParts,
  isWithinHome,
  joinDirectory,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  parentDir,
  parentWithinHome,
  pathFlavorForHostOS,
  validateLeafName,
  visibleEntries,
} from "@/components/files/paths";
import type { HostDirEntry, HostDirList } from "@/components/files/types";

const entry = (name: string): HostDirEntry => ({
  name,
  path: `/home/me/${name}`,
  kind: "file",
  is_dir: false,
});
const page = (names: string[], next: number | null, truncated = false): HostDirList => ({
  path: "/home/me",
  home_dir: "/home/me",
  entries: names.map(entry),
  next_cursor: next,
  truncated,
});

describe("file pagination and paths", () => {
  it("preserves daemon order across explicit pages", () => {
    const result = retainDirectoryPages([page(["z", "a"], 2), page(["m"], null)]);
    expect(result.entries.map(({ name }) => name)).toEqual(["z", "a", "m"]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects oversized pages and non-advancing cursors", () => {
    expect(() =>
      validateDirectoryPage(
        page(
          Array.from({ length: HOST_DIRECTORY_PAGE_ENTRIES + 1 }, (_, index) => String(index)),
          null,
        ),
        0,
      ),
    ).toThrow("invalid directory page");
    expect(() => validateDirectoryPage(page(["a"], 4), 4)).toThrow("invalid directory page");
  });

  it("stops at the retained entry budget", () => {
    const result = retainDirectoryPages([page(["a", "b", "c"], 3)], 2);
    expect(result.entries.map(({ name }) => name)).toEqual(["a", "b"]);
    expect(result.limitReached).toBe(true);
  });

  it("clamps paths to home and derives breadcrumbs", () => {
    expect(normalizeCwdForHost("/etc", "/home/me")).toBe("/home/me");
    expect(parentWithinHome("/home/me/project/src", "/home/me")).toBe("/home/me/project");
    expect(breadcrumbParts("/home/me/project/src", "/home/me")).toEqual([
      { label: "Home", path: "/home/me" },
      { label: "project", path: "/home/me/project" },
      { label: "src", path: "/home/me/project/src" },
    ]);
  });

  it("preserves drive roots and canonicalizes mixed Windows separators", () => {
    expect(pathFlavorForHostOS(" WINDOWS ")).toBe("windows");
    expect(normalizeAbsolutePath("C:/Users\\Ada/./Work/../src", "windows")).toBe(
      "C:\\Users\\Ada\\src",
    );
    expect(joinDirectory("C:\\Users\\Ada", "Work/src", "windows")).toBe(
      "C:\\Users\\Ada\\Work\\src",
    );
    expect(parentDir("C:\\", "windows")).toBe("C:\\");
    expect(basename("C:\\", "windows")).toBe("C:\\");
  });

  it("clamps drive-relative and outside-drive Windows inputs to home", () => {
    const home = "C:\\Users\\Ada";
    expect(normalizeAbsolutePath("C:Work\\spawn", "windows")).toBe("C:Work\\spawn");
    expect(normalizeCwdForHost("C:Work\\spawn", home, "windows")).toBe(home);
    expect(normalizeCwdForHost("D:\\Work", home, "windows")).toBe(home);
    expect(normalizeCwdForHost("~\\Work", home, "windows")).toBe("C:\\Users\\Ada\\Work");
  });

  it("compares Windows homes without case and keeps navigation at the home ceiling", () => {
    const home = "C:\\Users\\Ada";
    expect(isWithinHome("c:\\users\\ada\\Work", home, "windows")).toBe(true);
    expect(isWithinHome("C:\\Users\\Adaptive", home, "windows")).toBe(false);
    expect(parentWithinHome("c:\\users\\ada\\Work", home, "windows")).toBe(home);
    expect(parentWithinHome(home, home, "windows")).toBeNull();
    expect(normalizeCwdForHost("C:\\Users\\Ada\\..\\Bob", home, "windows")).toBe(home);
    expect(breadcrumbParts("C:/Users/Ada/Work/src", home, "windows")).toEqual([
      { label: "Home", path: home },
      { label: "Work", path: "C:\\Users\\Ada\\Work" },
      { label: "src", path: "C:\\Users\\Ada\\Work\\src" },
    ]);
  });

  it("preserves UNC roots, parents, and breadcrumbs", () => {
    const root = "\\\\server\\share";
    expect(normalizeAbsolutePath("//server/share/home\\Ada/../Grace", "windows")).toBe(
      "\\\\server\\share\\home\\Grace",
    );
    expect(parentDir(root, "windows")).toBe(root);
    expect(isWithinHome("\\\\SERVER\\SHARE\\home", root, "windows")).toBe(true);
    expect(breadcrumbParts("\\\\server\\share\\home\\Ada", root, "windows")).toEqual([
      { label: root, path: root },
      { label: "home", path: "\\\\server\\share\\home" },
      { label: "Ada", path: "\\\\server\\share\\home\\Ada" },
    ]);
  });

  it("supports an explicit dotfile toggle without sorting", () => {
    const entries = [entry("z"), entry(".env"), entry("a")];
    expect(visibleEntries(entries, false).map(({ name }) => name)).toEqual(["z", "a"]);
    expect(visibleEntries(entries, true).map(({ name }) => name)).toEqual(["z", ".env", "a"]);
  });

  it("validates daemon-compatible leaf names", () => {
    expect(validateLeafName("folder")).toBeNull();
    expect(validateLeafName("../folder")).toBe("Names cannot contain slashes.");
    expect(validateLeafName("bad\\name")).toBe("Names cannot contain slashes.");
    expect(validateLeafName("bad\u0000name")).toBe("Names cannot contain control characters.");
    expect(validateLeafName("é".repeat(128))).toBe("Names must be 255 bytes or fewer.");
  });

  it("rejects Windows-reserved leaf names without changing POSIX rules", () => {
    expect(validateLeafName("notes.txt", "windows")).toBeNull();
    expect(validateLeafName("bad:name", "windows")).toBe(
      "Names cannot contain Windows-reserved characters.",
    );
    expect(validateLeafName("folder.", "windows")).toBe(
      "Windows names cannot end with a dot or space.",
    );
    expect(validateLeafName("folder ", "windows")).toBe(
      "Windows names cannot end with a dot or space.",
    );
    for (const name of ["CON", "prn.txt", "AUX", "NUL.log", "COM1", "com9.txt", "LPT1"]) {
      expect(validateLeafName(name, "windows")).toBe("Choose a different name.");
    }
    expect(validateLeafName("COM10", "windows")).toBeNull();
    expect(validateLeafName("name\\part", "posix")).toBe("Names cannot contain slashes.");
  });
});
