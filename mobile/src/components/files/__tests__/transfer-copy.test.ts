import {
  CONFLICT_POLICY_COPY,
  CONFLICT_POLICY_LABEL,
  conflictDecisionLabel,
  conflictQuestion,
  countingNotice,
  formatDuration,
  interruptedNotice,
  linksSkipped,
  OPEN_TERMINAL_HERE,
  proceedAnywayLabel,
  queuedNotice,
  relayWarning,
  SEND_TO_ANOTHER_HOST,
  START_AGENT_HERE,
  sendButtonLabel,
  sendDestinationLine,
  specialSkipped,
  tooLargeFile,
  tooManyItems,
  transferDoneSummary,
  transferErrorCopy,
  transferFailedSummary,
  transferProgress,
  transfersBannerLabel,
  transferTitle,
  truncatedSendNotice,
} from "@/components/files/transfer-copy";

const summary = { active: 0, percent: null, paused: false, needsYou: 0 };

/**
 * The sentences both frontends say. Each is the one the review settled for
 * web and phone alike (web/src/lib/files/copy.ts says the same words).
 */
describe("transfer copy", () => {
  test("open here is worded as on the web, in the file browser and on the host page", () => {
    expect(OPEN_TERMINAL_HERE).toBe("Open terminal here");
    expect(START_AGENT_HERE).toBe("Start agent here…");
    expect(SEND_TO_ANOTHER_HOST).toBe("Send to another host…");
  });

  test("the relay warning names who cannot reach whom, how much, and about how long", () => {
    expect(relayWarning(["dream"], 1.2 * 1024 * 1024 * 1024)).toBe(
      "This transfer goes through the SPAWN D relay because dream and this device can't reach each other directly. 1.2 GB may take a while.",
    );
    expect(relayWarning(["dream", "mac-mini"], 150 * 1024 * 1024, 1_200)).toBe(
      "This transfer goes through the SPAWN D relay because this device can't reach dream or mac-mini directly. 150 MB may take a while. It will take about 20 minutes.",
    );
    expect(proceedAnywayLabel("upload")).toBe("Upload anyway");
    expect(proceedAnywayLabel("send")).toBe("Send anyway");
    expect(proceedAnywayLabel("download")).toBe("Download anyway");
  });

  test("a duration is spelled out", () => {
    expect(formatDuration(17)).toBe("about 15 seconds");
    expect(formatDuration(2)).toBe("about 5 seconds");
    expect(formatDuration(150)).toBe("about 3 minutes");
    expect(formatDuration(2 * 3_600 + 5 * 60)).toBe("about 2 hours");
  });

  test("the send names one item, or counts several, and says where it lands", () => {
    expect(sendButtonLabel(["notes.md"], "mac-mini")).toBe("Send “notes.md” to mac-mini");
    expect(sendButtonLabel(["a", "b", "c"], "mac-mini")).toBe("Send 3 items to mac-mini");
    expect(sendDestinationLine("Home", "mac-mini")).toBe("Into Home on mac-mini");
  });

  test("the four answers to a taken name, worded as on the web", () => {
    expect(CONFLICT_POLICY_LABEL).toBe("If an item is already there");
    expect(Object.values(CONFLICT_POLICY_COPY)).toEqual([
      { label: "Ask each time", detail: "Nothing already there changes without your say" },
      { label: "Keep both", detail: "What you send gets a new name, like “notes (2).md”" },
      { label: "Replace", detail: "Files with the same name are replaced, and folders merged" },
      { label: "Skip", detail: "Anything already there is left as it is" },
    ]);
  });

  test("a taken name says where and on which host; a folder's says it is a folder, and merges", () => {
    expect(
      conflictQuestion({
        name: "notes.md",
        isDir: false,
        folderLabel: "Documents",
        hostName: "mac-mini",
      }),
    ).toBe("“notes.md” already exists in Documents on mac-mini.");
    expect(
      conflictQuestion({
        name: "photos",
        isDir: true,
        folderLabel: "Documents",
        hostName: "mac-mini",
      }),
    ).toBe("A folder named “photos” already exists in Documents on mac-mini.");
    expect(conflictDecisionLabel("replace", true)).toBe("Merge");
    expect(conflictDecisionLabel("replace", false)).toBe("Replace");
    expect(conflictDecisionLabel("keep_both", true)).toBe("Keep both");
  });

  test("the banner counts transfers: what needs the person first, then how far, then done", () => {
    expect(transfersBannerLabel({ ...summary, active: 2, percent: 45 })).toBe("2 transfers · 45%");
    expect(transfersBannerLabel({ ...summary, active: 1, percent: null })).toBe("1 transfer");
    expect(transfersBannerLabel({ ...summary, active: 2, needsYou: 1, percent: 10 })).toBe(
      "1 transfer needs you",
    );
    expect(transfersBannerLabel({ ...summary, needsYou: 2 })).toBe("2 transfers need you");
    expect(transfersBannerLabel({ ...summary, paused: true, active: 3, needsYou: 1 })).toBe(
      "Transfers paused",
    );
    expect(transfersBannerLabel(summary)).toBe("Transfers done");
  });

  test("a transfer is titled by what it does, where, and in the past tense once done", () => {
    expect(
      transferTitle({
        verb: "upload",
        names: ["a.txt"],
        folderLabel: "Documents",
        to: "dream",
        finished: false,
      }),
    ).toBe("Uploading “a.txt” to Documents on dream");
    expect(
      transferTitle({
        verb: "send",
        names: ["a", "b", "c"],
        from: "dream",
        folderLabel: "Documents",
        to: "mac-mini",
        finished: true,
      }),
    ).toBe("Sent 3 items from dream to Documents on mac-mini");
  });

  test("progress counts bytes and items over the whole transfer, with the time left", () => {
    expect(
      transferProgress({
        doneBytes: 12 * 1024 * 1024,
        totalBytes: 1.2 * 1024 * 1024 * 1024,
        doneItems: 3,
        totalItems: 12,
        secondsLeft: 180,
      }),
    ).toBe("12 MB of 1.2 GB · 3 of 12 items · about 3 minutes left");
    expect(
      transferProgress({
        doneBytes: 0,
        totalBytes: 10,
        doneItems: 0,
        totalItems: 1,
        secondsLeft: null,
      }),
    ).toBe("0 B of 10 B");
    expect(transferDoneSummary({ items: 12, bytes: 1.2 * 1024 * 1024 * 1024, skipped: 2 })).toBe(
      "12 items · 1.2 GB · 2 skipped",
    );
    expect(transferFailedSummary(3, "send")).toBe("3 items couldn't be sent.");
    expect(transferFailedSummary(1, "upload")).toBe("1 item couldn't be uploaded.");
  });

  test("waiting, counting and interruption are said as on the web", () => {
    expect(queuedNotice("dream")).toBe("Waiting for another transfer with dream to finish");
    expect(countingNotice("dream", 1234)).toBe("Counting items on dream… 1,234 so far");
    expect(countingNotice("dream", 0)).toBe("Counting items on dream…");
    expect(interruptedNotice({ cause: "lost-touch", host: "dream" })).toBe(
      "Interrupted because SPAWN D lost touch with dream.",
    );
    expect(interruptedNotice({ cause: "background" })).toBe(
      "Stopped when SPAWN D went to the background",
    );
  });

  test("what is left out is said in the past tense, and the limits name what was picked", () => {
    expect(linksSkipped(1)).toBe("1 link was skipped.");
    expect(linksSkipped(2)).toBe("2 links were skipped.");
    expect(specialSkipped(1)).toBe("1 item that isn't a file or folder was skipped.");
    expect(specialSkipped(3)).toBe("3 items that aren't files or folders were skipped.");
    expect(tooManyItems("photos", 10_000)).toBe(
      "“photos” holds more than 10,000 items. Pick a smaller folder.",
    );
    expect(tooLargeFile("disk.img")).toBe(
      "“disk.img” is larger than 512 MB, the most SPAWN D can move in one file.",
    );
  });

  test("a folder the source lists in part is named before anything is sent", () => {
    expect(truncatedSendNotice(["node_modules"], "dream")).toBe(
      "“node_modules” has more than 1,024 items. SPAWN D on dream can only list the first 1,024, so only those are sent.",
    );
  });

  test("a refusal names the host that refused", () => {
    const subject = { name: "notes.md", hostName: "dream", folderLabel: "Inbox" };
    const source = { ...subject, side: "source" as const };
    const destination = { ...subject, side: "destination" as const };
    expect(transferErrorCopy("permission_denied", source)).toBe(
      "SPAWN D on dream isn't allowed to read “notes.md”.",
    );
    expect(transferErrorCopy("permission_denied", destination)).toBe(
      "SPAWN D on dream isn't allowed to write to Inbox.",
    );
    expect(transferErrorCopy("not_found", destination)).toBe("Inbox is no longer there on dream.");
    expect(transferErrorCopy("already_exists", destination)).toBe(
      "“notes.md” already exists in Inbox on dream.",
    );
    expect(transferErrorCopy("outcome_unknown", destination)).toBe(
      "SPAWN D lost touch with dream before it answered, so “notes.md” may or may not have arrived. Check the folder before trying again.",
    );
    expect(transferErrorCopy("file_changed", source)).toBe(
      "“notes.md” changed while it was being copied. Try again.",
    );
    expect(transferErrorCopy("integrity_mismatch", destination)).toBe(
      "“notes.md” didn't arrive intact on dream, so it wasn't kept. Try again.",
    );
    expect(transferErrorCopy("io_error", destination)).toBe("dream couldn't write “notes.md”.");
    expect(transferErrorCopy("io_error", source)).toBe("dream couldn't read “notes.md”.");
    expect(transferErrorCopy("local_missing", destination)).toBe(
      "“notes.md” couldn't be read on this device. Pick it again to upload it.",
    );
    expect(transferErrorCopy("something_new", source)).toBeNull();
  });
});
