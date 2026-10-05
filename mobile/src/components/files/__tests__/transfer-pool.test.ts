import { createTransferChannels } from "@/components/files/transfer-pool";
import type { TransferHost } from "@/data/stores/transfers";
import type { HostTransport, TransportState } from "@/terminal/transport/types";

const host: TransferHost = { id: "dream", name: "dream", publicKey: "k", os: "linux" };

function transport(state: TransportState): HostTransport {
  return {
    hostId: host.id,
    state,
    open: async () => undefined,
    close: () => undefined,
    request: (async () => undefined) as HostTransport["request"],
    cancel: () => undefined,
    on: (() => () => undefined) as HostTransport["on"],
  };
}

describe("the transfer queue's channels", () => {
  test("a transfer waits for its host's channel to be ready", async () => {
    const channels = createTransferChannels();
    const waiting = channels.pool.acquire(host, new AbortController().signal);
    const channel = transport("connecting");
    channels.attach(host.id, channel);
    channels.setState(host.id, "ready");
    await expect(waiting).resolves.toBe(channel);
    // Once ready, the next one has it at once.
    await expect(channels.pool.acquire(host, new AbortController().signal)).resolves.toBe(channel);
  });

  test("a channel that fails says why", async () => {
    const channels = createTransferChannels();
    channels.attach(host.id, transport("connecting"));
    const waiting = channels.pool.acquire(host, new AbortController().signal);
    channels.setError(host.id, {
      code: "device_not_trusted",
      message: "Approve this device",
      retryable: false,
    });
    channels.setState(host.id, "failed");
    await expect(waiting).rejects.toMatchObject({ code: "device_not_trusted" });
  });

  test("a channel that fails and may come back is the host out of reach, not a refusal", async () => {
    const channels = createTransferChannels();
    channels.attach(host.id, transport("connecting"));
    const waiting = channels.pool.acquire(host, new AbortController().signal);
    channels.setError(host.id, { code: "ice_failed", message: "No route", retryable: true });
    channels.setState(host.id, "failed");
    // The engine meets this with a pause and Resume, not a failure per file.
    await expect(waiting).rejects.toMatchObject({ code: "host_unreachable" });
  });

  test("a host that never answers is given up on, and a cancelled wait stops at once", async () => {
    jest.useFakeTimers();
    try {
      const channels = createTransferChannels(1_000);
      const waiting = channels.pool.acquire(host, new AbortController().signal);
      jest.advanceTimersByTime(1_000);
      await expect(waiting).rejects.toMatchObject({ code: "host_unreachable" });

      const controller = new AbortController();
      const cancelled = channels.pool.acquire(host, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a channel taken away is not handed out", async () => {
    const channels = createTransferChannels(50);
    channels.attach(host.id, transport("ready"));
    channels.detach(host.id);
    await expect(channels.pool.acquire(host, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unreachable",
    });
  });
});
