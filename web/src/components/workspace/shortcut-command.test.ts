import { describe, expect, test } from "bun:test";
import {
  agentInstallAndRunCommand,
  agentRunCommand,
  envPrefix,
  shellQuote,
} from "@/components/workspace/shortcut-command";

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

  test("null when there is no install command", () => {
    expect(agentInstallAndRunCommand({ command: "codex", env: {}, install: null })).toBeNull();
    expect(agentInstallAndRunCommand({ command: "codex", env: {}, install: "  " })).toBeNull();
  });
});
