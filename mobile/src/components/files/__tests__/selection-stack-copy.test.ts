import {
  DELETE_PERMANENTLY_MENU,
  deleteConfirmDescription,
  deleteConfirmTitle,
  deletedNotice,
  deletingNotice,
  emptyFolderDescription,
  folderCountLabel,
  noMatchesDescription,
  partialDeleteMessage,
  selectionCountLabel,
  truncatedFolderNotice,
} from "@/components/files/copy";
import { isHostFilesRoute, screensBackToFolder } from "@/components/files/folder-stack";
import {
  allShownSelected,
  EMPTY_SELECTION,
  retainShown,
  selectAllShown,
  selectedEntries,
  toggleSelected,
} from "@/components/files/selection";
import type { HostDirEntry } from "@/components/files/types";

const entry = (name: string, is_dir = false): HostDirEntry => ({
  name,
  path: `/home/me/${name}`,
  kind: is_dir ? "directory" : "file",
  is_dir,
});

describe("selection", () => {
  const shown = [entry("a"), entry("b"), entry("c")];

  test("toggles, selects everything shown, and reads back in the folder's order", () => {
    let selection = toggleSelected(EMPTY_SELECTION, "/home/me/c");
    selection = toggleSelected(selection, "/home/me/a");
    expect(selectedEntries(selection, shown).map(({ name }) => name)).toEqual(["a", "c"]);
    expect(allShownSelected(selection, shown)).toBe(false);
    expect(allShownSelected(selectAllShown(shown), shown)).toBe(true);
    expect(toggleSelected(selection, "/home/me/a").has("/home/me/a")).toBe(false);
    expect(allShownSelected(EMPTY_SELECTION, [])).toBe(false);
  });

  test("forgets what is no longer shown, and keeps its identity when nothing went", () => {
    const selection = selectAllShown(shown);
    expect(retainShown(selection, shown)).toBe(selection);
    expect([...retainShown(selection, [entry("b")])]).toEqual(["/home/me/b"]);
    expect(retainShown(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });
});

describe("the folder stack", () => {
  const files = (path?: string, id = "host-1") => ({
    name: "host/[id]/files",
    params: path === undefined ? { id } : { id, path },
  });
  const same = (target: string) => (path: string | undefined) => (path ?? "~") === target;

  test("finds a breadcrumb's folder under the current screen", () => {
    const routes = [{ name: "(tabs)" }, files(), files("~/code"), files("~/code/spawn")];
    expect(screensBackToFolder(routes, 3, "host-1", same("~/code"))).toBe(1);
    expect(screensBackToFolder(routes, 3, "host-1", same("~"))).toBe(2);
    expect(screensBackToFolder(routes, 3, "host-1", same("~/elsewhere"))).toBe(0);
  });

  test("never goes back past a screen that is not this host's folder", () => {
    const routes = [files(), { name: "terminal/[sessionId]" }, files("~/code")];
    expect(screensBackToFolder(routes, 2, "host-1", same("~"))).toBe(0);
    const otherHost = [files(undefined, "host-2"), files("~/code")];
    expect(screensBackToFolder(otherHost, 1, "host-1", same("~"))).toBe(0);
  });

  test("recognises the route however the navigator names it", () => {
    expect(isHostFilesRoute({ name: "files", params: { id: "h" } }, "h")).toBe(true);
    expect(isHostFilesRoute({ name: "host/[id]/files", params: { id: ["h"] } }, "h")).toBe(true);
    expect(isHostFilesRoute({ name: "host/[id]/agents", params: { id: "h" } }, "h")).toBe(false);
    expect(isHostFilesRoute(undefined, "h")).toBe(false);
  });
});

describe("explorer copy", () => {
  test("delete confirmations name what goes, where, and that it is permanent", () => {
    expect(deleteConfirmTitle([entry("notes.md")])).toBe("Delete “notes.md” permanently?");
    expect(deleteConfirmTitle([entry("a"), entry("b"), entry("c")])).toBe(
      "Delete 3 items permanently?",
    );
    expect(deleteConfirmDescription([entry("a"), entry("b")], "dream")).toBe(
      "They won't go to the Trash on dream. This can't be undone.",
    );
    expect(deleteConfirmDescription([entry("src", true)], "dream")).toBe(
      "It won't go to the Trash on dream. Everything inside the folder goes with it. This can't be undone.",
    );
    expect(deleteConfirmDescription([entry("src", true), entry("a")], "mac-mini")).toBe(
      "They won't go to the Trash on mac-mini. Folders go with everything inside them. This can't be undone.",
    );
  });

  test("a partial delete says how many went and why one did not", () => {
    expect(
      partialDeleteMessage(2, 3, "dream", {
        name: "locked",
        reason: "You do not have permission to change this item.",
      }),
    ).toBe(
      "Deleted 2 of 3 items on dream. “locked” wasn't deleted: You do not have permission to change this item.",
    );
  });

  test("a delete says what is going and what went, on which host", () => {
    expect(deletingNotice([entry("notes.md")], "dream")).toBe("Deleting “notes.md” on dream…");
    expect(deletingNotice([entry("a"), entry("b")], "dream")).toBe("Deleting 2 items on dream…");
    expect(deletedNotice(["notes.md"], "dream")).toBe("Deleted “notes.md” on dream");
    expect(deletedNotice(["a", "b", "c"], "dream")).toBe("Deleted 3 items on dream");
    // With no Trash yet, a menu's delete says what it does.
    expect(DELETE_PERMANENTLY_MENU).toBe("Delete permanently…");
  });

  test("the truncation notice is honest about what sorting covers, and promises no update", () => {
    const notice = truncatedFolderNotice("dream");
    expect(notice).toBe(
      "This folder has more than 1,024 items. SPAWN D on dream can only list the first 1,024 it finds, so sorting and filtering cover just those.",
    );
    expect(notice).not.toMatch(/update/iu);
  });

  test("counts and empty states", () => {
    expect(folderCountLabel(1, 0)).toBe("1 item");
    expect(folderCountLabel(1420, 12)).toBe("1,420 items · 12 hidden");
    expect(selectionCountLabel(0)).toBe("Select items");
    expect(selectionCountLabel(3)).toBe("3 selected");
    expect(emptyFolderDescription(false, 0)).toBe("This folder is empty.");
    expect(emptyFolderDescription(false, 4)).toBe("This folder has only hidden files (4).");
    expect(emptyFolderDescription(true, 0)).toBe("This folder is empty.");
    expect(noMatchesDescription(" env ", 0)).toBe("Nothing in this folder matches “env”.");
    expect(noMatchesDescription("env", 1)).toBe(
      "Nothing in this folder matches “env”. 1 hidden file matches.",
    );
    expect(noMatchesDescription("env", 2)).toBe(
      "Nothing in this folder matches “env”. 2 hidden files match.",
    );
  });
});
