import { describe, expect, test } from "bun:test";
import type { StreamV2Handlers } from "@/lib/hostControl";
import { BulkGate, CarryError, carryConversation } from "./carrier";
import { FakeHost } from "./fakes";

type Open = (
  operation: string,
  payload: Record<string, unknown>,
  handlers: StreamV2Handlers,
) => Promise<{ stream_id: string }>;

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const TRANSFER = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";

function pair(length: number) {
  const source = new FakeHost(SOURCE);
  const target = new FakeHost(TARGET);
  const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
  source.conversations.set(CONVERSATION, { cwd: "/home/me/code/spawn", bytes });
  source.windows.set(SESSION, { conversationId: CONVERSATION, running: true });
  return { source, target, bytes, sourceChannel: source.client(), targetChannel: target.client() };
}

function request(
  source: ReturnType<FakeHost["client"]>,
  target: ReturnType<FakeHost["client"]>,
  extra: Partial<Parameters<typeof carryConversation>[0]> = {},
) {
  return {
    source,
    target,
    sourceHostId: SOURCE,
    targetHostId: TARGET,
    transferId: TRANSFER,
    conversationId: CONVERSATION,
    sessionId: SESSION,
    sourceCwd: "/home/me/code/spawn",
    targetCwd: "/Users/me/code/spawn",
    fromSequence: 0,
    knownLength: null,
    ...extra,
  };
}

describe("carryConversation", () => {
  test("the target is never sent past its window, and the source is acknowledged at least every half window", async () => {
    const { source, target, bytes, sourceChannel, targetChannel } = pair(8 * 100 + 5);
    let outstanding = 0;
    let most = 0;
    let acked = 0;
    let sent = 0;
    const send = targetChannel.sendChunkV2.bind(targetChannel);
    targetChannel.sendChunkV2 = (streamId, sequence, chunk) => {
      sent = sequence + 1;
      outstanding = sent - acked;
      most = Math.max(most, outstanding);
      send(streamId, sequence, chunk);
    };
    const handlersOf: Open = targetChannel.openStreamV2.bind(targetChannel);
    const tracked: Open = (operation, payload, handlers) =>
      handlersOf(operation, payload, {
        ...handlers,
        ack: (sequence) => {
          acked = sequence;
          handlers.ack?.(sequence);
        },
      });
    targetChannel.openStreamV2 = tracked as typeof targetChannel.openStreamV2;
    const result = await carryConversation(request(sourceChannel, targetChannel));
    expect(result.length).toBe(bytes.byteLength);
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(most).toBeLessThanOrEqual(16);
    const acks = sourceChannel.sent
      .filter((frame) => frame.type === "stream.ack")
      .map((frame) => Number(frame.values.sequence));
    expect(acks.at(-1)).toBe(101);
    let previous = 0;
    for (const ack of acks) {
      expect(ack).toBeGreaterThan(previous);
      previous = ack;
    }
    expect(source.sentChunks).toBe(101);
  });

  test("the target's end carries the source's digest", async () => {
    const { sourceChannel, targetChannel } = pair(30);
    const result = await carryConversation(request(sourceChannel, targetChannel));
    const end = targetChannel.sent.find((frame) => frame.type === "stream.end");
    expect(end?.values.sha256).toBe(result.sha256);
    expect(result.result.cwd).toBe("/Users/me/code/spawn");
  });

  test("a full bulk gate holds the device's writes until the connection drains", async () => {
    const { sourceChannel, targetChannel } = pair(64);
    let buffered = 100 * 1024;
    targetChannel.bufferedAmount = () => buffered;
    const gate = new BulkGate(64 * 1024, 2);
    const carrying = carryConversation(request(sourceChannel, targetChannel, { gate }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(targetChannel.sent.filter((frame) => frame.type === "stream.chunk")).toHaveLength(0);
    buffered = 0;
    await carrying;
    expect(targetChannel.sent.filter((frame) => frame.type === "stream.chunk")).toHaveLength(8);
  });

  test("the gate is one per connection: two channels to a host share the watermark", async () => {
    const gate = new BulkGate(64 * 1024, 1);
    const one = { bufferedAmount: () => 40 * 1024, waitForBuffered: async () => {} };
    const two = { bufferedAmount: () => 40 * 1024, waitForBuffered: async () => {} };
    gate.register(TARGET, one);
    const unregister = gate.register(TARGET, two);
    expect(gate.buffered(TARGET)).toBe(80 * 1024);
    let passed = false;
    const waiting = gate.wait(TARGET).then(() => {
      passed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passed).toBe(false);
    unregister();
    await waiting;
    expect(passed).toBe(true);
  });

  test("an abort cancels both streams and rejects as an abort", async () => {
    const { sourceChannel, targetChannel } = pair(8 * 500);
    const controller = new AbortController();
    const carrying = carryConversation(
      request(sourceChannel, targetChannel, { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(carrying).rejects.toMatchObject({ name: "AbortError" });
    expect(sourceChannel.streams.size).toBe(0);
    expect(targetChannel.streams.size).toBe(0);
  });

  test("an abort while the export opens: its answer is still taken, its stream cancelled, the channel kept", async () => {
    const { source, sourceChannel, targetChannel } = pair(8 * 40);
    const controller = new AbortController();
    const declared: number[] = [];
    // The cancel lands while the source's retire runs, before its answer.
    source.onWindowStopped = () => controller.abort();
    const carrying = carryConversation(
      request(sourceChannel, targetChannel, {
        signal: controller.signal,
        onExported: (declaration) => declared.push(declaration.length),
      }),
    );
    await expect(carrying).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The retire ran and said so; its stream was cancelled, not orphaned.
    expect(declared).toEqual([8 * 40]);
    expect(sourceChannel.lost).toBe(false);
    expect(sourceChannel.streams.size).toBe(0);
  });

  test("a frame sent on a channel that has gone is a lost connection, not a failed copy", async () => {
    const { target, sourceChannel, targetChannel } = pair(8 * 40);
    target.faults.throwOnSendAfter = 5;
    await expect(carryConversation(request(sourceChannel, targetChannel))).rejects.toMatchObject({
      side: "target",
      code: "connection_lost",
      lost: true,
      stage: "pump",
    });
  });

  test("a source that breaks the order is refused", async () => {
    const { sourceChannel, targetChannel } = pair(40);
    const open: Open = sourceChannel.openStreamV2.bind(sourceChannel);
    const shifted: Open = (operation, payload, handlers) =>
      open(operation, payload, {
        ...handlers,
        chunk: (sequence, bytes) => handlers.chunk?.(sequence + 1, bytes),
      });
    sourceChannel.openStreamV2 = shifted as typeof sourceChannel.openStreamV2;
    const carrying = carryConversation(request(sourceChannel, targetChannel));
    await expect(carrying).rejects.toBeInstanceOf(CarryError);
    await expect(carrying).rejects.toMatchObject({ side: "source", code: "invalid_stream" });
  });

  test("a refused export names the source and the export stage", async () => {
    const { source, sourceChannel, targetChannel } = pair(40);
    source.heldElsewhere.add(CONVERSATION);
    await expect(carryConversation(request(sourceChannel, targetChannel))).rejects.toMatchObject({
      side: "source",
      stage: "export",
      code: "conversation_live_elsewhere",
      lost: false,
    });
  });

  test("a resume whose source declares another length is refused", async () => {
    const { sourceChannel, targetChannel } = pair(40);
    await expect(
      carryConversation(request(sourceChannel, targetChannel, { knownLength: 41 })),
    ).rejects.toMatchObject({ code: "resume_mismatch" });
  });

  test("silence from both hosts is a lost carry", async () => {
    const { sourceChannel, targetChannel } = pair(40);
    sourceChannel.openStreamV2 = async () =>
      ({
        stream_id: "quiet",
        length: 40,
        sha256: null,
        window: 16,
        next_sequence: 0,
      }) as never;
    await expect(
      carryConversation(request(sourceChannel, targetChannel, { silenceMs: 20 })),
    ).rejects.toMatchObject({ code: "connection_lost", lost: true });
  });
});
