import { describe, expect, test } from "bun:test";
import {
  changedOnHostNotice,
  changeErrorCopy,
  deleteConfirmCopy,
  deletedNotice,
  deletingNotice,
  itemCount,
  listErrorCopy,
  noFilterMatches,
  onlyHiddenFiles,
  partialDeleteNotice,
  SORT_ORDER_LABELS,
  statusSummary,
  truncationNotice,
} from "./copy";

describe("the file browser's words", () => {
  test("a truncated folder is honest about what was listed", () => {
    expect(truncationNotice("dream")).toBe(
      "This folder has more than 1,024 items. SPAWN D on dream can only list the first 1,024 it finds, so sorting and filtering cover just those.",
    );
  });

  test("a folder that cannot be opened says why, naming the host", () => {
    expect(listErrorCopy("outside_root", "dream")).toBe(
      "SPAWN D only opens folders inside your home folder on dream.",
    );
    expect(listErrorCopy("traversal_rejected", "dream")).toBe(
      listErrorCopy("outside_root", "dream"),
    );
    expect(listErrorCopy("not_found", "dream")).toBe("There's no folder at that path on dream.");
    expect(listErrorCopy("symlink_rejected", "dream")).toBe(
      "That path goes through a link SPAWN D doesn't follow.",
    );
    expect(listErrorCopy("not_directory", "dream")).toBe("That's a file on dream, not a folder.");
    expect(listErrorCopy("something_new", "dream")).toBeNull();
  });

  test("a change that did not happen says why", () => {
    expect(changeErrorCopy("already_exists", { host: "dream", name: "notes.md" })).toBe(
      "There's already an item named “notes.md” here.",
    );
    expect(changeErrorCopy("outcome_unknown", { host: "dream", name: "x" })).toContain(
      "may or may not have happened",
    );
    expect(changeErrorCopy(null, { host: "dream", name: "x" })).toBeNull();
  });

  test("deleting names what goes and that it is permanent, in the phone's words", () => {
    expect(deleteConfirmCopy([{ name: "notes.md", isDir: false }], "dream")).toEqual({
      title: "Delete “notes.md” permanently?",
      body: "It won't go to the Trash on dream. This can't be undone.",
      confirmLabel: "Delete permanently",
    });
    expect(deleteConfirmCopy([{ name: "src", isDir: true }], "dream").body).toBe(
      "It won't go to the Trash on dream. Everything inside the folder goes with it. This can't be undone.",
    );
    const three = deleteConfirmCopy(
      [
        { name: "a", isDir: false },
        { name: "b", isDir: false },
        { name: "c", isDir: false },
      ],
      "dream",
    );
    expect(three.title).toBe("Delete 3 items permanently?");
    expect(three.body).toBe("They won't go to the Trash on dream. This can't be undone.");
    expect(
      deleteConfirmCopy(
        [
          { name: "a", isDir: true },
          { name: "b", isDir: false },
        ],
        "dream",
      ).body,
    ).toBe(
      "They won't go to the Trash on dream. Folders go with everything inside them. This can't be undone.",
    );
  });

  test("a delete's outcome names the host", () => {
    expect(deletingNotice(["a"], "dream")).toBe("Deleting “a” on dream…");
    expect(deletingNotice(["a", "b"], "dream")).toBe("Deleting 2 items on dream…");
    expect(deletedNotice(["a"], "dream")).toBe("Deleted “a” on dream");
    expect(deletedNotice(["a", "b"], "dream")).toBe("Deleted 2 items on dream");
    expect(
      partialDeleteNotice(2, 3, "dream", {
        name: "x",
        reason: "“x” is no longer there on dream.",
      }),
    ).toBe("Deleted 2 of 3 items on dream. “x” wasn't deleted: “x” is no longer there on dream.");
  });

  test("counts read naturally", () => {
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(1024)).toBe("1,024 items");
  });

  test("empty states say why nothing shows", () => {
    expect(onlyHiddenFiles(3)).toBe("This folder has only hidden files (3).");
    expect(noFilterMatches(" zsh ")).toBe("Nothing in this folder matches “zsh”.");
    expect(noFilterMatches("zsh", 1)).toBe(
      "Nothing in this folder matches “zsh”. 1 hidden file matches.",
    );
    expect(noFilterMatches("env", 2)).toBe(
      "Nothing in this folder matches “env”. 2 hidden files match.",
    );
  });

  test("a big folder that moved on its host says so", () => {
    expect(changedOnHostNotice("dream")).toBe("This folder changed on dream.");
  });

  test("sort directions are worded for their field", () => {
    expect(SORT_ORDER_LABELS.name).toEqual({ asc: "A to Z", desc: "Z to A" });
    expect(SORT_ORDER_LABELS.modified).toEqual({ desc: "Newest first", asc: "Oldest first" });
    expect(SORT_ORDER_LABELS.size).toEqual({ desc: "Largest first", asc: "Smallest first" });
    expect(SORT_ORDER_LABELS.kind).toEqual({ asc: "A to Z", desc: "Z to A" });
  });

  test("the status bar summary counts what is shown", () => {
    const formatBytes = (bytes: number) => `${bytes} B`;
    expect(
      statusSummary({ shown: 142, hidden: 0, selected: 0, selectedBytes: null, formatBytes }),
    ).toBe("142 items");
    expect(
      statusSummary({ shown: 142, hidden: 12, selected: 3, selectedBytes: 300, formatBytes }),
    ).toBe("142 items · 12 hidden · 3 selected, 300 B");
    expect(
      statusSummary({ shown: 2, hidden: 0, selected: 1, selectedBytes: null, formatBytes }),
    ).toBe("2 items · 1 selected");
  });
});
