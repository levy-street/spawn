import { describe, expect, test } from "bun:test";
import {
  type ChangeProbe,
  createFolderChecked,
  type HeldFolder,
  nameTaken,
  newFolderVerdict,
  renameChecked,
  renameVerdict,
} from "./change-check";
import { changeErrorCopy } from "./copy";

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * A host as SPAWN D's file service answers: every failure inside a rename or
 * mkdir comes back `outcome_unknown`, and mkdir is `mkdir -p`.
 */
function daemonHost(initial: Record<string, "folder" | "file">) {
  const disk = new Map(Object.entries(initial));
  const calls: string[] = [];
  const probe: ChangeProbe = {
    stat: async (path) => {
      calls.push(`stat ${path}`);
      const kind = disk.get(path);
      if (!kind) throw new CodedError("not_found");
      return { kind: kind === "folder" ? "directory" : "file" };
    },
    codeOf: (error) => (error instanceof CodedError ? error.code : null),
    refuse: (code) => new CodedError(code),
  };
  const mkdir = (path: string) => async () => {
    calls.push(`mkdir ${path}`);
    const there = disk.get(path);
    if (there === "folder") return path;
    if (there) throw new CodedError("outcome_unknown");
    disk.set(path, "folder");
    return path;
  };
  const rename = (from: string, to: string) => async () => {
    calls.push(`rename ${from}`);
    const kind = disk.get(from);
    if (!kind || disk.has(to)) throw new CodedError("outcome_unknown");
    disk.delete(from);
    disk.set(to, kind);
    return to;
  };
  return { disk, calls, probe, mkdir, rename };
}

const HOME = "/home/me";

function held(names: Record<string, "folder" | "file">, complete = true): HeldFolder {
  return {
    entries: Object.keys(names).map((name) => ({ name, path: `${HOME}/${name}` })),
    complete,
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof CodedError ? error.code : String(error);
  }
  return "resolved";
}

describe("telling a refusal from a change that may have happened", () => {
  test("a name is taken by another item, exactly as typed", () => {
    const folder = held({ level1: "folder", "notes.md": "file" });
    expect(nameTaken(folder.entries, "level1")).toBe(true);
    expect(nameTaken(folder.entries, "Level1")).toBe(false);
    // An item may keep its own name; it does not clash with itself.
    expect(nameTaken(folder.entries, "notes.md", `${HOME}/notes.md`)).toBe(false);
    expect(nameTaken(undefined, "anything")).toBe(false);
  });

  test("a rename is read from both names afterwards", () => {
    expect(renameVerdict("item", "item")).toBe("already_exists");
    expect(renameVerdict("folder", "folder")).toBe("already_exists");
    expect(renameVerdict("absent", "item")).toBe("done");
    expect(renameVerdict("item", "absent")).toBe("unchanged");
    expect(renameVerdict("absent", "absent")).toBe("not_found");
    expect(renameVerdict("unknown", "item")).toBe("outcome_unknown");
    expect(renameVerdict("item", "unknown")).toBe("outcome_unknown");
  });

  test("a new folder is read from its name afterwards", () => {
    expect(newFolderVerdict("folder")).toBe("done");
    expect(newFolderVerdict("item")).toBe("already_exists");
    expect(newFolderVerdict("absent")).toBe("unchanged");
    expect(newFolderVerdict("unknown")).toBe("outcome_unknown");
  });

  test("New folder named like a folder already there says so, and makes nothing", async () => {
    const host = daemonHost({ [`${HOME}/level1`]: "folder" });
    const path = `${HOME}/level1`;
    const code = await codeOf(
      createFolderChecked({
        path,
        name: "level1",
        held: held({ level1: "folder" }),
        mkdir: host.mkdir(path),
        probe: host.probe,
      }),
    );
    expect(code).toBe("already_exists");
    // The folder on screen answered: the host was not asked.
    expect(host.calls).toEqual([]);
    expect(changeErrorCopy(code, { host: "probe-a", name: "level1" })).toBe(
      "There's already an item named “level1” here.",
    );
  });

  test("a folder the browser cannot see whole is asked about the name first", async () => {
    // Past the host's 1,024: "level1" exists but was never listed, and
    // mkdir -p alone would answer it as made.
    const host = daemonHost({ [`${HOME}/level1`]: "folder" });
    const path = `${HOME}/level1`;
    const code = await codeOf(
      createFolderChecked({
        path,
        name: "level1",
        held: held({}, false),
        mkdir: host.mkdir(path),
        probe: host.probe,
      }),
    );
    expect(code).toBe("already_exists");
    expect(host.calls).toEqual([`stat ${path}`]);
  });

  test("New folder named like a file the listing missed: the host's 'unknown' is looked into", async () => {
    const host = daemonHost({ [`${HOME}/draft.txt`]: "file" });
    const path = `${HOME}/draft.txt`;
    const code = await codeOf(
      createFolderChecked({
        path,
        name: "draft.txt",
        held: held({}),
        mkdir: host.mkdir(path),
        probe: host.probe,
      }),
    );
    expect(code).toBe("already_exists");
    expect(host.calls).toEqual([`mkdir ${path}`, `stat ${path}`]);
  });

  test("a new name makes the folder, asking nothing else", async () => {
    const host = daemonHost({});
    const path = `${HOME}/build`;
    expect(
      await createFolderChecked({
        path,
        name: "build",
        held: held({ src: "folder" }),
        mkdir: host.mkdir(path),
        probe: host.probe,
      }),
    ).toBe(path);
    expect(host.calls).toEqual([`mkdir ${path}`]);
    expect(host.disk.get(path)).toBe("folder");
  });

  test("Rename onto a name in the folder on screen says so without asking the host", async () => {
    const host = daemonHost({ [`${HOME}/level1`]: "folder", [`${HOME}/a.txt`]: "file" });
    const code = await codeOf(
      renameChecked({
        from: `${HOME}/a.txt`,
        fromName: "a.txt",
        to: `${HOME}/level1`,
        name: "level1",
        held: held({ level1: "folder", "a.txt": "file" }),
        rename: host.rename(`${HOME}/a.txt`, `${HOME}/level1`),
        probe: host.probe,
      }),
    );
    expect(code).toBe("already_exists");
    expect(host.calls).toEqual([]);
  });

  test("Rename onto a name the listing missed: the host's 'unknown' becomes 'already exists'", async () => {
    const host = daemonHost({ [`${HOME}/level1`]: "folder", [`${HOME}/a.txt`]: "file" });
    const code = await codeOf(
      renameChecked({
        from: `${HOME}/a.txt`,
        fromName: "a.txt",
        to: `${HOME}/level1`,
        name: "level1",
        held: held({ "a.txt": "file" }),
        rename: host.rename(`${HOME}/a.txt`, `${HOME}/level1`),
        probe: host.probe,
      }),
    );
    expect(code).toBe("already_exists");
    expect(host.calls).toEqual([
      `rename ${HOME}/a.txt`,
      `stat ${HOME}/a.txt`,
      `stat ${HOME}/level1`,
    ]);
    // Nothing moved.
    expect(host.disk.get(`${HOME}/a.txt`)).toBe("file");
  });

  test("a rename that went through before the host lost its footing is a rename", async () => {
    const host = daemonHost({ [`${HOME}/b.txt`]: "file" });
    const to = await renameChecked({
      from: `${HOME}/a.txt`,
      fromName: "a.txt",
      to: `${HOME}/b.txt`,
      name: "b.txt",
      held: held({ "a.txt": "file" }),
      // The host moved it, then failed to sync the folder.
      rename: async () => {
        throw new CodedError("outcome_unknown");
      },
      probe: host.probe,
    });
    expect(to).toBe(`${HOME}/b.txt`);
  });

  test("lost touch stays only for what cannot be looked into", async () => {
    const host = daemonHost({ [`${HOME}/a.txt`]: "file", [`${HOME}/b.txt`]: "file" });
    const unanswered = new CodedError("outcome_unknown");
    const blind = { ...host.probe, stat: null };
    expect(
      await codeOf(
        renameChecked({
          from: `${HOME}/a.txt`,
          fromName: "a.txt",
          to: `${HOME}/b.txt`,
          name: "b.txt",
          held: held({ "a.txt": "file" }),
          rename: async () => {
            throw unanswered;
          },
          probe: blind,
        }),
      ),
    ).toBe("outcome_unknown");
    // The look itself went unanswered.
    const cut = {
      ...host.probe,
      stat: async () => {
        throw new CodedError("channel_closed");
      },
    };
    expect(
      await codeOf(
        createFolderChecked({
          path: `${HOME}/x`,
          name: "x",
          held: held({}),
          mkdir: async () => {
            throw unanswered;
          },
          probe: cut,
        }),
      ),
    ).toBe("outcome_unknown");
    // A rename between names a host may fold together answers to both
    // either way, so no look can settle it.
    expect(
      await codeOf(
        renameChecked({
          from: `${HOME}/a.txt`,
          fromName: "a.txt",
          to: `${HOME}/A.txt`,
          name: "A.txt",
          held: held({ "a.txt": "file" }),
          rename: async () => {
            throw unanswered;
          },
          probe: host.probe,
        }),
      ),
    ).toBe("outcome_unknown");
  });

  test("a change the host refused for a reason it gave keeps that reason", async () => {
    const host = daemonHost({});
    expect(
      await codeOf(
        createFolderChecked({
          path: `${HOME}/x`,
          name: "x",
          held: held({}),
          mkdir: async () => {
            throw new CodedError("invalid_name");
          },
          probe: host.probe,
        }),
      ),
    ).toBe("invalid_name");
    expect(host.calls).toEqual([]);
  });

  test("a look that shows nothing moved says that, not that touch was lost", async () => {
    const host = daemonHost({ [`${HOME}/a.txt`]: "file" });
    const code = await codeOf(
      renameChecked({
        from: `${HOME}/a.txt`,
        fromName: "a.txt",
        to: `${HOME}/b.txt`,
        name: "b.txt",
        held: held({ "a.txt": "file" }),
        // Refused without a reason, as a permission failure inside the effect is.
        rename: async () => {
          throw new CodedError("outcome_unknown");
        },
        probe: host.probe,
      }),
    );
    expect(code).toBe("unchanged");
    expect(changeErrorCopy(code, { host: "probe-a", name: "a.txt" })).toBe(
      "SPAWN D couldn't change this on probe-a.",
    );
  });
});
