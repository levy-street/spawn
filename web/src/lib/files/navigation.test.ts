import { describe, expect, test } from "bun:test";
import {
  canGoBack,
  canGoForward,
  currentPath,
  displayPath,
  goBack,
  goForward,
  HISTORY_LIMIT,
  pushHistory,
  resolveGoToFolder,
  startHistory,
} from "./navigation";

describe("Back and Forward", () => {
  test("visiting folders builds a trail Back walks", () => {
    let history = startHistory("/h");
    history = pushHistory(history, "/h/a");
    history = pushHistory(history, "/h/a/b");
    expect(canGoBack(history)).toBe(true);
    expect(canGoForward(history)).toBe(false);
    history = goBack(history);
    expect(currentPath(history)).toBe("/h/a");
    history = goForward(history);
    expect(currentPath(history)).toBe("/h/a/b");
  });

  test("a new visit after Back drops Forward", () => {
    let history = startHistory("/h");
    history = pushHistory(history, "/h/a");
    history = goBack(history);
    history = pushHistory(history, "/h/b");
    expect(history.stack).toEqual(["/h", "/h/b"]);
    expect(canGoForward(history)).toBe(false);
  });

  test("visiting the folder you are in changes nothing", () => {
    const history = startHistory("/h");
    expect(pushHistory(history, "/h")).toBe(history);
  });

  test("at the ends there is nowhere to go", () => {
    const history = startHistory("/h");
    expect(goBack(history)).toBe(history);
    expect(goForward(history)).toBe(history);
  });

  test("keeps a bounded trail", () => {
    let history = startHistory("/h/0");
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) history = pushHistory(history, `/h/${i}`);
    expect(history.stack).toHaveLength(HISTORY_LIMIT);
    expect(currentPath(history)).toBe(`/h/${HISTORY_LIMIT + 20}`);
  });
});

describe("how a path reads", () => {
  test("home and below are spelled from ~", () => {
    expect(displayPath("/home/me", "/home/me", "posix")).toBe("~");
    expect(displayPath("/home/me/code/spawn", "/home/me/", "posix")).toBe("~/code/spawn");
    expect(displayPath("C:\\Users\\me\\Work", "C:\\Users\\me", "windows")).toBe("~\\Work");
  });

  test("anything else is left as it is", () => {
    expect(displayPath("/srv/data", "/home/me", "posix")).toBe("/srv/data");
  });
});

describe("Go to folder", () => {
  const where = { homeDir: "/home/me", cwd: "/home/me/code", flavor: "posix" as const };

  test("accepts ~, ~/… and absolute paths inside home", () => {
    expect(resolveGoToFolder("~", where)).toEqual({ ok: true, path: "/home/me" });
    expect(resolveGoToFolder("~/code/spawn/", where)).toEqual({
      ok: true,
      path: "/home/me/code/spawn",
    });
    expect(resolveGoToFolder(" /home/me/Documents ", where)).toEqual({
      ok: true,
      path: "/home/me/Documents",
    });
  });

  test("a relative path is from the folder you are in, and .. is resolved", () => {
    expect(resolveGoToFolder("spawn/web", where)).toEqual({
      ok: true,
      path: "/home/me/code/spawn/web",
    });
    expect(resolveGoToFolder("../Downloads", where)).toEqual({
      ok: true,
      path: "/home/me/Downloads",
    });
  });

  test("refuses what the host would refuse, before asking it", () => {
    expect(resolveGoToFolder("/etc", where)).toEqual({ ok: false, code: "outside_root" });
    expect(resolveGoToFolder("~/../other", where)).toEqual({ ok: false, code: "outside_root" });
    expect(resolveGoToFolder("/home/meet", where)).toEqual({ ok: false, code: "outside_root" });
    expect(resolveGoToFolder("   ", where)).toEqual({ ok: false, code: "empty" });
  });

  test("Windows paths keep their drive and separators", () => {
    const windows = { homeDir: "C:\\Users\\me", cwd: "C:\\Users\\me", flavor: "windows" as const };
    expect(resolveGoToFolder("~\\Work", windows)).toEqual({
      ok: true,
      path: "C:\\Users\\me\\Work",
    });
    expect(resolveGoToFolder("c:\\users\\me\\Docs", windows)).toEqual({
      ok: true,
      path: "c:\\users\\me\\Docs",
    });
    expect(resolveGoToFolder("D:\\data", windows)).toEqual({ ok: false, code: "outside_root" });
  });
});
