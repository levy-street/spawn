import { describe, expect, test } from "bun:test";
import { type AgentKind, agentKind, agentKindLabel, isYoloArgv } from "./agents";
import type { Agent } from "./api";

/** Only `argv` matters to the sniffer; the rest is scaffolding. */
function withArgv(argv: string[]): Agent {
  return { argv } as unknown as Agent;
}

describe("agentKind", () => {
  test("recognizes each built-in from its binary", () => {
    const cases: Array<[string[], AgentKind]> = [
      [["codex"], "codex"],
      [["claude"], "claude"],
      [["opencode"], "opencode"],
      [["aider", "--model", "claude-sonnet-4-6"], "aider"],
      [["hermes"], "hermes"],
      [["grok"], "grok"],
      [["bash", "-l"], "shell"],
    ];
    for (const [argv, expected] of cases) {
      expect(agentKind(withArgv(argv))).toBe(expected);
    }
  });

  test("looks at the binary, not the path or the case", () => {
    expect(agentKind(withArgv(["/usr/local/bin/hermes", "--tui"]))).toBe("hermes");
    expect(agentKind(withArgv(["~/.local/bin/Hermes"]))).toBe("hermes");
    expect(agentKind(withArgv(["/opt/homebrew/bin/grok", "-p", "explain this"]))).toBe("grok");
  });

  test("aider's own model flag never makes it Claude", () => {
    // The claude check runs on argv[0] only, which is what keeps this honest.
    expect(agentKind(withArgv(["aider", "--model", "claude-sonnet-4-6"]))).toBe("aider");
  });

  test("anything unrecognized is custom rather than a wrong brand", () => {
    expect(agentKind(withArgv(["some-other-agent"]))).toBe("custom");
    expect(agentKind(withArgv([]))).toBe("custom");
  });
});

describe("agentKindLabel", () => {
  test("names the new tools as their vendors do", () => {
    expect(agentKindLabel("hermes")).toBe("Hermes Agent");
    expect(agentKindLabel("grok")).toBe("Grok Build");
  });

  test("every kind has a label, so none falls through to Custom by accident", () => {
    const kinds: AgentKind[] = ["codex", "claude", "opencode", "aider", "hermes", "grok", "shell"];
    for (const kind of kinds) {
      expect(agentKindLabel(kind)).not.toBe("Custom");
    }
    expect(agentKindLabel("custom")).toBe("Custom");
  });
});

describe("isYoloArgv", () => {
  test("marks an agent by the command it actually runs", () => {
    expect(isYoloArgv(["codex", "--yolo"])).toBe(true);
    expect(isYoloArgv(["claude", "--dangerously-skip-permissions"])).toBe(true);
    expect(isYoloArgv(["aider", "--yes-always"])).toBe(true);
    expect(isYoloArgv(["hermes", "--yolo"])).toBe(true);
  });

  test("leaves gated agents alone", () => {
    expect(isYoloArgv(["codex"])).toBe(false);
    expect(isYoloArgv(["grok"])).toBe(false);
    expect(isYoloArgv(["bash", "-l"])).toBe(false);
    // A flag that merely contains the word is not the flag.
    expect(isYoloArgv(["codex", "--yolo-mode-off"])).toBe(false);
  });
});
