import {
  type ChangeProbe,
  createFolderChecked,
  type HeldFolder,
  nameTaken,
  newFolderVerdict,
  renameChecked,
  renameVerdict,
} from "@/components/files/change-check";
import { changeErrorCopy, fileErrorCode } from "@/components/files/errors";
import { fsError } from "./fixtures";

const HOME = "/home/me";

/** What a host's fs.stat answers, from a map of what is there. */
function probeOver(disk: Record<string, "folder" | "file">, calls: string[] = []): ChangeProbe {
  return {
    stat: async (path) => {
      calls.push(`stat ${path}`);
      const kind = disk[path];
      if (!kind) throw fsError("not_found");
      return { kind: kind === "folder" ? "directory" : "file" };
    },
    codeOf: fileErrorCode,
  };
}

function held(names: string[], complete = true): HeldFolder {
  return { entries: names.map((name) => ({ name, path: `${HOME}/${name}` })), complete };
}

async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return fileErrorCode(error) ?? String(error);
  }
}

const unknown = () => Promise.reject(fsError("outcome_unknown"));

/**
 * The web file browser's rules (web/src/lib/files/change-check.ts): what the
 * host cannot vouch for is looked into, and "lost touch" is kept for what a
 * look cannot settle.
 */
describe("telling a refusal from a change that may have happened", () => {
  test("verdicts read from the names afterwards", () => {
    expect(renameVerdict("item", "folder")).toBe("already_exists");
    expect(renameVerdict("absent", "item")).toBe("done");
    expect(renameVerdict("item", "absent")).toBe("unchanged");
    expect(renameVerdict("absent", "absent")).toBe("not_found");
    expect(renameVerdict("unknown", "item")).toBe("outcome_unknown");
    expect(newFolderVerdict("folder")).toBe("done");
    expect(newFolderVerdict("item")).toBe("already_exists");
    expect(newFolderVerdict("absent")).toBe("unchanged");
    expect(newFolderVerdict("unknown")).toBe("outcome_unknown");
  });

  test("a name is taken by another item, exactly as typed", () => {
    expect(nameTaken(held(["src"]).entries, "src")).toBe(true);
    expect(nameTaken(held(["src"]).entries, "Src")).toBe(false);
    expect(nameTaken(held(["a.txt"]).entries, "a.txt", `${HOME}/a.txt`)).toBe(false);
  });

  test("New folder over a folder or a file is 'already exists', asked or not", async () => {
    const calls: string[] = [];
    const probe = probeOver({ [`${HOME}/src`]: "folder", [`${HOME}/a.txt`]: "file" }, calls);
    const mkdir = jest.fn(async () => `${HOME}/src`);
    // The folder on screen shows it: nothing is asked.
    expect(
      await outcome(
        createFolderChecked({
          path: `${HOME}/src`,
          name: "src",
          held: held(["src"]),
          mkdir,
          probe,
        }),
      ),
    ).toBe("already_exists");
    expect(mkdir).not.toHaveBeenCalled();
    // A folder cut short at the host's cap: the name is asked about first.
    expect(
      await outcome(
        createFolderChecked({
          path: `${HOME}/src`,
          name: "src",
          held: held([], false),
          mkdir,
          probe,
        }),
      ),
    ).toBe("already_exists");
    expect(mkdir).not.toHaveBeenCalled();
    // A file the listing missed: the host's "unknown" is looked into.
    expect(
      await outcome(
        createFolderChecked({
          path: `${HOME}/a.txt`,
          name: "a.txt",
          held: held([]),
          mkdir: unknown,
          probe,
        }),
      ),
    ).toBe("already_exists");
    expect(calls).toEqual([`stat ${HOME}/src`, `stat ${HOME}/a.txt`]);
    expect(changeErrorCopy("already_exists", { host: "dream", name: "a.txt" })).toBe(
      "There's already an item named “a.txt” here.",
    );
  });

  test("a rename onto a name already there is 'already exists'", async () => {
    const probe = probeOver({ [`${HOME}/a.txt`]: "file", [`${HOME}/b.txt`]: "file" });
    const rename = jest.fn(unknown);
    const ask = (list: string[]) =>
      outcome(
        renameChecked({
          from: `${HOME}/a.txt`,
          fromName: "a.txt",
          to: `${HOME}/b.txt`,
          name: "b.txt",
          held: held(list),
          rename,
          probe,
        }),
      );
    expect(await ask(["a.txt", "b.txt"])).toBe("already_exists");
    expect(rename).not.toHaveBeenCalled();
    expect(await ask(["a.txt"])).toBe("already_exists");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  test("lost touch stays for what no look can settle, and only that", async () => {
    const there = probeOver({ [`${HOME}/a.txt`]: "file", [`${HOME}/A.txt`]: "file" });
    const rename = (to: string, name: string, probe: ChangeProbe) =>
      outcome(
        renameChecked({
          from: `${HOME}/a.txt`,
          fromName: "a.txt",
          to,
          name,
          held: held(["a.txt"]),
          rename: unknown,
          probe,
        }),
      );
    // A host that cannot be asked.
    expect(await rename(`${HOME}/b.txt`, "b.txt", { ...there, stat: null })).toBe(
      "outcome_unknown",
    );
    // Names a host may fold together answer to both either way.
    expect(await rename(`${HOME}/A.txt`, "A.txt", there)).toBe("outcome_unknown");
    // A look that shows nothing moved says that instead.
    expect(await rename(`${HOME}/b.txt`, "b.txt", there)).toBe("unchanged");
    expect(changeErrorCopy("unchanged", { host: "dream", name: "a.txt" })).toBe(
      "SPAWN D couldn't change this on dream.",
    );
  });
});
