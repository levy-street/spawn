import { describe, expect, test } from "bun:test";
import {
  agentInstallAndRunCommand,
  agentRunCommand,
  agentYoloAvailable,
  envPrefix,
  shellQuote,
} from "@/components/workspace/agent-command";

describe("shellQuote", () => {
  test("passes safe words through bare", () => {
    expect(shellQuote("bar")).toBe("bar");
    expect(shellQuote("/usr/local/bin:x_1,y.z@host%2+=-")).toBe("/usr/local/bin:x_1,y.z@host%2+=-");
  });

  test("quotes empty strings and words with unsafe characters", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("a$b")).toBe("'a$b'");
    expect(shellQuote("semi;colon")).toBe("'semi;colon'");
    expect(shellQuote("back`tick`")).toBe("'back`tick`'");
  });

  test("escapes embedded single quotes with the '\\'' idiom", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });
});

describe("envPrefix", () => {
  test("empty dict yields an empty prefix", () => {
    expect(envPrefix({})).toBe("");
  });

  test("builds KEY=value pairs in dict order with a trailing space", () => {
    expect(envPrefix({ FOO: "bar", BAZ: "qux" })).toBe("FOO=bar BAZ=qux ");
  });

  test("quotes values that need it", () => {
    expect(envPrefix({ MSG: "hello world" })).toBe("MSG='hello world' ");
    expect(envPrefix({ TOKEN: "a'b" })).toBe("TOKEN='a'\\''b' ");
    expect(envPrefix({ EMPTY: "" })).toBe("EMPTY='' ");
  });

  test("drops keys that are not valid shell identifiers", () => {
    expect(envPrefix({ "BAD-KEY": "x", "1LEAD": "y", GOOD_1: "z" })).toBe("GOOD_1=z ");
  });
});

describe("agentRunCommand", () => {
  test("is the bare command without env", () => {
    expect(agentRunCommand({ command: "claude --continue", env: {} })).toBe("claude --continue");
  });

  test("prefixes env assignments", () => {
    expect(
      agentRunCommand({ command: "aider --model sonnet", env: { AIDER_DARK_MODE: "true" } }),
    ).toBe("AIDER_DARK_MODE=true aider --model sonnet");
  });

  test("appends yolo arguments only when the preference is on", () => {
    const claude = { command: "claude", env: {}, yolo_args: "--dangerously-skip-permissions" };
    expect(agentRunCommand({ ...claude, yolo: false })).toBe("claude");
    expect(agentRunCommand({ ...claude, yolo: true })).toBe(
      "claude --dangerously-skip-permissions",
    );
  });

  test("merges yolo env over the agent's own, quoting as usual", () => {
    // opencode has no flag: yolo is a configuration override in the env.
    expect(
      agentRunCommand({
        command: "opencode",
        env: { OPENCODE_THEME: "dark" },
        yolo: true,
        yolo_args: null,
        yolo_env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
      }),
    ).toBe(`OPENCODE_THEME=dark OPENCODE_PERMISSION='{"edit":"allow"}' opencode`);
  });

  test("a preference with nothing to spell it changes nothing", () => {
    expect(agentRunCommand({ command: "mine", env: {}, yolo: true, yolo_args: "  " })).toBe("mine");
    expect(agentRunCommand({ command: "mine", env: {}, yolo: true })).toBe("mine");
  });
});

describe("agentYoloAvailable", () => {
  test("true when there is an argument or an environment variable to set", () => {
    expect(agentYoloAvailable({ yolo_args: "--yes-always" })).toBe(true);
    expect(agentYoloAvailable({ yolo_env: { OPENCODE_PERMISSION: "{}" } })).toBe(true);
  });

  test("false when the agent has no way to skip its prompts", () => {
    expect(agentYoloAvailable({})).toBe(false);
    expect(agentYoloAvailable({ yolo_args: "   ", yolo_env: {} })).toBe(false);
    expect(agentYoloAvailable({ yolo_args: null, yolo_env: null })).toBe(false);
  });
});

describe("agentInstallAndRunCommand", () => {
  test("chains install into the run command", () => {
    expect(
      agentInstallAndRunCommand({
        command: "codex",
        env: { FOO: "b r" },
        install: "npm i -g @openai/codex",
      }),
    ).toBe("npm i -g @openai/codex && FOO='b r' codex");
  });

  test("carries yolo into the run half of the chain", () => {
    expect(
      agentInstallAndRunCommand({
        command: "claude",
        env: {},
        install: "npm i -g @anthropic-ai/claude-code",
        yolo: true,
        yolo_args: "--dangerously-skip-permissions",
      }),
    ).toBe("npm i -g @anthropic-ai/claude-code && claude --dangerously-skip-permissions");
  });

  test("null when there is no install command", () => {
    expect(agentInstallAndRunCommand({ command: "codex", env: {}, install: null })).toBeNull();
    expect(agentInstallAndRunCommand({ command: "codex", env: {}, install: "  " })).toBeNull();
  });
});
