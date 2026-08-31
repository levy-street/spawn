import {
  agentInstallAndRunCommand,
  agentRunCommand,
  commandBasename,
  identifyAgent,
  runningAgent,
  sortAgents,
} from "@/data/selectors/agent";
import type { AgentDef } from "@/data/types/domain";

function agent(overrides: Partial<AgentDef>): AgentDef {
  return {
    id: "agent-id",
    owner_user_id: null,
    name: "codex",
    kind: "codex",
    command: "codex",
    env: {},
    install: null,
    yolo_args: null,
    yolo_env: {},
    yolo: false,
    ...overrides,
  };
}

const BUILT_INS = [
  agent({ id: "claude", name: "claude-code", kind: "claude-code", command: "claude" }),
  agent({ id: "codex", name: "codex", kind: "codex", command: "codex" }),
  agent({ id: "opencode", name: "opencode", kind: "opencode", command: "opencode" }),
  agent({
    id: "aider",
    name: "aider-sonnet",
    kind: "aider",
    command: "aider --model claude-sonnet-4-6",
  }),
];

describe("agent identity", () => {
  it.each([
    ["claude", "claude-code", "Claude Code"],
    ["codex", "codex", "Codex"],
    ["opencode", "opencode", "OpenCode"],
    ["aider", "aider", "Aider Sonnet"],
  ])("recognizes %s", (command, logoKey, displayName) => {
    expect(identifyAgent(command, BUILT_INS)).toMatchObject({ logoKey, displayName });
  });

  it("matches a custom definition by executable basename", () => {
    const custom = agent({
      id: "custom",
      owner_user_id: "user",
      name: "Acme Pilot",
      kind: "acme",
      command: "acme-agent --interactive",
    });

    expect(identifyAgent("ENV=1 /opt/acme/acme-agent --resume", [custom])).toEqual({
      kind: "acme",
      displayName: "Acme Pilot",
      logoKey: null,
      monogramSeed: "Acme Pilot",
    });
    expect(runningAgent("/opt/acme/acme-agent --resume", [custom])).toBe(custom);
  });

  it.each([
    [null, "Shell", "shell"],
    ["/bin/zsh -l", "Shell", "shell"],
    ["/opt/bin/mystery --flag", "mystery", null],
    ["A=1 B=two /usr/local/bin/codex --resume", "Codex", "codex"],
    ["-bash", "Shell", "shell"],
  ])("handles command form %s", (command, displayName, logoKey) => {
    expect(identifyAgent(command, BUILT_INS)).toMatchObject({ displayName, logoKey });
  });

  it("parses paths, arguments, environment prefixes, and empty values", () => {
    expect(commandBasename("A=1 /usr/local/bin/opencode --continue")).toBe("opencode");
    expect(commandBasename("A=1 B=2")).toBeNull();
    expect(commandBasename("  ")).toBeNull();
  });

  it("reads a Windows host's .exe suffix as the same program", () => {
    // Windows reports "claude.exe" for the definition spelled "claude"; an
    // exact match would call that pane a plain shell and a duplicate of it
    // would come back empty.
    expect(runningAgent("claude.exe", BUILT_INS)?.id).toBe("claude");
    expect(identifyAgent("CODEX.EXE", BUILT_INS)).toMatchObject({
      displayName: "Codex",
      logoKey: "codex",
    });
    expect(identifyAgent("powershell.exe", BUILT_INS)).toMatchObject({
      displayName: "Shell",
      logoKey: "shell",
    });
    expect(runningAgent("pwsh.exe", BUILT_INS)).toBeNull();
  });
});

describe("agent launch commands", () => {
  it("quotes environment values, drops invalid keys, and layers yolo values", () => {
    const definition = agent({
      command: "acme",
      env: { SAFE: "simple", QUOTED: "it's here", "BAD-KEY": "drop" },
      yolo: true,
      yolo_args: "  --unsafe  ",
      yolo_env: { SAFE: "override", EXTRA: "two words" },
    });

    expect(agentRunCommand(definition)).toBe(
      "SAFE=override QUOTED='it'\\''s here' EXTRA='two words' acme --unsafe",
    );
  });

  it("constructs install-and-run only when an install command exists", () => {
    expect(agentInstallAndRunCommand(agent({ install: " npm i -g acme " }))).toBe(
      "npm i -g acme && codex",
    );
    expect(agentInstallAndRunCommand(agent({ install: "  " }))).toBeNull();
  });

  it("sorts built-ins before custom definitions and alphabetically within groups", () => {
    const sorted = sortAgents([
      agent({ id: "z", owner_user_id: "user", name: "Zulu" }),
      agent({ id: "b", name: "Beta" }),
      agent({ id: "a", name: "alpha" }),
      agent({ id: "c", owner_user_id: "user", name: "Charlie" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c", "z"]);
  });
});
