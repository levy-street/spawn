import {
  compareFolders,
  defaultPermissionMode,
  estimateCarrySeconds,
  findPackedRef,
  formatCarryDuration,
  formatCarryProgress,
  joinHostPath,
  NO_PUT_BACK_FACTS,
  olderVersion,
  PERMISSION_MODE_CHOICES,
  PERMISSION_MODES,
  parseGitDirPointer,
  parseGitHead,
  parseLooseRef,
  putBackLine,
} from "@/data/selectors/move-facts";

describe("how long a carry takes", () => {
  it("one model with the browser's: a window per round trip, the slower leg, three fixed seconds", () => {
    // 0.9 MB/s through the relay at 55 ms (S4).
    expect(estimateCarrySeconds(9_000_000, [{ kind: "relay", rttMs: 55 }, null])).toBeCloseTo(
      3 + 9_000_000 / ((0.76 * 65_536) / 0.055),
      3,
    );
    // Direct and close: the phone's own ceiling, the one difference allowed.
    expect(
      estimateCarrySeconds(4_000_000, [
        { kind: "direct", rttMs: 2 },
        { kind: "direct", rttMs: 3 },
      ]),
    ).toBeCloseTo(4, 3);
    // A far direct leg is held to its window a round trip.
    expect(estimateCarrySeconds(65_536 * 10, [{ kind: "direct", rttMs: 200 }])).toBeCloseTo(
      3 + (65_536 * 10) / ((0.76 * 65_536) / 0.2),
      3,
    );
  });

  it("reads as a person says it, hours included", () => {
    expect(formatCarryDuration(18)).toBe("20 seconds");
    expect(formatCarryDuration(44)).toBe("45 seconds");
    expect(formatCarryDuration(70)).toBe("a minute");
    expect(formatCarryDuration(250)).toBe("4 minutes");
    expect(formatCarryDuration(3_400)).toBe("an hour");
    expect(formatCarryDuration(9_000)).toBe("3 hours");
  });
});

describe("sizes", () => {
  it("names a progress in the total's unit, said once, as the browser writes it", () => {
    const MB = 1024 * 1024;
    expect(formatCarryProgress(3.1 * MB, 12.4 * MB)).toEqual({ done: "3.1", total: "12.4 MB" });
    expect(formatCarryProgress(16 * 1024, 40 * 1024)).toEqual({ done: "16", total: "40 KB" });
    expect(formatCarryProgress(10, 600)).toEqual({ done: "10", total: "600 B" });
    expect(formatCarryProgress(900, 600)).toEqual({ done: "600", total: "600 B" });
    expect(formatCarryProgress(2 * 1024 ** 3, 3 * 1024 ** 3)).toEqual({
      done: "2.0",
      total: "3.0 GB",
    });
    // Never more done than there is.
    expect(formatCarryProgress(20 * MB, 12.4 * MB)).toEqual({ done: "12.4", total: "12.4 MB" });
  });
});

describe("git, read and never run", () => {
  it("reads HEAD, a gitdir pointer, loose and packed refs", () => {
    expect(parseGitHead("ref: refs/heads/feat-x\n")).toEqual({ kind: "branch", branch: "feat-x" });
    expect(parseGitHead(`${"c".repeat(40)}\n`)).toEqual({
      kind: "detached",
      commit: "c".repeat(40),
    });
    expect(parseGitHead("garbage")).toBeNull();
    expect(parseGitDirPointer("gitdir: ../.git/worktrees/x\n")).toBe("../.git/worktrees/x");
    expect(parseLooseRef(`${"d".repeat(40)}\n`)).toBe("d".repeat(40));
    expect(parseLooseRef("nope")).toBeNull();
    expect(
      findPackedRef(
        `# pack\n${"e".repeat(40)} refs/heads/main\n^${"f".repeat(40)}\n`,
        "refs/heads/main",
      ),
    ).toBe("e".repeat(40));
  });

  it("joins host paths without leaving them", () => {
    expect(joinHostPath("~/code/spawn", ".git")).toBe("~/code/spawn/.git");
    expect(joinHostPath("/repo/wt", "../main/.git")).toBe("/repo/main/.git");
    expect(joinHostPath("/repo/wt", "/abs/.git")).toBe("/abs/.git");
  });

  it("compares two folders' commits", () => {
    const main = { branch: "main", commit: "a".repeat(40) };
    expect(compareFolders(main, main)).toEqual({ kind: "same", branch: "main", commit: "aaaaaaa" });
    const detached = { branch: null, commit: "c".repeat(40) };
    expect(compareFolders(detached, detached)).toEqual({
      kind: "same",
      branch: null,
      commit: "ccccccc",
    });
    expect(compareFolders(main, { branch: "main", commit: "b".repeat(40) })).toEqual({
      kind: "different",
      from: { branch: "main", commit: "aaaaaaa" },
      to: { branch: "main", commit: "bbbbbbb" },
    });
    expect(compareFolders(main, { branch: "feat", commit: null })).toEqual({
      kind: "different",
      from: { branch: "main", commit: "aaaaaaa" },
      to: { branch: "feat", commit: null },
    });
    expect(compareFolders(main, null)).toBeNull();
  });
});

describe("versions and modes", () => {
  it("knows an older release", () => {
    expect(olderVersion("2.1.250", "2.1.288")).toBe(true);
    expect(olderVersion("2.1.288", "2.1.288")).toBe(false);
    expect(olderVersion("2.2.0", "2.1.288")).toBe(false);
    expect(olderVersion(null, "2.1.288")).toBe(false);
    expect(olderVersion("dev", "2.1.288")).toBe(false);
  });

  it("starts a yolo window bypassing where its agent can, otherwise in the target's own default", () => {
    const yolo = { yolo: true, yolo_args: "--dangerously-skip-permissions" };
    const plain = { yolo: false };
    expect(defaultPermissionMode(yolo, null)).toBe("bypassPermissions");
    // Yolo asked of an agent with no way to skip its prompts: not bypassing.
    expect(defaultPermissionMode({ yolo: true, yolo_args: null, yolo_env: {} }, null)).toBe(
      "default",
    );
    expect(defaultPermissionMode(plain, '{"permissions":{"defaultMode":"plan"}}')).toBe("plan");
    expect(defaultPermissionMode(plain, '{"permissions":{"defaultMode":"manual"}}')).toBe(
      "default",
    );
    expect(defaultPermissionMode(plain, '{"permissions":{"defaultMode":"sideways"}}')).toBe(
      "default",
    );
    expect(defaultPermissionMode(plain, "not json")).toBe("default");
    expect(defaultPermissionMode(plain, null)).toBe("default");
  });

  it("names every mode as Claude Code's own footer does, with what it does", () => {
    expect(PERMISSION_MODES.map((mode) => PERMISSION_MODE_CHOICES[mode].label)).toEqual([
      "manual mode",
      "accept edits",
      "plan mode",
      "auto mode",
      "don't ask",
      "bypass permissions",
    ]);
    expect(PERMISSION_MODE_CHOICES.bypassPermissions.description).toBe(
      "Never asks — what a yolo window runs in",
    );
  });
});

describe("the line a put-back types on the source", () => {
  const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
  const CLAUDE = { kind: "claude-code", command: "claude", env: {} };

  it("resumes the conversation that was moving, its mode said outright (the browser's line)", () => {
    expect(putBackLine(CLAUDE, CONVERSATION, NO_PUT_BACK_FACTS)).toBe(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
  });

  it("starts in the source's own default mode, never the record's", () => {
    const settings = JSON.stringify({ permissions: { defaultMode: "acceptEdits" } });
    expect(putBackLine(CLAUDE, CONVERSATION, { loginShell: "/bin/zsh", settings })).toBe(
      `claude --resume ${CONVERSATION} --permission-mode acceptEdits`,
    );
  });

  it("a yolo window keeps skipping its prompts, the flag giving way to the mode", () => {
    const yolo = { ...CLAUDE, yolo: true, yolo_args: "--dangerously-skip-permissions" };
    const line = putBackLine(yolo, CONVERSATION, NO_PUT_BACK_FACTS);
    expect(line).toBe(`claude --resume ${CONVERSATION} --permission-mode bypassPermissions`);
    expect(line).not.toContain("--dangerously-skip-permissions");
  });

  it("an agent with no mode flag gets no line: the ordinary restart", () => {
    expect(
      putBackLine({ kind: "codex", command: "codex", env: {} }, CONVERSATION, NO_PUT_BACK_FACTS),
    ).toBeNull();
  });
});
