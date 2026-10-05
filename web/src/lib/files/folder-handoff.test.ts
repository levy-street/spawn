import { describe, expect, test } from "bun:test";
import {
  FOLDER_STATE_KEY,
  folderFromHistoryState,
  HANDOFF_TTL_MS,
  handOffFolder,
  historyStateWithFolder,
  initialFolder,
  takeHandedOffFolder,
} from "./folder-handoff";

describe("handing a folder to the Files page", () => {
  test("is taken once, by the host it was meant for", () => {
    handOffFolder("host-a", "/home/me/code", 1_000);
    expect(takeHandedOffFolder("host-b", 1_001)).toBeNull();
    expect(takeHandedOffFolder("host-a", 1_002)).toBe("/home/me/code");
    expect(takeHandedOffFolder("host-a", 1_003)).toBeNull();
  });

  test("a hand-over left too long is dropped, not opened later", () => {
    handOffFolder("host-a", "/home/me/old", 1_000);
    expect(takeHandedOffFolder("host-a", 1_000 + HANDOFF_TTL_MS + 1)).toBeNull();
    handOffFolder("host-a", "/home/me/new", 5_000);
    expect(takeHandedOffFolder("host-a", 5_001)).toBe("/home/me/new");
  });
});

describe("the folder kept with the tab", () => {
  test("is recorded beside whatever the router keeps there", () => {
    const routerState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"] };
    const next = historyStateWithFolder(routerState, "host-a", "/home/me/code");
    expect(next).toEqual({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"],
      [FOLDER_STATE_KEY]: { hostId: "host-a", path: "/home/me/code" },
    });
    // The router's own object is never changed under it.
    expect(routerState).toEqual({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"] });
    expect(historyStateWithFolder(null, "host-a", "/x")).toEqual({
      [FOLDER_STATE_KEY]: { hostId: "host-a", path: "/x" },
    });
  });

  test("is read back only for the same host", () => {
    const state = historyStateWithFolder({}, "host-a", "/home/me/code");
    expect(folderFromHistoryState(state, "host-a")).toBe("/home/me/code");
    expect(folderFromHistoryState(state, "host-b")).toBeNull();
    expect(folderFromHistoryState(null, "host-a")).toBeNull();
    expect(folderFromHistoryState({ [FOLDER_STATE_KEY]: "nope" }, "host-a")).toBeNull();
    expect(
      folderFromHistoryState({ [FOLDER_STATE_KEY]: { hostId: "host-a", path: "" } }, "host-a"),
    ).toBeNull();
  });
});

describe("where the page opens", () => {
  test("a hand-over beats a link, which beats the tab's last folder", () => {
    expect(initialFolder({ handedOff: "/a", linked: "/b", kept: "/c" })).toBe("/a");
    expect(initialFolder({ handedOff: null, linked: "/b", kept: "/c" })).toBe("/b");
    expect(initialFolder({ handedOff: null, linked: null, kept: "/c" })).toBe("/c");
    expect(initialFolder({ handedOff: null, linked: "", kept: null })).toBeNull();
  });
});
