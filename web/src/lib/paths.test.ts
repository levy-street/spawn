import { describe, expect, test } from "bun:test";
import {
  basename,
  isAbsolutePath,
  isValidPathLeafName,
  joinPath,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  parentDir,
  pathsEqual,
  splitForDirectorySuggestions,
  withTrailingSlash,
} from "./paths";

describe("POSIX paths", () => {
  test("keeps the existing cwd resolution byte-for-byte", () => {
    expect(normalizeCwdForHost("~/work/../spawn", "/Users/Ada/")).toBe("/Users/Ada/spawn");
    expect(normalizeCwdForHost("/srv//work", "/Users/Ada")).toBe("/srv/work");
    expect(parentDir("/Users/Ada/work/")).toBe("/Users/Ada");
    expect(withTrailingSlash("/Users/Ada")).toBe("/Users/Ada/");
  });

  test("keeps backslashes legal in a POSIX leaf", () => {
    expect(isValidPathLeafName("a\\b", "posix")).toBe(true);
    expect(isValidPathLeafName("a/b", "posix")).toBe(false);
  });
});

describe("Windows paths", () => {
  test("normalizes drive paths and mixed separators without adding a POSIX root", () => {
    expect(normalizeAbsolutePath("C:\\Users\\Ada\\.\\Work\\..\\spawn", "windows")).toBe(
      "C:\\Users\\Ada\\spawn",
    );
    expect(normalizeAbsolutePath("C:/Users\\Ada/projects", "windows")).toBe(
      "C:\\Users\\Ada\\projects",
    );
    expect(isAbsolutePath("C:\\Users\\Ada", "windows")).toBe(true);
    expect(isAbsolutePath("C:Users\\Ada", "windows")).toBe(false);
  });

  test("resolves same-drive relative input from home and keeps another drive distinct", () => {
    expect(normalizeCwdForHost("C:Work\\spawn", "C:\\Users\\Ada", "windows")).toBe(
      "C:\\Users\\Ada\\Work\\spawn",
    );
    expect(normalizeCwdForHost("D:Work", "C:\\Users\\Ada", "windows")).toBe("D:\\Work");
  });

  test("preserves UNC roots while resolving dot segments", () => {
    expect(normalizeAbsolutePath("\\\\server\\share\\home\\Ada\\..\\Grace", "windows")).toBe(
      "\\\\server\\share\\home\\Grace",
    );
    expect(parentDir("\\\\server\\share", "windows")).toBe("\\\\server\\share");
    expect(parentDir("C:\\", "windows")).toBe("C:\\");
    expect(joinPath("C:\\", "Users/Ada", "windows")).toBe("C:\\Users\\Ada");
    expect(joinPath("\\\\server\\share", "home/Ada", "windows")).toBe(
      "\\\\server\\share\\home\\Ada",
    );
  });

  test("compares containment inputs case-insensitively without changing display case", () => {
    expect(pathsEqual("C:\\Users\\Ada", "c:/users/ada/", "windows")).toBe(true);
    expect(normalizeAbsolutePath("c:/users/ada", "windows")).toBe("c:\\users\\ada");
  });

  test("splits suggestions on either separator and emits canonical requests", () => {
    expect(splitForDirectorySuggestions("~/Pro", "C:\\Users\\Ada", "windows")).toEqual({
      base: "C:\\Users\\Ada",
      prefix: "Pro",
    });
    expect(splitForDirectorySuggestions("C:/Users/Ada/", "C:\\Users\\Ada", "windows")).toEqual({
      base: "C:\\Users\\Ada",
      prefix: "",
    });
    expect(basename("C:\\Users\\Ada\\Work", "windows")).toBe("Work");
  });

  test.each([
    "bad<name",
    "bad:name",
    "bad/name",
    "bad\\name",
    "bad?name",
    "bad*name",
  ])("rejects forbidden leaf %p", (name) =>
    expect(isValidPathLeafName(name, "windows")).toBe(false));

  test.each([
    "name.",
    "name ",
    "CON",
    "con.txt",
    "PRN",
    "AUX.log",
    "NUL",
    "COM1",
    "LPT9.md",
  ])("rejects reserved or trailing leaf %p", (name) =>
    expect(isValidPathLeafName(name, "windows")).toBe(false));

  test("accepts ordinary Windows names and non-reserved lookalikes", () => {
    expect(isValidPathLeafName("console.txt", "windows")).toBe(true);
    expect(isValidPathLeafName("COM10.txt", "windows")).toBe(true);
    expect(isValidPathLeafName("Project notes", "windows")).toBe(true);
  });
});
