import { describe, expect, test } from "bun:test";
import { agentResumeCommand } from "@/lib/agent-relaunch";
import { FakeHost } from "./fakes";
import { NO_PUT_BACK_FACTS, putBackLine, readPutBackFacts } from "./put-back";

const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const CLAUDE = { kind: "claude-code", command: "claude", env: {} };

describe("putBackLine", () => {
  test("resumes the conversation that was moving with no mode of its own: Claude Code restores the one its record carries", () => {
    const line = putBackLine(CLAUDE, CONVERSATION, NO_PUT_BACK_FACTS);
    // The window ran in auto mode before the move; the record on the source
    // says so, and a resume without a mode brings it back — never manual
    // mode, or the source's default, said over it.
    expect(line).toBe(`claude --resume ${CONVERSATION}`);
    expect(line).not.toContain("--permission-mode");
  });

  test("is the line Restart types on that host, spelled for the source's shell", () => {
    expect(putBackLine(CLAUDE, CONVERSATION, NO_PUT_BACK_FACTS)).toBe(
      agentResumeCommand(CLAUDE, CONVERSATION),
    );
    const pwsh = { ...CLAUDE, env: { CLAUDE_CONFIG_DIR: "C:\\Users\\me\\claude" } };
    expect(putBackLine(pwsh, CONVERSATION, { loginShell: "pwsh.exe" })).toBe(
      `$env:CLAUDE_CONFIG_DIR='C:\\Users\\me\\claude'; claude --resume '${CONVERSATION}'`,
    );
  });

  test("a yolo window comes back skipping its prompts, as Restart brings it back", () => {
    const yolo = { ...CLAUDE, yolo: true, yolo_args: "--dangerously-skip-permissions" };
    expect(putBackLine(yolo, CONVERSATION, NO_PUT_BACK_FACTS)).toBe(
      `claude --dangerously-skip-permissions --resume ${CONVERSATION}`,
    );
  });

  test("an agent that cannot be resumed gets no line: the caller restarts the ordinary way", () => {
    expect(
      putBackLine({ kind: "aider", command: "aider", env: {} }, CONVERSATION, NO_PUT_BACK_FACTS),
    ).toBeNull();
  });

  test("an id that is not a conversation id is never typed", () => {
    const line = putBackLine(CLAUDE, "--dangerously-skip-permissions", NO_PUT_BACK_FACTS);
    expect(line).not.toContain("--dangerously-skip-permissions");
  });
});

describe("readPutBackFacts", () => {
  test("asks the source for its shell, and nothing else", async () => {
    const source = new FakeHost("source");
    source.loginShell = "/usr/bin/fish";
    const facts = await readPutBackFacts(source.client(), {
      conversationId: CONVERSATION,
      cwd: "/home/me/code/spawn",
    });
    expect(facts).toEqual({ loginShell: "/usr/bin/fish" });
    expect(source.operations).toEqual(["conv.probe"]);
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
