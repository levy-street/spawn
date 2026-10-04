import { describe, expect, test } from "bun:test";
import { FakeHost } from "./fakes";
import { NO_PUT_BACK_FACTS, putBackLine, readPutBackFacts } from "./put-back";

const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const CLAUDE = { kind: "claude-code", command: "claude", env: {} };

describe("putBackLine", () => {
  test("resumes the conversation that was moving with its mode said outright", () => {
    expect(putBackLine(CLAUDE, CONVERSATION, NO_PUT_BACK_FACTS)).toBe(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
  });

  test("starts in the source's own default mode, never the record's", () => {
    const settings = JSON.stringify({ permissions: { defaultMode: "acceptEdits" } });
    expect(putBackLine(CLAUDE, CONVERSATION, { loginShell: "/bin/zsh", settings })).toBe(
      `claude --resume ${CONVERSATION} --permission-mode acceptEdits`,
    );
    // "manual" is Claude Code's newer name for default.
    const manual = JSON.stringify({ permissions: { defaultMode: "manual" } });
    expect(putBackLine(CLAUDE, CONVERSATION, { loginShell: null, settings: manual })).toBe(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
  });

  test("a yolo window keeps skipping its prompts, and the yolo flag gives way to the mode", () => {
    const yolo = { ...CLAUDE, yolo: true, yolo_args: "--dangerously-skip-permissions" };
    const line = putBackLine(yolo, CONVERSATION, NO_PUT_BACK_FACTS);
    expect(line).toBe(`claude --resume ${CONVERSATION} --permission-mode bypassPermissions`);
    expect(line).not.toContain("--dangerously-skip-permissions");
  });

  test("an agent with no mode flag gets no line: the caller restarts the ordinary way", () => {
    expect(
      putBackLine({ kind: "codex", command: "codex", env: {} }, CONVERSATION, NO_PUT_BACK_FACTS),
    ).toBeNull();
  });

  test("an id that is not a conversation id is never typed", () => {
    const line = putBackLine(CLAUDE, "--dangerously-skip-permissions", NO_PUT_BACK_FACTS);
    expect(line).not.toContain("--dangerously-skip-permissions");
  });
});

describe("readPutBackFacts", () => {
  test("asks the source for its shell and its settings", async () => {
    const source = new FakeHost("source");
    source.loginShell = "/usr/bin/fish";
    const read: string[] = [];
    const facts = await readPutBackFacts(
      source.client(),
      { conversationId: CONVERSATION, cwd: "/home/me/code/spawn" },
      async (_client, path) => {
        read.push(path);
        return '{"permissions":{"defaultMode":"plan"}}';
      },
    );
    expect(facts).toEqual({
      loginShell: "/usr/bin/fish",
      settings: '{"permissions":{"defaultMode":"plan"}}',
    });
    expect(read).toEqual(["~/.claude/settings.json"]);
  });

  test("a source that cannot answer leaves nothing known, and never throws", async () => {
    const source = new FakeHost("source");
    const channel = source.client();
    source.goOffline();
    expect(await readPutBackFacts(channel, { conversationId: CONVERSATION, cwd: "/" })).toEqual(
      NO_PUT_BACK_FACTS,
    );
    expect(await readPutBackFacts(null, { conversationId: CONVERSATION, cwd: "/" })).toEqual(
      NO_PUT_BACK_FACTS,
    );
  });
});
