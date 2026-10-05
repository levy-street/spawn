import { describe, expect, test } from "bun:test";
import { parseHead, readGitHead, sameHead } from "./git-head";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function reader(files: Record<string, string>) {
  return async (path: string) => files[path] ?? null;
}

describe("git-head", () => {
  test("parses a branch ref and a detached commit, and nothing else", () => {
    expect(parseHead("ref: refs/heads/main\n")).toEqual({ ref: "refs/heads/main" });
    expect(parseHead(`${SHA}\n`)).toEqual({ commit: SHA });
    expect(parseHead("garbage")).toBeNull();
  });

  test("a branch's commit from its loose ref, then from packed-refs", async () => {
    expect(
      await readGitHead(
        reader({
          "/r/.git/HEAD": "ref: refs/heads/feat/x\n",
          "/r/.git/refs/heads/feat/x": `${SHA}\n`,
        }),
        "/r",
      ),
    ).toEqual({ branch: "feat/x", commit: "1a2b3c4" });
    expect(
      await readGitHead(
        reader({
          "/r/.git/HEAD": "ref: refs/heads/main\n",
          "/r/.git/packed-refs": `${SHA} refs/heads/main\n`,
        }),
        "/r",
      ),
    ).toEqual({ branch: "main", commit: "1a2b3c4" });
  });

  test("a detached head, an unborn branch, and no repository", async () => {
    expect(await readGitHead(reader({ "/r/.git/HEAD": `${SHA}\n` }), "/r")).toEqual({
      branch: null,
      commit: "1a2b3c4",
    });
    expect(await readGitHead(reader({ "/r/.git/HEAD": "ref: refs/heads/main\n" }), "/r")).toEqual({
      branch: "main",
      commit: null,
    });
    expect(await readGitHead(reader({}), "/r")).toBeNull();
  });

  test("a linked worktree is followed to its git dir and the common refs", async () => {
    expect(
      await readGitHead(
        reader({
          "~/w/.git": "gitdir: ../main/.git/worktrees/w\n",
          "~/main/.git/worktrees/w/HEAD": "ref: refs/heads/topic\n",
          "~/main/.git/worktrees/w/commondir": "../..\n",
          "~/main/.git/refs/heads/topic": `${SHA}\n`,
        }),
        "~/w",
      ),
    ).toEqual({ branch: "topic", commit: "1a2b3c4" });
  });

  test("the same branch at the same commit is the same head", () => {
    expect(sameHead({ branch: "a", commit: "1" }, { branch: "a", commit: "1" })).toBe(true);
    expect(sameHead({ branch: "a", commit: "1" }, { branch: "b", commit: "1" })).toBe(false);
    expect(sameHead({ branch: "a", commit: null }, { branch: "a", commit: null })).toBe(false);
  });
});
