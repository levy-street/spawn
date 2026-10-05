import { describe, expect, test } from "bun:test";
import type { ConversationInspection } from "@/lib/conversation";
import type { ConversationProbe } from "./conv";
import { gatherMoveFacts, type MoveFacts, moveDialogModel } from "./preflight";

const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function probe(overrides: Partial<ConversationProbe> = {}): ConversationProbe {
  return {
    home: "/Users/me",
    cwd: "/Users/me/code/spawn",
    folderExists: true,
    storeReady: true,
    storeProblem: null,
    store: "/Users/me/.claude",
    memory: "~/.claude/projects/-Users-me-code-spawn/memory",
    duplicates: [],
    live: false,
    loginShell: "/bin/zsh",
    cliPath: "/Users/me/.local/bin/claude",
    cliVersion: "2.1.289",
    ...overrides,
  };
}

function inspection(overrides: Partial<ConversationInspection> = {}): ConversationInspection {
  return {
    agent: "claude-code",
    conversation_id: CONVERSATION,
    state: "running",
    cli_version: "2.1.289",
    live_elsewhere: false,
    source: "registry",
    ...overrides,
  };
}

function facts(overrides: Partial<MoveFacts> = {}): MoveFacts {
  return {
    inspection: inspection(),
    conversationId: CONVERSATION,
    switched: false,
    unconfirmed: false,
    settings: null,
    state: "running",
    bytes: 13_002_342,
    tooLarge: false,
    probe: probe(),
    sourceHead: { branch: "main", commit: "1a2b3c4" },
    targetHead: { branch: "main", commit: "1a2b3c4" },
    seconds: 4,
    ...overrides,
  };
}

const NAMES = { source: "dream", target: "mac", cwd: "~/code/spawn" };

describe("moveDialogModel", () => {
  test("a clean move says what moves, what doesn't, and what Claude will do", () => {
    const model = moveDialogModel(facts(), NAMES);
    expect(model.title).toBe("Move Claude Code to mac?");
    expect(model.body).toBe(
      "Claude Code stops on dream and continues this conversation on mac, in ~/code/spawn. The conversation comes with it (12 MB); the files it was working on don't, so ~/code/spawn on mac needs your latest work.",
    );
    expect(model.stateLine).toBe(
      "Claude Code is working right now. On mac it will be told about the move and carry on.",
    );
    expect(model.folderLine).toBe("Both are on main at 1a2b3c4.");
    expect(model.warnings).toEqual([]);
    expect(model.blocks).toEqual([]);
  });

  test("blocked and idle agents each get their own line", () => {
    expect(moveDialogModel(facts({ state: "blocked" }), NAMES).stateLine).toBe(
      "Claude Code is waiting for an answer. On mac it will be told about the move and ask again.",
    );
    expect(moveDialogModel(facts({ state: "idle" }), NAMES).stateLine).toBe(
      "On mac, your next message will start with a note about the move.",
    );
  });

  test("folders on different commits, a long carry and an older Claude Code are warnings", () => {
    const model = moveDialogModel(
      facts({
        targetHead: { branch: "feat-x", commit: "9f8e7d6" },
        seconds: 240,
        inspection: inspection({ cli_version: "2.1.289" }),
        probe: probe({ cliVersion: "2.1.250" }),
      }),
      NAMES,
    );
    expect(model.folderLine).toBeNull();
    expect(model.warnings).toEqual([
      "dream is on main at 1a2b3c4; mac is on feat-x at 9f8e7d6.",
      "This will take about 4 minutes. Keep SPAWN D open until it finishes.",
      "Claude Code on mac (2.1.250) is older than on dream (2.1.289).",
    ]);
    expect(model.blocks).toEqual([]);
  });

  test("a short carry says nothing about time", () => {
    expect(moveDialogModel(facts({ seconds: 14 }), NAMES).warnings).toEqual([]);
  });

  test("everything that stops a carried move is a block", () => {
    const model = moveDialogModel(
      facts({
        inspection: inspection({ live_elsewhere: true }),
        probe: probe({ live: true, storeReady: false, folderExists: false }),
        tooLarge: true,
      }),
      NAMES,
    );
    expect(model.blocks).toEqual([
      "This conversation is also open in another window or in the background on dream. Close it there first.",
      "This conversation is open in Claude Code on mac. Close it there first.",
      "Claude Code hasn't been set up on mac yet. Run claude there once and sign in, then move.",
      "~/code/spawn doesn't exist on mac. Create it there, or start fresh — a new conversation creates the folder.",
      "This conversation has a file over 512 MB, more than a move can carry.",
    ]);
  });

  test("no conversation to name, or a target that could not be checked, blocks", () => {
    expect(moveDialogModel(facts({ conversationId: null }), NAMES).blocks).toContain(
      "SPAWN D couldn't tell which conversation this window is in, so it can't come along.",
    );
    expect(moveDialogModel(facts({ probe: null }), NAMES).blocks).toEqual([
      "SPAWN D couldn't check mac. Try again in a moment.",
    ]);
  });

  test("an older copy on the target is noted, and Claude Code missing there is a warning", () => {
    const model = moveDialogModel(
      facts({
        probe: probe({
          cliPath: null,
          cliVersion: null,
          duplicates: [{ folder: "x", path: "y", size: 1, live: false }],
        }),
      }),
      NAMES,
    );
    expect(model.notes).toEqual(["An older copy of this conversation on mac will be set aside."]);
    expect(model.warnings).toEqual(["SPAWN D couldn't find Claude Code on mac."]);
    expect(model.blocks).toEqual([]);
  });

  test("Claude Code found there with no version to read is not missing, and is not compared", () => {
    // The source's Claude is newer than anything: only a version could be older.
    const newerSource = (cliVersion: string | null) =>
      moveDialogModel(
        facts({
          inspection: inspection({ cli_version: "9.9.999" }),
          probe: probe({ cliPath: "/opt/spawn/claude", cliVersion }),
        }),
        NAMES,
      );
    const model = newerSource(null);
    expect(model.warnings).toEqual([]);
    expect(model.blocks).toEqual([]);
    const words = [model.title, model.body, model.stateLine, model.folderLine, ...model.notes];
    expect(words.join(" ")).not.toContain("/opt/spawn/claude");
    // Found with a version: compared as before.
    expect(newerSource("2.1.289").warnings).toEqual([
      "Claude Code on mac (2.1.289) is older than on dream (9.9.999).",
    ]);
  });

  test("a window that switched conversations says which one goes; one the host cannot name warns", () => {
    expect(moveDialogModel(facts({ switched: true }), NAMES).notes).toEqual([
      "This window had switched conversations; SPAWN D will move the one it's in now.",
    ]);
    expect(moveDialogModel(facts({ unconfirmed: true }), NAMES).warnings).toEqual([
      "SPAWN D couldn't confirm which conversation this window is in now. It will bring back the one it started with.",
    ]);
  });

  test("a repository here and none there says so", () => {
    expect(moveDialogModel(facts({ targetHead: null }), NAMES).warnings).toEqual([
      "~/code/spawn on mac isn't a git repository, so SPAWN D can't compare it with the one here.",
    ]);
  });
});

describe("gatherMoveFacts", () => {
  test("a host that answers for Claude Code but cannot name its conversation: the recorded one goes, with a warning", async () => {
    const result = await gatherMoveFacts({
      sessionId: "s",
      recordedConversationId: CONVERSATION,
      sourceCwd: "/nowhere",
      targetCwd: "/nowhere",
      source: {
        inspect: async () => inspection({ conversation_id: null }),
        transcripts: async () => ({
          agent_kind: "claude-code",
          supported: false,
          transcripts: [],
          searched: [],
          truncated: false,
        }),
        readText: async () => null,
      },
      target: { probe: async () => probe({ store: null }), readText: async () => null },
      legs: [],
    });
    expect(result.conversationId).toBe(CONVERSATION);
    expect(result.unconfirmed).toBe(true);
    expect(result.settings).toBeNull();
  });

  const files: Record<string, string> = {
    "/home/me/code/spawn/.git/HEAD": "ref: refs/heads/main\n",
    "/home/me/code/spawn/.git/refs/heads/main": `${SHA}\n`,
    "/Users/me/code/spawn/.git": "gitdir: /Users/me/code/main/.git/worktrees/spawn\n",
    "/Users/me/code/main/.git/worktrees/spawn/HEAD": `ref: refs/heads/main\n`,
    "/Users/me/code/main/.git/worktrees/spawn/commondir": "../..\n",
    "/Users/me/code/main/.git/packed-refs": `# pack-refs\n${SHA} refs/heads/main\n`,
    "/Users/me/.claude/settings.json": '{"permissions":{"defaultMode":"plan"}}',
  };
  const readText = async (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error("not found");
    return text;
  };

  test("the conversation the window is in now, its size, both heads and the estimate", async () => {
    const result = await gatherMoveFacts({
      sessionId: "s",
      recordedConversationId: "00000000-0000-4000-8000-000000000000",
      sourceCwd: "/home/me/code/spawn",
      targetCwd: "/Users/me/code/spawn",
      source: {
        inspect: async () => inspection({ state: "blocked" }),
        transcripts: async () => ({
          agent_kind: "claude-code",
          supported: true,
          transcripts: [
            {
              path: "a",
              name: "a",
              size: 1_000_000,
              role: "conversation",
              conversation_id: CONVERSATION,
            },
            { path: "b", name: "b", size: 500_000, role: "subagent", conversation_id: null },
          ],
          searched: [],
          truncated: false,
        }),
        readText,
      },
      target: { probe: async () => probe(), readText },
      legs: [
        { kind: "relay", rttMs: 55 },
        { kind: "direct", rttMs: 5 },
      ],
    });
    expect(result.conversationId).toBe(CONVERSATION);
    // The window is in another conversation than it was opened with.
    expect(result.switched).toBe(true);
    expect(result.unconfirmed).toBe(false);
    // The target's own settings, for the mode the picker starts on.
    expect(result.settings).toBe('{"permissions":{"defaultMode":"plan"}}');
    expect(result.state).toBe("blocked");
    expect(result.bytes).toBe(1_500_000);
    expect(result.tooLarge).toBe(false);
    expect(result.sourceHead).toEqual({ branch: "main", commit: "1a2b3c4" });
    expect(result.targetHead).toEqual({ branch: "main", commit: "1a2b3c4" });
    expect(result.seconds).toBeGreaterThan(3);
    expect(result.seconds).toBeLessThan(6);
  });

  test("a stopped window falls back to the recorded conversation, its state unknown", async () => {
    const result = await gatherMoveFacts({
      sessionId: "s",
      recordedConversationId: CONVERSATION.toUpperCase(),
      sourceCwd: "/nowhere",
      targetCwd: "/nowhere",
      source: {
        inspect: async () => {
          throw Object.assign(new Error("gone"), { code: "session_not_found" });
        },
        transcripts: async () => ({
          agent_kind: "claude-code",
          supported: true,
          transcripts: [{ path: "a", name: "a", size: 600 * 1024 * 1024, role: "conversation" }],
          searched: [],
          truncated: false,
        }),
        readText,
      },
      target: { probe: async () => probe(), readText },
      legs: [],
    });
    expect(result.conversationId).toBe(CONVERSATION);
    expect(result.switched).toBe(false);
    expect(result.unconfirmed).toBe(false);
    expect(result.state).toBe("unknown");
    expect(result.tooLarge).toBe(true);
    expect(result.sourceHead).toBeNull();
  });
});
