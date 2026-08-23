import { makeAgent } from "@/components/launcher/__tests__/fixtures";
import {
  agentInstallAndRunCommand,
  agentRunCommand,
  agentYoloAvailable,
  envPrefix,
  shellQuote,
  sortAgents,
} from "@/components/launcher/agent-command";

describe("launcher command construction", () => {
  test("quotes POSIX words and embedded quotes byte-for-byte", () => {
    expect(shellQuote("/usr/local/bin:x_1,y.z@host%2+=-")).toBe("/usr/local/bin:x_1,y.z@host%2+=-");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("builds ordered environment prefixes and rejects invalid identifiers", () => {
    expect(envPrefix({ FOO: "bar", MSG: "hello world", "BAD-KEY": "secret" })).toBe(
      "FOO=bar MSG='hello world' ",
    );
  });

  test.each([
    [
      "claude-code",
      "claude",
      "--dangerously-skip-permissions",
      {},
      "claude --dangerously-skip-permissions",
    ],
    [
      "codex",
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      {},
      "codex --dangerously-bypass-approvals-and-sandbox",
    ],
    [
      "opencode",
      "opencode",
      null,
      { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}' },
      'OPENCODE_PERMISSION=\'{"edit":"allow","bash":"allow","webfetch":"allow"}\' opencode',
    ],
    [
      "aider-sonnet",
      "aider --model claude-sonnet-4-6",
      "--yes-always",
      {},
      "aider --model claude-sonnet-4-6 --yes-always",
    ],
  ])("constructs the built-in %s command", (name, command, yoloArgs, yoloEnv, expected) => {
    expect(
      agentRunCommand(
        makeAgent({
          name,
          command,
          yolo: true,
          yolo_args: yoloArgs,
          yolo_env: yoloEnv,
        }),
      ),
    ).toBe(expected);
  });

  test("constructs a custom agent with env and install fallback", () => {
    const custom = makeAgent({
      owner_user_id: "50000000-0000-4000-8000-000000000001",
      name: "reviewer",
      command: "review --stdin",
      env: { REVIEW_MODE: "careful mode" },
      install: "pipx install reviewer",
      yolo: false,
      yolo_args: null,
    });
    expect(agentRunCommand(custom)).toBe("REVIEW_MODE='careful mode' review --stdin");
    expect(agentInstallAndRunCommand(custom)).toBe(
      "pipx install reviewer && REVIEW_MODE='careful mode' review --stdin",
    );
  });

  test("only enables yolo when a flag or environment override exists", () => {
    expect(agentYoloAvailable({ yolo_args: "  ", yolo_env: {} })).toBe(false);
    expect(agentYoloAvailable({ yolo_env: { ALLOW: "1" } })).toBe(true);
  });

  test("sorts built-ins before alphabetical custom definitions", () => {
    const custom = makeAgent({
      id: "10000000-0000-4000-8000-000000000002",
      owner_user_id: "50000000-0000-4000-8000-000000000001",
      name: "Alpha custom",
    });
    const builtin = makeAgent({ name: "Zulu built-in" });
    expect(sortAgents([custom, builtin]).map((agent) => agent.name)).toEqual([
      "Zulu built-in",
      "Alpha custom",
    ]);
  });
});
