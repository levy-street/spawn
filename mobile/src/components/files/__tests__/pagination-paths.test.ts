import { HOST_DIRECTORY_PAGE_ENTRIES, validateDirectoryPage } from "@/components/files/pagination";
import {
  basename,
  breadcrumbParts,
  displayPath,
  isWithinHome,
  joinDirectory,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  parentDir,
  parentWithinHome,
  pathFlavorForHostOS,
  resolveFolderInput,
  resolveLinkedFolder,
  validateLeafName,
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

  it("reads a folder the way a person does: ~ inside home, the full path outside", () => {
    expect(displayPath("/home/me", "/home/me")).toBe("~");
    expect(displayPath("/home/me/code/spawn/", "/home/me")).toBe("~/code/spawn");
    expect(displayPath("/srv/data", "/home/me")).toBe("/srv/data");
    expect(displayPath("c:\\users\\ada\\Work", "C:\\Users\\Ada", "windows")).toBe("~\\Work");
  });

  it("resolves Go to folder input inside home, and refuses anything above it", () => {
    const at = (input: string, cwd = "/home/me/code") =>
      resolveFolderInput(input, { homeDir: "/home/me", cwd });
    expect(at("~")).toEqual({ path: "/home/me" });
    expect(at(" ~/code/../docs/ ")).toEqual({ path: "/home/me/docs" });
    expect(at("/home/me/code")).toEqual({ path: "/home/me/code" });
    // No ~ and no leading slash: read from the folder on screen, as a shell does.
    expect(at("spawn/web")).toEqual({ path: "/home/me/code/spawn/web" });
    expect(at("../docs")).toEqual({ path: "/home/me/docs" });
    expect(at("spawn", "")).toEqual({ path: "/home/me/spawn" });
    expect(at("")).toEqual({ error: "empty" });
    for (const outside of ["/etc", "~/../other", "../../other"]) {
      expect(at(outside).error).toBe("outside_root");
    }
  });

  it("resolves Windows input with either separator and refuses other drives", () => {
    const at = (input: string) =>
      resolveFolderInput(input, {
        homeDir: "C:\\Users\\Ada",
        cwd: "C:\\Users\\Ada\\Work",
        flavor: "windows",
      });
    expect(at("~\\Work")).toEqual({ path: "C:\\Users\\Ada\\Work" });
    expect(at("~/Work")).toEqual({ path: "C:\\Users\\Ada\\Work" });
    expect(at("c:/users/ada/Work")).toEqual({ path: "c:\\users\\ada\\Work" });
    expect(at("Notes")).toEqual({ path: "C:\\Users\\Ada\\Work\\Notes" });
    expect(at("D:\\Work").error).toBe("outside_root");
    expect(at("C:Work").error).toBe("outside_root");
    // A leading separator is the drive's root, as the web reads it, never the folder on screen.
    expect(at("\\Notes").error).toBe("outside_root");
  });

  it("knows a link that names somewhere outside home", () => {
    expect(resolveLinkedFolder("/etc", "/home/me")).toEqual({
      folder: "/home/me",
      outsideHome: true,
    });
    expect(resolveLinkedFolder("~/code", "/home/me")).toEqual({
      folder: "/home/me/code",
      outsideHome: false,
    });
    expect(resolveLinkedFolder(undefined, "/home/me")).toEqual({
      folder: "/home/me",
      outsideHome: false,
    });
  });
});
