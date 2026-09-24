import { describe, expect, test } from "bun:test";

import {
  transcriptEmptyState,
  transcriptQueryFor,
  transcriptRoleLabel,
  transcriptsUnavailable,
} from "./agent-transcripts";
import type { Agent } from "./api";
import type { AgentTranscriptReport } from "./hostControl";

const claude: Agent = {
  id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: null,
  name: "claude-code",
  kind: "claude-code",
  command: "claude",
  env: {},
  install: null,
  yolo_args: null,
  yolo_env: {},
  yolo: false,
};

const codex: Agent = {
  ...claude,
  id: "00000000-0000-4000-8000-000000000002",
  name: "codex",
  kind: "codex",
  command: "codex",
};

function report(overrides: Partial<AgentTranscriptReport> = {}): AgentTranscriptReport {
  return {
    agent_kind: "claude-code",
    supported: true,
    transcripts: [],
    searched: [],
    truncated: false,
    ...overrides,
  };
}

describe("transcriptQueryFor", () => {
  test("asks by the recorded agent, its conversation id, and the launch folder", () => {
    const target = transcriptQueryFor(
      {
        foreground_command: "claude",
        agent_id: claude.id,
        agent_session_id: "45171e5a-5951-4d38-81e5-e1c0f9639d80",
        cwd: "/home/me/proj",
      },
      [claude, codex],
    );
    expect(target?.agent).toBe(claude);
    expect(target?.query).toEqual({
      agentKind: "claude-code",
      conversationId: "45171e5a-5951-4d38-81e5-e1c0f9639d80",
      cwd: "/home/me/proj",
    });
  });

  test("a codex window has no id recorded and asks by folder alone", () => {
    const target = transcriptQueryFor(
      { foreground_command: "codex", agent_id: codex.id, agent_session_id: null, cwd: "/w" },
      [claude, codex],
    );
    expect(target?.query).toEqual({ agentKind: "codex", conversationId: null, cwd: "/w" });
  });

  test("a shell window has nothing to ask for", () => {
    expect(
      transcriptQueryFor(
        { foreground_command: "zsh", agent_id: null, agent_session_id: null, cwd: "/w" },
        [claude, codex],
      ),
    ).toBeNull();
  });
});

describe("transcript copy", () => {
  test("roles read as what they are", () => {
    expect(transcriptRoleLabel("conversation")).toBe("Conversation");
    expect(transcriptRoleLabel("subagent")).toBe("Subagent");
    expect(transcriptRoleLabel("input")).toBe("Prompt history");
  });

  test("an unsupported harness is SPAWN D's limit, not the agent's silence", () => {
    const notice = transcriptEmptyState(
      report({ agent_kind: "opencode", supported: false }),
      "opencode",
      "dream",
    );
    expect(notice?.title).toBe("No transcript for opencode");
    expect(notice?.body).toContain("SPAWN D doesn't know where opencode keeps");
  });

  test("an empty search says where it looked", () => {
    const notice = transcriptEmptyState(
      report({ searched: ["/home/me/.claude/projects"] }),
      "claude-code",
      "dream",
    );
    expect(notice?.title).toBe("No transcript yet");
    expect(notice?.body).toBe(
      "claude-code hasn't written a conversation for this window on dream. Looked in /home/me/.claude/projects.",
    );
  });

  test("a found transcript needs no notice", () => {
    expect(
      transcriptEmptyState(
        report({
          transcripts: [
            {
              path: "/home/me/.claude/projects/-w/a.jsonl",
              name: "a.jsonl",
              size: 1,
              role: "conversation",
            },
          ],
        }),
        "claude-code",
        "dream",
      ),
    ).toBeNull();
  });

  test("an old daemon names the daemon, not the product", () => {
    expect(transcriptsUnavailable("dream").body).toContain("spawnd daemon on dream");
  });
});
