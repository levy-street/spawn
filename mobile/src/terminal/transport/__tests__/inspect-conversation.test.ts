import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import { askWindowHost } from "@/terminal/transport/inspect-conversation";
import type { AgentTranscriptReport } from "@/terminal/transport/types";

const conversationId = "4e0b4642-0972-40ac-9a18-61d542276b76";
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

const offered = (operation: string) => operation === "conv.v1" || operation === "agent.transcripts";
const mockConsumer = {
  open: jest.fn(async () => undefined),
  close: jest.fn(),
  hasCapability: jest.fn(offered),
  inspectConversation: jest.fn(async (_sessionId: string, _options?: unknown) => answer),
  agentTranscripts: jest.fn(async (_query: unknown, _options?: unknown) => report),
};
const mockLease = {
  shared: { bridge: { name: "bridge" }, transport: { name: "root", state: "ready" } },
  release: jest.fn(),
};
const mockRetain = jest.fn((_options: unknown, _canOwnWorker: boolean) => mockLease);
const mockCreateConsumer = jest.fn((_options: unknown, _parent: unknown) => mockConsumer);

jest.mock("@/terminal/transport/host-transport-registry", () => ({
  retainHostTransport: (options: unknown, canOwnWorker: boolean) =>
    mockRetain(options, canOwnWorker),
}));
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostConsumerTransport: (options: unknown, parent: unknown) =>
    mockCreateConsumer(options, parent),
}));

const host = { hostId: "44444444-4444-4444-8444-444444444444", hostIdentityPublicKey: "host-key" };
const sessionId = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  jest.clearAllMocks();
  mockConsumer.open.mockImplementation(async () => undefined);
  mockConsumer.hasCapability.mockImplementation(offered);
  mockConsumer.inspectConversation.mockImplementation(async () => answer);
  mockConsumer.agentTranscripts.mockImplementation(async () => report);
});

describe("askWindowHost", () => {
  test("asks on a consumer channel of the retained connection, never taking its seat", async () => {
    const asked = askWindowHost(host, sessionId);
    await expect(asked.inspect()).resolves.toEqual(answer);
    expect(mockRetain).toHaveBeenCalledWith(host, false);
    expect(mockCreateConsumer).toHaveBeenCalledWith(
      { ...host, bridge: mockLease.shared.bridge },
      mockLease.shared.transport,
    );
    expect(mockConsumer.inspectConversation).toHaveBeenCalledWith(sessionId, { timeoutMs: 4_000 });
    expect(mockConsumer.close).not.toHaveBeenCalled();
    asked.doneAsking();
    expect(mockConsumer.close).toHaveBeenCalledTimes(1);
    expect(mockLease.release).toHaveBeenCalledTimes(1);
  });

  test("both questions share one channel and one budget", async () => {
    jest.useFakeTimers();
    try {
      mockConsumer.inspectConversation.mockImplementation(async () => {
        jest.advanceTimersByTime(3_000);
        return answer;
      });
      const asked = askWindowHost(host, sessionId);
      await expect(asked.inspect()).resolves.toEqual(answer);
      await expect(asked.transcripts(query)).resolves.toEqual(report);
      asked.doneAsking();
      expect(mockRetain).toHaveBeenCalledTimes(1);
      expect(mockConsumer.open).toHaveBeenCalledTimes(1);
      expect(mockConsumer.agentTranscripts).toHaveBeenCalledWith(query, { timeoutMs: 1_000 });
      expect(mockConsumer.close).toHaveBeenCalledTimes(1);
      expect(mockLease.release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a budget the first question spent is no second answer", async () => {
    jest.useFakeTimers();
    try {
      mockConsumer.inspectConversation.mockImplementation(async () => {
        jest.advanceTimersByTime(4_000);
        return answer;
      });
      const asked = askWindowHost(host, sessionId);
      await expect(asked.inspect()).resolves.toEqual(answer);
      await expect(asked.transcripts(query)).resolves.toBeNull();
      expect(mockConsumer.agentTranscripts).not.toHaveBeenCalled();
      asked.doneAsking();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a host without conv.v1 or agent.transcripts is not asked", async () => {
    mockConsumer.hasCapability.mockImplementation(() => false);
    const asked = askWindowHost(host, sessionId);
    await expect(asked.inspect()).resolves.toBeNull();
    await expect(asked.transcripts(query)).resolves.toBeNull();
    expect(mockConsumer.inspectConversation).not.toHaveBeenCalled();
    expect(mockConsumer.agentTranscripts).not.toHaveBeenCalled();
    asked.doneAsking();
    expect(mockLease.release).toHaveBeenCalledTimes(1);
  });

  test("a connection that never opens is no answer, and is let go", async () => {
    jest.useFakeTimers();
    try {
      mockConsumer.open.mockImplementation(() => new Promise<undefined>(() => undefined));
      const asked = askWindowHost(host, sessionId);
      const pending = asked.inspect();
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toBeNull();
      await expect(asked.transcripts(query)).resolves.toBeNull();
      expect(mockConsumer.open).toHaveBeenCalledTimes(1);
      asked.doneAsking();
      expect(mockConsumer.close).toHaveBeenCalledTimes(1);
      expect(mockLease.release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a host this device is not connected to is not waited on", async () => {
    mockLease.shared.transport.state = "connecting";
    try {
      const asked = askWindowHost(host, sessionId);
      await expect(asked.inspect()).resolves.toBeNull();
      await expect(asked.transcripts(query)).resolves.toBeNull();
      asked.doneAsking();
      expect(mockCreateConsumer).not.toHaveBeenCalled();
      expect(mockLease.release).toHaveBeenCalledTimes(1);
    } finally {
      mockLease.shared.transport.state = "ready";
    }
  });

  test("a failed question is no answer", async () => {
    mockConsumer.inspectConversation.mockImplementation(async () => {
      throw new Error("pair_required");
    });
    mockConsumer.agentTranscripts.mockImplementation(async () => {
      throw new Error("unsupported_operation");
    });
    const asked = askWindowHost(host, sessionId);
    await expect(asked.inspect()).resolves.toBeNull();
    await expect(asked.transcripts(query)).resolves.toBeNull();
    asked.doneAsking();
    expect(mockConsumer.close).toHaveBeenCalledTimes(1);
  });

  test("nothing is asked once the restart is done asking", async () => {
    const asked = askWindowHost(host, sessionId);
    asked.doneAsking();
    await expect(asked.inspect()).resolves.toBeNull();
    expect(mockRetain).not.toHaveBeenCalled();
  });
});
