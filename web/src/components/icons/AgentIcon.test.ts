import { describe, expect, test } from "bun:test";
import { resolveAgentIcon } from "./AgentIcon";

describe("resolveAgentIcon", () => {
  test("resolves brand marks from kind", () => {
    expect(resolveAgentIcon("claude-code").icon).toBe("claude-code");
    expect(resolveAgentIcon("codex").icon).toBe("codex");
    expect(resolveAgentIcon("opencode").icon).toBe("opencode");
    expect(resolveAgentIcon("aider-sonnet").icon).toBe("aider");
  });

  test("kind wins over command", () => {
    expect(resolveAgentIcon("codex", "claude --resume").icon).toBe("codex");
  });

  test("falls back to command basename", () => {
    expect(resolveAgentIcon(undefined, "/usr/local/bin/claude").icon).toBe("claude-code");
    expect(resolveAgentIcon(null, "aider --model sonnet").icon).toBe("aider");
  });

  test("skips env-prefix tokens in commands", () => {
    expect(resolveAgentIcon(undefined, "FOO=bar BAZ=1 codex").icon).toBe("codex");
  });

  test("shell names get the terminal glyph, labeled by shell", () => {
    for (const shell of ["bash", "zsh", "fish", "sh", "dash"]) {
      const resolved = resolveAgentIcon(undefined, `/bin/${shell}`);
      expect(resolved.icon).toBe("shell");
      expect(resolved.label).toBe(shell);
    }
    expect(resolveAgentIcon("zsh").icon).toBe("shell");
  });

  test("unknown kinds become monograms with the first letter", () => {
    const resolved = resolveAgentIcon("goose");
    expect(resolved.icon).toBe("monogram");
    expect(resolved.letter).toBe("G");
    expect(resolved.label).toBe("goose");
  });

  test("empty input still renders something", () => {
    const resolved = resolveAgentIcon(undefined, undefined);
    expect(resolved.icon).toBe("monogram");
    expect(resolved.letter).toBe("?");
    expect(resolved.label).toBe("Agent");
  });
});
