import { describe, expect, test } from "bun:test";
import { agentDisplayName, resolveAgentIcon } from "./AgentIcon";

describe("resolveAgentIcon", () => {
  test("resolves brand marks from kind", () => {
    expect(resolveAgentIcon("claude-code").icon).toBe("claude-code");
    expect(resolveAgentIcon("codex").icon).toBe("codex");
    expect(resolveAgentIcon("opencode").icon).toBe("opencode");
    expect(resolveAgentIcon("aider-sonnet").icon).toBe("aider");
    expect(resolveAgentIcon("hermes").icon).toBe("hermes");
  });

  test("kind wins over command", () => {
    expect(resolveAgentIcon("codex", "claude --resume").icon).toBe("codex");
  });

  test("falls back to command basename", () => {
    expect(resolveAgentIcon(undefined, "/usr/local/bin/claude").icon).toBe("claude-code");
    expect(resolveAgentIcon(null, "aider --model sonnet").icon).toBe("aider");
    expect(resolveAgentIcon(null, "hermes --yolo").icon).toBe("hermes");
  });

  test("skips env-prefix tokens in commands", () => {
    expect(resolveAgentIcon(undefined, "FOO=bar BAZ=1 codex").icon).toBe("codex");
  });

  test("shell names get the terminal glyph, labeled by shell", () => {
    for (const shell of ["bash", "zsh", "fish", "sh", "dash", "powershell", "pwsh", "cmd"]) {
      const resolved = resolveAgentIcon(undefined, `/bin/${shell}`);
      expect(resolved.icon).toBe("shell");
      expect(resolved.label).toBe(shell);
    }
    expect(resolveAgentIcon("zsh").icon).toBe("shell");
  });

  test("a Windows .exe suffix neither hides a brand nor un-shells a shell", () => {
    expect(resolveAgentIcon(undefined, "claude.exe").icon).toBe("claude-code");
    expect(resolveAgentIcon(undefined, "pwsh.exe").icon).toBe("shell");
  });

  test("unknown kinds become monograms with the first letter", () => {
    const resolved = resolveAgentIcon("goose");
    expect(resolved.icon).toBe("monogram");
    expect(resolved.letter).toBe("G");
    expect(resolved.label).toBe("goose");
  });

  test("nothing reported yet reads as a shell prompt", () => {
    const resolved = resolveAgentIcon(undefined, undefined);
    expect(resolved.icon).toBe("shell");
    expect(resolved.label).toBe("Shell");
  });
});

describe("agentDisplayName", () => {
  test("names known agents by brand", () => {
    expect(agentDisplayName("claude")).toBe("Claude Code");
    expect(agentDisplayName("/usr/local/bin/codex")).toBe("Codex");
    expect(agentDisplayName("hermes")).toBe("Hermes Agent");
  });

  test("nothing running reads as a shell", () => {
    expect(agentDisplayName(null)).toBe("Shell");
    expect(agentDisplayName("zsh")).toBe("zsh");
  });

  test("an unknown program keeps its own name", () => {
    expect(agentDisplayName("vim")).toBe("vim");
  });
});
