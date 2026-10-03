import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import { inspectWindowConversation } from "@/terminal/transport/inspect-conversation";

const answer: ConversationInspection = {
  agent: "claude-code",
  conversation_id: "4e0b4642-0972-40ac-9a18-61d542276b76",
  state: "idle",
  cli_version: "2.1.288",
  live_elsewhere: false,
  source: "registry",
};

const mockConsumer = {
  open: jest.fn(async () => undefined),
  close: jest.fn(),
  hasCapability: jest.fn((operation: string) => operation === "conv.v1"),
  inspectConversation: jest.fn(async () => answer),
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
  mockConsumer.hasCapability.mockImplementation((operation: string) => operation === "conv.v1");
  mockConsumer.inspectConversation.mockImplementation(async () => answer);
});

describe("inspectWindowConversation", () => {
  test("asks on a consumer channel of the retained connection, never taking its seat", async () => {
    await expect(inspectWindowConversation(host, sessionId)).resolves.toEqual(answer);
    expect(mockRetain).toHaveBeenCalledWith(host, false);
    expect(mockCreateConsumer).toHaveBeenCalledWith(
      { ...host, bridge: mockLease.shared.bridge },
      mockLease.shared.transport,
    );
    expect(mockConsumer.inspectConversation).toHaveBeenCalledWith(sessionId, { timeoutMs: 4_000 });
    expect(mockConsumer.close).toHaveBeenCalledTimes(1);
    expect(mockLease.release).toHaveBeenCalledTimes(1);
  });

  test("a host without conv.v1 is not asked", async () => {
    mockConsumer.hasCapability.mockImplementation(() => false);
    await expect(inspectWindowConversation(host, sessionId)).resolves.toBeNull();
    expect(mockConsumer.inspectConversation).not.toHaveBeenCalled();
    expect(mockLease.release).toHaveBeenCalledTimes(1);
  });

  test("a connection that never opens is no answer, and is let go", async () => {
    jest.useFakeTimers();
    try {
      mockConsumer.open.mockImplementation(() => new Promise<undefined>(() => undefined));
      const pending = inspectWindowConversation(host, sessionId);
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toBeNull();
      expect(mockConsumer.close).toHaveBeenCalledTimes(1);
      expect(mockLease.release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a host this device is not connected to is not waited on", async () => {
    mockLease.shared.transport.state = "connecting";
    try {
      await expect(inspectWindowConversation(host, sessionId)).resolves.toBeNull();
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
    await expect(inspectWindowConversation(host, sessionId)).resolves.toBeNull();
    expect(mockConsumer.close).toHaveBeenCalledTimes(1);
  });
});
