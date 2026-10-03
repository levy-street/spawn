import { describe, expect, mock, test } from "bun:test";
import type { ConversationInspection } from "@/lib/conversation";
import { type InspectingClient, inspectWindowConversation } from "@/lib/conversation-inspect";
import type { DaemonConnection } from "@/lib/daemon-connection";

const hostId = "44444444-4444-4444-8444-444444444444";
const sessionId = "33333333-3333-4333-8333-333333333333";
function connectionIn(state: string): DaemonConnection {
  return { getSnapshot: () => ({ state }) } as unknown as DaemonConnection;
}
const connection = connectionIn("ready");
const answer: ConversationInspection = {
  agent: "claude-code",
  conversation_id: "4e0b4642-0972-40ac-9a18-61d542276b76",
  state: "idle",
  cli_version: "2.1.288",
  live_elsewhere: false,
  source: "registry",
};

function fakeClient(overrides: Partial<InspectingClient> = {}) {
  const client = {
    waitUntilReady: mock(async () => undefined),
    hasCapability: mock((operation: string) => operation === "conv.v1"),
    inspectConversation: mock(async () => answer),
    close: mock(() => undefined),
    ...overrides,
  };
  return client;
}

describe("inspectWindowConversation", () => {
  test("asks a host that offers conv.v1, then lets the channel go", async () => {
    const client = fakeClient();
    expect(await inspectWindowConversation(hostId, connection, sessionId, () => client)).toEqual(
      answer,
    );
    expect(client.inspectConversation).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("a host without conv.v1 is not asked", async () => {
    const client = fakeClient({ hasCapability: mock(() => false) });
    expect(await inspectWindowConversation(hostId, connection, sessionId, () => client)).toBeNull();
    expect(client.inspectConversation).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("no ready connection, no channel, or a failed question is no answer", async () => {
    const open = mock(() => fakeClient());
    expect(await inspectWindowConversation(hostId, null, sessionId, open)).toBeNull();
    expect(
      await inspectWindowConversation(hostId, connectionIn("connecting"), sessionId, open),
    ).toBeNull();
    expect(open).not.toHaveBeenCalled();
    for (const client of [
      fakeClient({ waitUntilReady: mock(async () => Promise.reject(new Error("timed out"))) }),
      fakeClient({
        inspectConversation: mock(async () => Promise.reject(new Error("pair_required"))),
      }),
    ]) {
      expect(
        await inspectWindowConversation(hostId, connection, sessionId, () => client),
      ).toBeNull();
      expect(client.close).toHaveBeenCalledTimes(1);
    }
  });
});
