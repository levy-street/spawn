import { describe, expect, test } from "bun:test";
import {
  applyToOthersLabel,
  archiveName,
  changedOnHostNotice,
  changeErrorCopy,
  conflictDecisionLabel,
  conflictQuestion,
  countingNotice,
  deleteConfirmCopy,
  deletedNotice,
  deletingNotice,
  downloadItemsLabel,
  formatDuration,
  interruptedNotice,
  itemCount,
  linksSkippedNote,
  listErrorCopy,
  noFilterMatches,
  onlyHiddenFiles,
  PREPARING_NOTICE,
  partialDeleteNotice,
  preparingNotice,
  proceedAnywayLabel,
  relayWarning,
  SEND_HOST_OFFLINE,
  SEND_NO_OTHER_HOST,
  SORT_ORDER_LABELS,
  sendDestinationLine,
  sendFolderTitle,
  sendTitle,
  statusSummary,
  timeLeft,
  tooManyItemsNotice,
  transferDoneSummary,
  transferErrorCopy,
  transferFailedSummary,
  transferProgress,
  transfersSummary,
  transferTitle,
  truncatedFolderNote,
  truncationNotice,
} from "./copy";
import { formatSize } from "./format";

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

test("transfer titles name what moves, between which hosts, and into which folder", () => {
  expect(
    transferTitle({
      verb: "upload",
      names: ["a.txt"],
      to: "dream",
      folder: "Documents",
      finished: false,
    }),
  ).toBe("Uploading “a.txt” to Documents on dream");
  // Done, the title is the notice that it arrived.
  expect(
    transferTitle({
      verb: "upload",
      names: ["a.txt"],
      to: "dream",
      folder: "Home",
      finished: true,
    }),
  ).toBe("Uploaded “a.txt” to Home on dream");
  expect(
    transferTitle({
      verb: "send",
      names: ["a", "b", "c"],
      from: "dream",
      to: "mac-mini",
      folder: "Documents",
      finished: false,
    }),
  ).toBe("Sending 3 items from dream to Documents on mac-mini");
  expect(
    transferTitle({
      verb: "send",
      names: ["a", "b", "c"],
      from: "dream",
      to: "mac-mini",
      folder: "Documents",
      finished: true,
    }),
  ).toBe("Sent 3 items from dream to Documents on mac-mini");
  // A tab that ran it without saying its folder (an older one) still names the host.
  expect(transferTitle({ verb: "upload", names: ["a.txt"], to: "dream", finished: false })).toBe(
    "Uploading “a.txt” to dream",
  );
  expect(
    transferTitle({ verb: "download", names: ["photos.zip"], from: "dream", finished: false }),
  ).toBe("Downloading “photos.zip” from dream");
  expect(sendTitle(["notes.md"], "mac-mini")).toBe("Send “notes.md” to mac-mini");
  expect(sendTitle(["a", "b"], "mac-mini")).toBe("Send 2 items to mac-mini");
  expect(downloadItemsLabel(3)).toBe("Download 3 items as zip");
  expect(archiveName(["photos"], "home")).toBe("photos.zip");
  expect(archiveName(["a", "b"], "projects")).toBe("projects.zip");
  expect(archiveName(["a", "b"], null)).toBe("Files.zip");
});

test("the relay warning (OD3) names the relayed host and the size, and a time only when given", () => {
  expect(
    relayWarning({
      hosts: ["dream"],
      bytes: 1.2 * 1024 ** 3,
      estimate: null,
      formatBytes: formatSize,
    }),
  ).toBe(
    "This transfer goes through the SPAWN D relay because dream and this device can't reach each other directly. 1.2 GB may take a while.",
  );
  expect(
    relayWarning({
      hosts: ["dream", "mac-mini"],
      bytes: 200 * 1024 ** 2,
      estimate: 600,
      formatBytes: formatSize,
    }),
  ).toBe(
    "This transfer goes through the SPAWN D relay because this device can't reach dream or mac-mini directly. 200 MB may take a while. It will take about 10 minutes.",
  );
  expect(proceedAnywayLabel("send")).toBe("Send anyway");
  expect(proceedAnywayLabel("download")).toBe("Download anyway");
});

test("durations round the way a person says them", () => {
  expect(formatDuration(16)).toBe("about 15 seconds");
  expect(formatDuration(47)).toBe("about 45 seconds");
  expect(formatDuration(95)).toBe("about 2 minutes");
  expect(formatDuration(60 * 60)).toBe("about 60 minutes");
  expect(formatDuration(3 * 3600)).toBe("about 3 hours");
  expect(timeLeft(200)).toBe("about 3 minutes left");
});

test("a conflict asks about the item by name, and a folder merges rather than replaces", () => {
  expect(
    conflictQuestion({ name: "notes.md", isDir: false, folder: "Documents", host: "mac-mini" }),
  ).toBe("“notes.md” already exists in Documents on mac-mini.");
  expect(conflictQuestion({ name: "photos", isDir: true, folder: "Home", host: "mac-mini" })).toBe(
    "A folder named “photos” already exists in Home on mac-mini.",
  );
  expect(conflictDecisionLabel("replace", false)).toBe("Replace");
  expect(conflictDecisionLabel("replace", true)).toBe("Merge");
  expect(conflictDecisionLabel("keep-both", true)).toBe("Keep both");
  expect(applyToOthersLabel(3)).toBe("Do this for the other 3");
});

test("an interruption says which kind it was", () => {
  expect(interruptedNotice("other-tab", "dream")).toBe(
    "Interrupted because another SPAWN D tab closed or went to sleep.",
  );
  expect(interruptedNotice("lost-touch", "dream")).toBe(
    "Interrupted because SPAWN D lost touch with dream.",
  );
});

test("progress, summaries and notes", () => {
  expect(
    transferProgress({
      doneBytes: 1024 * 1024,
      totalBytes: 10 * 1024 * 1024,
      doneItems: 3,
      totalItems: 12,
      secondsLeft: 200,
      formatBytes: formatSize,
    }),
  ).toBe("1.0 MB of 10 MB · 3 of 12 items · about 3 minutes left");
  expect(
    transferProgress({
      doneBytes: 0,
      totalBytes: 0,
      doneItems: 0,
      totalItems: 1,
      secondsLeft: null,
      formatBytes: formatSize,
    }),
  ).toBe("0 B of 0 B");
  expect(transferDoneSummary({ items: 12, bytes: 2048, skipped: 2, formatBytes: formatSize })).toBe(
    "12 items · 2.0 KB · 2 skipped",
  );
  expect(transferFailedSummary(1, "send")).toBe("1 item couldn't be sent.");
  expect(linksSkippedNote(1)).toBe("1 link was skipped.");
  expect(linksSkippedNote(2)).toBe("2 links were skipped.");
  expect(truncatedFolderNote(["node_modules"], "dream", "send")).toBe(
    "“node_modules” has more than 1,024 items. SPAWN D on dream can only list the first 1,024, so only those are sent.",
  );
  expect(truncatedFolderNote(["a", "b/c"], "dream", "download")).toBe(
    "2 folders have more than 1,024 items. SPAWN D on dream can only list the first 1,024 in each, so only those are downloaded.",
  );
  expect(PREPARING_NOTICE).toBe("Preparing…");
  expect(preparingNotice(39.6)).toBe("Preparing… 40%");
  expect(tooManyItemsNotice("photos", 10_000)).toBe(
    "“photos” holds more than 10,000 items. Pick a smaller folder.",
  );
  expect(countingNotice("dream", 0)).toBe("Counting items on dream…");
  expect(countingNotice("dream", 1234)).toBe("Counting items on dream… 1,234 so far");
});

test("transfer errors are said per side, the phone's words, and unknown codes fall through", () => {
  const where = { host: "dream", name: "a.bin", folder: "Documents" };
  expect(transferErrorCopy("permission_denied", { ...where, side: "read" })).toBe(
    "SPAWN D on dream isn't allowed to read “a.bin”.",
  );
  expect(transferErrorCopy("permission_denied", { ...where, side: "write" })).toBe(
    "SPAWN D on dream isn't allowed to write to Documents.",
  );
  expect(transferErrorCopy("not_found", { ...where, side: "write" })).toBe(
    "Documents is no longer there on dream.",
  );
  expect(transferErrorCopy("not_found", { ...where, side: "read" })).toBe(
    "“a.bin” is no longer there on dream.",
  );
  expect(transferErrorCopy("already_exists", { ...where, side: "write" })).toBe(
    "“a.bin” already exists in Documents on dream.",
  );
  expect(transferErrorCopy("file_too_large", { ...where, side: "read" })).toBe(
    "“a.bin” is larger than 512 MB, the most SPAWN D can move in one file.",
  );
  expect(transferErrorCopy("file_changed", { ...where, side: "read" })).toBe(
    "“a.bin” changed while it was being copied. Try again.",
  );
  expect(transferErrorCopy("integrity_mismatch", { ...where, side: "write" })).toBe(
    "“a.bin” didn't arrive intact on dream, so it wasn't kept. Try again.",
  );
  expect(transferErrorCopy("length_mismatch", { ...where, side: "read" })).toBe(
    "“a.bin” didn't arrive intact from dream, so it wasn't kept. Try again.",
  );
  expect(transferErrorCopy("outcome_unknown", { ...where, side: "write" })).toBe(
    "SPAWN D lost touch with dream before it answered, so “a.bin” may or may not have arrived. Check the folder before trying again.",
  );
  expect(transferErrorCopy("unsupported_operation", { ...where, side: "read" })).toBe(
    "SPAWN D on dream can't send files.",
  );
  expect(transferErrorCopy("unsupported_operation", { ...where, side: "write" })).toBe(
    "SPAWN D on dream can't receive files.",
  );
  expect(transferErrorCopy("local_unreadable", { ...where, side: "local" })).toBe(
    "“a.bin” couldn't be read on this device. Pick it again to upload it.",
  );
  expect(transferErrorCopy("io_error", { ...where, side: "write" })).toBe(
    "dream couldn't write “a.bin”.",
  );
  expect(transferErrorCopy("weird", { ...where, side: "read" })).toBeNull();
});

test("the send flow's steps say the phone's words", () => {
  expect(SEND_NO_OTHER_HOST).toBe("There's no other host to send to. Add one from Hosts.");
  expect(SEND_HOST_OFFLINE).toBe("Offline");
  expect(sendFolderTitle("mac-mini")).toBe("Where on mac-mini?");
  expect(sendDestinationLine("Documents", "mac-mini")).toBe("Into Documents on mac-mini");
});

test("the tray's line puts what needs the person first", () => {
  expect(transfersSummary({ waiting: 1, active: 3, percent: 40 })).toBe("1 transfer needs you");
  expect(transfersSummary({ waiting: 2, active: 3, percent: 40 })).toBe("2 transfers need you");
  expect(transfersSummary({ waiting: 0, active: 2, percent: 45 })).toBe("2 transfers · 45%");
  expect(transfersSummary({ waiting: 0, active: 1, percent: null })).toBe("1 transfer");
  expect(transfersSummary({ waiting: 0, active: 0, percent: null })).toBe("Transfers done");
});
