/** The channel operations used by terminal and host protocols, locally or in another tab. */
export type DaemonChannel = Pick<
  RTCDataChannel,
  | "label"
  | "readyState"
  | "binaryType"
  | "bufferedAmount"
  | "bufferedAmountLowThreshold"
  | "onopen"
  | "onclose"
  | "onerror"
  | "onmessage"
  | "onbufferedamountlow"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;

export type ChannelBytes = string | ArrayBuffer;
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_EARLY_RECEIVE_BYTES = 2 * 1024 * 1024;

/** A bounded channel proxy. Acknowledgements release queue credit, never imply a command executed. */
export class RemoteDaemonChannel extends EventTarget implements DaemonChannel {
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: RTCDataChannel["onopen"] = null;
  onclose: RTCDataChannel["onclose"] = null;
  onerror: RTCDataChannel["onerror"] = null;
  onmessage: RTCDataChannel["onmessage"] = null;
  onbufferedamountlow: RTCDataChannel["onbufferedamountlow"] = null;
  private sequence = 0;
  private pending = new Map<number, number>();
  private sendTail = Promise.resolve();
  private earlyReceive: ChannelBytes[] = [];
  private earlyReceiveBytes = 0;
  private drainingEarlyReceive = false;

  constructor(
    readonly label: string,
    private readonly dispatch: (
      event: { type: "send"; sequence: number; data: ChannelBytes } | { type: "close" },
    ) => void,
  ) {
    super();
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.readyState !== "open")
      throw new DOMException("Channel is not open", "InvalidStateError");
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data instanceof Blob
          ? data.size
          : data.byteLength;
    if (
      size > 64 * 1024 ||
      this.bufferedAmount + size > MAX_QUEUED_BYTES ||
      this.pending.size >= 1024
    ) {
      throw new DOMException("Channel send queue is full", "OperationError");
    }
    const sequence = ++this.sequence;
    const copy =
      typeof data === "string" || data instanceof Blob
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.pending.set(sequence, size);
    this.bufferedAmount += size;
    this.sendTail = this.sendTail
      .then(async () => {
        const bytes = copy instanceof Blob ? await copy.arrayBuffer() : copy;
        if (this.readyState !== "open") return;
        this.dispatch({ type: "send", sequence, data: bytes });
      })
      .catch(() => this.close());
  }

  acknowledge(sequence: number): void {
    const size = this.pending.get(sequence);
    if (size === undefined) return;
    this.pending.delete(sequence);
    const before = this.bufferedAmount;
    this.bufferedAmount -= size;
    if (
      before > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.emit("bufferedamountlow");
    }
  }

  opened(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.drainingEarlyReceive = true;
    try {
      this.emit("open");
      while (this.readyState === "open" && this.earlyReceive.length > 0) {
        const data = this.earlyReceive.shift();
        if (data === undefined) break;
        this.earlyReceiveBytes -= this.receiveSize(data);
        this.deliver(data);
      }
    } finally {
      this.drainingEarlyReceive = false;
    }
  }

  receive(data: ChannelBytes): void {
    if (this.readyState === "closed") return;
    // Native RTC can deliver the daemon's ready frame before its queued open
    // event. Dropping that frame stalls bootstrap until the connect timeout.
    // Preserve ordering without declaring the channel or session ready early.
    if (this.readyState === "connecting" || this.drainingEarlyReceive) {
      const size = this.receiveSize(data);
      if (
        this.earlyReceiveBytes + size > MAX_EARLY_RECEIVE_BYTES ||
        this.earlyReceive.length >= 1024
      ) {
        this.close();
        return;
      }
      this.earlyReceive.push(data);
      this.earlyReceiveBytes += size;
      return;
    }
    this.deliver(data);
  }

  private receiveSize(data: ChannelBytes): number {
    return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  }

  private deliver(data: ChannelBytes): void {
    const event = new MessageEvent("message", { data });
    this.onmessage?.call(this as unknown as RTCDataChannel, event);
    this.dispatchEvent(event);
  }

  retired(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.pending.clear();
    this.earlyReceive.splice(0);
    this.earlyReceiveBytes = 0;
    this.bufferedAmount = 0;
    this.emit("close");
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.dispatch({ type: "close" });
    this.retired();
  }

  private emit(type: "open" | "close" | "bufferedamountlow"): void {
    const event = new Event(type);
    this[`on${type}`]?.call(this as unknown as RTCDataChannel, event);
    this.dispatchEvent(event);
  }
}

/** Round-robin sends keep one producer from filling every shared SCTP queue. */
export class DaemonSendScheduler {
  private queues = new Map<RTCDataChannel, Array<{ data: ChannelBytes; done: () => void }>>();
  private bytes = new Map<RTCDataChannel, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private scheduled = false;

  enqueue(channel: RTCDataChannel, data: ChannelBytes, done: () => void): void {
    const size =
      typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    const queued = this.bytes.get(channel) ?? 0;
    if (
      this.stopped ||
      size > 64 * 1024 ||
      queued + size > MAX_QUEUED_BYTES ||
      (this.queues.get(channel)?.length ?? 0) >= 1024
    ) {
      throw new Error("Channel send queue is full");
    }
    const queue = this.queues.get(channel) ?? [];
    queue.push({ data, done });
    this.queues.set(channel, queue);
    this.bytes.set(channel, queued + size);
    this.schedule();
  }

  remove(channel: RTCDataChannel): void {
    this.queues.delete(channel);
    this.bytes.delete(channel);
  }
  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queues.clear();
    this.bytes.clear();
  }
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    // Message delivery must not wait for a background tab's throttled timer.
    // Timers are needed only to revisit actual native backpressure.
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) this.drain();
    });
  }
  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Input is always serviced before bulk traffic in this scheduling round.
    const entries = [...this.queues].sort(
      ([a], [b]) =>
        Number(b.label.startsWith("spawn.pty/")) - Number(a.label.startsWith("spawn.pty/")),
    );
    for (const [channel, queue] of entries) {
      if (channel.readyState !== "open") {
        this.remove(channel);
        continue;
      }
      if (channel.bufferedAmount > 32 * 1024) continue;
      const item = queue.shift();
      if (!item) {
        this.remove(channel);
        continue;
      }
      try {
        if (typeof item.data === "string") channel.send(item.data);
        else channel.send(item.data);
        const size =
          typeof item.data === "string"
            ? new TextEncoder().encode(item.data).byteLength
            : item.data.byteLength;
        this.bytes.set(channel, (this.bytes.get(channel) ?? 0) - size);
        item.done();
      } catch {
        this.remove(channel);
        channel.close();
      }
      if (queue.length === 0) this.remove(channel);
    }
    if (this.queues.size)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, 4);
  }
}
