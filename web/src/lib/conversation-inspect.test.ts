import { describe, expect, mock, test } from "bun:test";
import type { ConversationInspection } from "@/lib/conversation";
import { askWindowHost, type InspectingClient } from "@/lib/conversation-inspect";
import type { DaemonConnection } from "@/lib/daemon-connection";
import type { AgentTranscriptReport } from "@/lib/hostControl";

const hostId = "44444444-4444-4444-8444-444444444444";
const sessionId = "33333333-3333-4333-8333-333333333333";
const conversationId = "4e0b4642-0972-40ac-9a18-61d542276b76";
function connectionIn(state: string): DaemonConnection {
  return { getSnapshot: () => ({ state }) } as unknown as DaemonConnection;
}
const connection = connectionIn("ready");
const answer: ConversationInspection = {
  agent: "claude-code",
  conversation_id: conversationId,
  state: "idle",
  cli_version: "2.1.288",
  live_elsewhere: false,
  source: "registry",
};
const report: AgentTranscriptReport = {
  agent_kind: "claude-code",
  supported: true,
  transcripts: [],
  searched: ["~/.claude/projects"],
  truncated: false,
};
const query = { agentKind: "claude-code", conversationId, cwd: "/repo" };

function fakeClient(overrides: Partial<InspectingClient> = {}) {
  const client = {
    waitUntilReady: mock(async () => undefined),
    hasCapability: mock(
      (operation: string) => operation === "conv.v1" || operation === "agent.transcripts",
    ),
    inspectConversation: mock(async () => answer),
    agentTranscripts: mock(async () => report),
    close: mock(() => undefined),
    ...overrides,
  };
  return client;
}

describe("askWindowHost", () => {
  test("asks a host that offers conv.v1, then lets the channel go", async () => {
    const client = fakeClient();
    const host = askWindowHost(hostId, connection, sessionId, { openClient: () => client });
    expect(await host.inspect()).toEqual(answer);
    expect(client.inspectConversation).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    host.doneAsking();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("both questions share one channel and one budget", async () => {
    let clock = 1_000;
    const client = fakeClient({
      inspectConversation: mock(async () => {
        clock += 3_000;
        return answer;
      }),
    });
    const open = mock(() => client);
    const host = askWindowHost(hostId, connection, sessionId, {
      openClient: open,
      now: () => clock,
    });
    expect(await host.inspect()).toEqual(answer);
    expect(await host.transcripts(query)).toEqual(report);
    host.doneAsking();
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(client.inspectConversation).toHaveBeenCalledWith(sessionId, { timeoutMs: 4_000 });
    expect(client.agentTranscripts).toHaveBeenCalledWith(query, { timeoutMs: 1_000 });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("a budget the first question spent is no second answer", async () => {
    let clock = 1_000;
    const client = fakeClient({
      inspectConversation: mock(async () => {
        clock += 4_000;
        return answer;
      }),
    });
    const host = askWindowHost(hostId, connection, sessionId, {
      openClient: () => client,
      now: () => clock,
    });
    expect(await host.inspect()).toEqual(answer);
    expect(await host.transcripts(query)).toBeNull();
    expect(client.agentTranscripts).not.toHaveBeenCalled();
    host.doneAsking();
  });

  test("a host without conv.v1 or agent.transcripts is not asked", async () => {
    const client = fakeClient({ hasCapability: mock(() => false) });
    const host = askWindowHost(hostId, connection, sessionId, { openClient: () => client });
    expect(await host.inspect()).toBeNull();
    expect(await host.transcripts(query)).toBeNull();
    expect(client.inspectConversation).not.toHaveBeenCalled();
    expect(client.agentTranscripts).not.toHaveBeenCalled();
    host.doneAsking();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("no ready connection, no channel, or a failed question is no answer", async () => {
    const open = mock(() => fakeClient());
    for (const state of [null, connectionIn("connecting")]) {
      const host = askWindowHost(hostId, state, sessionId, { openClient: open });
      expect(await host.inspect()).toBeNull();
      expect(await host.transcripts(query)).toBeNull();
      host.doneAsking();
    }
    expect(open).not.toHaveBeenCalled();
    for (const client of [
      fakeClient({ waitUntilReady: mock(async () => Promise.reject(new Error("timed out"))) }),
      fakeClient({
        inspectConversation: mock(async () => Promise.reject(new Error("pair_required"))),
        agentTranscripts: mock(async () => Promise.reject(new Error("unsupported_operation"))),
      }),
    ]) {
      const host = askWindowHost(hostId, connection, sessionId, { openClient: () => client });
      expect(await host.inspect()).toBeNull();
      expect(await host.transcripts(query)).toBeNull();
      host.doneAsking();
      expect(client.close).toHaveBeenCalledTimes(1);
    }
  });

  test("nothing is asked once the restart is done asking", async () => {
    const open = mock(() => fakeClient());
    const host = askWindowHost(hostId, connection, sessionId, { openClient: open });
    host.doneAsking();
    expect(await host.inspect()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
