import {
  agentKindFor,
  agentLabel,
  resolvePinnedCommands,
  terminalCommandGroups,
  terminalCommandsFor,
} from "@/components/terminal-ui/terminal-commands";
import { encodeKey } from "@/terminal/key-encoder";

describe("agent kind", () => {
  test.each([
    ["claude", "claude-code"],
    ["npx claude --resume", "claude-code"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["aider", "aider"],
    ["zsh", "shell"],
    ["-bash", "shell"],
    [null, "shell"],
    // Anything else running in the foreground is an agent, not a prompt: it gets
    // the generic agent keys rather than a shell's.
    ["nebula", "agent"],
  ] as const)("reads %s as %s", (command, kind) => {
    expect(agentKindFor(command)).toBe(kind);
  });

  test("names each kind for the header and the drawer title", () => {
    expect(agentLabel(agentKindFor("claude"))).toBe("Claude Code");
    expect(agentLabel(agentKindFor("zsh"))).toBe("Shell");
  });
});

describe("terminal command groups", () => {
  test("leads with the running agent's own keys, named by what they do", () => {
    const [first] = terminalCommandGroups("claude-code");

    expect(first?.title).toBe("CLAUDE CODE");
    expect(first?.presentation).toBe("rows");
    expect(first?.commands.map((command) => command.label)).toEqual(
      expect.arrayContaining(["Interrupt", "Cycle mode", "Slash command", "Newline"]),
    );
  });

  test("gives shift-tab to every agent, which is how their modes are cycled", () => {
    for (const kind of ["claude-code", "codex", "opencode", "agent"] as const) {
      const [agent] = terminalCommandGroups(kind);
      expect(agent?.commands.map((command) => command.id)).toContain("key-BackTab");
    }
  });

  test("a shell gets a prompt's keys instead, and no mode to cycle", () => {
    const [agent] = terminalCommandGroups("shell");

    expect(agent?.commands.map((command) => command.label)).toEqual([
      "Complete",
      "Stop",
      "End of input",
      "Search history",
      "Clear screen",
      "Suspend",
    ]);
  });

  test("carries no function keys or other plates nothing reaches for", () => {
    const caps = terminalCommandsFor("claude-code").map((command) => command.cap);

    // The list this replaced was every key the encoder could name: twelve
    // function keys, Insert, a full symbol rank. None of them earned the room.
    expect(caps.filter((cap) => /^F\d+$/.test(cap))).toHaveLength(0);
    expect(caps).not.toContain("Ins");
    expect(caps).not.toContain("$");
  });

  test("never offers the same key twice, however many groups could claim it", () => {
    for (const kind of ["claude-code", "codex", "shell"] as const) {
      const ids = terminalCommandGroups(kind).flatMap((group) =>
        group.commands.map((command) => command.id),
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("keeps the arrows whole even when the agent already claimed a key", () => {
    const arrows = terminalCommandGroups("shell").find((group) => group.id === "arrows");
    expect(arrows?.commands.map((command) => command.cap)).toEqual(["↑", "↓", "←", "→"]);
  });

  test("every command encodes to something the terminal can receive", () => {
    for (const command of terminalCommandsFor("claude-code")) {
      expect(encodeKey(command.spec).length).toBeGreaterThan(0);
    }
  });

  test("asks for two presses on the rewind, not two escapes in one packet", () => {
    const rewind = terminalCommandsFor("codex").find((command) => command.id === "esc-esc");

    expect(rewind?.presses).toBe(2);
    expect(rewind?.spec).toEqual({ kind: "named", key: "Escape" });
  });
});

describe("resolving pinned ids", () => {
  test("keeps the pinned order and drops ids this agent has no key for", () => {
    const resolved = resolvePinnedCommands("shell", [
      "ctrl-c",
      "key-BackTab",
      "text-@",
      "nonsense",
    ]);

    // "@" is a Claude Code and Codex key; a shell never offers it, so a pin made
    // under one agent simply does not appear under another.
    expect(resolved.map((command) => command.id)).toEqual(["ctrl-c", "key-BackTab"]);
  });
});
