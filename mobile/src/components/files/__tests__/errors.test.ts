import { fsError } from "@/components/files/__tests__/fixtures";
import {
  changeErrorCopy,
  fileErrorCode,
  fileErrorMessage,
  listErrorCopy,
} from "@/components/files/errors";

/**
 * The web file browser's words (web/src/lib/files/copy.ts): every sentence
 * about a host names it, and nothing a person reads is the transport's own.
 */
describe("file error copy", () => {
  test("a folder that will not open says why, naming the host", () => {
    expect(listErrorCopy("outside_root", "dream")).toBe(
      "SPAWN D only opens folders inside your home folder on dream.",
    );
    expect(listErrorCopy("traversal_rejected", "dream")).toBe(
      "SPAWN D only opens folders inside your home folder on dream.",
    );
    expect(listErrorCopy("not_found", "dream")).toBe("There's no folder at that path on dream.");
    expect(listErrorCopy("symlink_rejected", "dream")).toBe(
      "That path goes through a link SPAWN D doesn't follow.",
    );
    expect(listErrorCopy("not_directory", "dream")).toBe("That's a file on dream, not a folder.");
    expect(listErrorCopy("permission_denied", "dream")).toBe(
      "SPAWN D on dream isn't allowed to open that folder.",
    );
    expect(listErrorCopy("something_else", "dream")).toBeNull();
  });

  test("a change that did not happen names the item and the host", () => {
    const subject = { host: "dream", name: "notes.md" };
    expect(changeErrorCopy("already_exists", subject)).toBe(
      "There's already an item named “notes.md” here.",
    );
    expect(changeErrorCopy("invalid_name", subject)).toBe(
      "“notes.md” can't be used as a name on dream.",
    );
    expect(changeErrorCopy("permission_denied", subject)).toBe(
      "SPAWN D on dream isn't allowed to change “notes.md”.",
    );
    expect(changeErrorCopy("not_found", subject)).toBe("“notes.md” is no longer there on dream.");
    expect(changeErrorCopy("root_protected", subject)).toBe(
      "Your home folder can't be renamed or deleted.",
    );
    expect(changeErrorCopy("outcome_unknown", subject)).toBe(
      "SPAWN D lost touch with dream before it answered, so this may or may not have happened. Check the folder before trying again.",
    );
  });

  test("the transport's 'reconcile before retrying' never reaches a person", () => {
    const unanswered = Object.assign(
      new Error("The host mutation may have completed; reconcile before retrying."),
      { code: "outcome_unknown" },
    );
    for (const context of ["write", "rename", "remove"] as const) {
      const message = fileErrorMessage(unanswered, context, { host: "dream", name: "x" });
      expect(message).toMatch(/^SPAWN D lost touch with dream/u);
    }
  });

  test("reads the code from the error, or from its message", () => {
    expect(fileErrorCode(fsError("not_found"))).toBe("not_found");
    expect(fileErrorCode(new Error("host said: permission_denied"))).toBe("permission_denied");
    expect(fileErrorCode("nope")).toBeNull();
    expect(fileErrorMessage(fsError("not_found"), "goto", { host: "dream" })).toBe(
      "There's no folder at that path on dream.",
    );
    expect(fileErrorMessage(new Error("Channel closed."), "list", { host: "dream" })).toBe(
      "Channel closed.",
    );
  });
});
