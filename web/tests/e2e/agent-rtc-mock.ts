import type { Page, WebSocketRoute } from "@playwright/test";

type Capture = string | Buffer;

export async function installAgentRtcMock(
  page: Page,
  captured: Capture[],
  options: {
    history?: string;
    secondHistory?: string;
    control?: { owner: boolean; cols: number; rows: number; viewers: number };
    openChannels?: boolean;
    sendReady?: boolean;
    autoSnapshot?: boolean;
    uploadFinalAction?: "complete" | "disconnect" | "hold";
    stallUploadBackpressure?: boolean;
    /** When set, replay responses carry this committed-history anchor
     *  (epoch + historyOffset), putting the client in delta mode. */
    historyEpoch?: string;
    historyOffset?: number;
    onPtyInput?: (bytes: Buffer) => void | Promise<void>;
    onUpload?: (upload: {
      name: string;
      mimeType: string;
      destination: "attachments" | "cwd";
      bytes: Buffer;
    }) => void | Promise<void>;
  } = {},
) {
  await page.exposeFunction("__spawnRecordRtcTestMessage", async (label: string, value: string) => {
    const capturedValue = label === "spawn.pty" ? Buffer.from(value, "base64") : value;
    captured.push(capturedValue);
    if (label === "spawn.pty" && Buffer.isBuffer(capturedValue)) {
      await options.onPtyInput?.(capturedValue);
    }
  });
  await page.exposeFunction(
    "__spawnRecordRtcTestUpload",
    async (name: string, mimeType: string, destination: string, value: string) => {
      await options.onUpload?.({
        name,
        mimeType,
        destination: destination === "cwd" ? "cwd" : "attachments",
        bytes: Buffer.from(value, "base64"),
      });
    },
  );
  await page.addInitScript(
    ({
      history,
      secondHistory,
      control,
      openChannels,
      sendReady,
      autoSnapshot,
      uploadFinalAction,
      stallUploadBackpressure,
      historyEpoch,
      historyOffset,
    }) => {
      const encoder = new TextEncoder();
      const state = {
        history,
        secondHistory,
        control,
        openChannels,
        sendReady,
        autoSnapshot,
        uploadFinalAction,
        stallUploadBackpressure,
        historyEpoch,
        historyOffset: historyOffset ?? 0,
        connections: 0,
        activePtyChannel: null as FakeDataChannel | null,
        channels: new Map<string, FakeDataChannel>(),
        ptyChannels: [] as FakeDataChannel[],
        pendingReplay: [] as Array<{ channel: FakeDataChannel; request: Record<string, unknown> }>,
        uploads: new Map<
          string,
          { request: Record<string, unknown>; nextSequence: number; chunks: Uint8Array[] }
        >(),
        heldUploadCompletes: [] as Array<{ channel: FakeDataChannel; message: string }>,
        ptyOffset: 0,
      };

      function uuidBytes(value: string) {
        const hex = value.replaceAll("-", "");
        const bytes = new Uint8Array(16);
        for (let index = 0; index < 16; index += 1) {
          bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        }
        return bytes;
      }

      function bytesUuid(bytes: Uint8Array) {
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
          16,
          20,
        )}-${hex.slice(20)}`;
      }

      function ctlChunk(requestId: string, payload: Uint8Array) {
        const frame = new Uint8Array(28 + payload.length);
        frame.set(encoder.encode("SPCT"), 0);
        frame[4] = 1;
        frame[5] = 1;
        frame[6] = 1;
        frame.set(uuidBytes(requestId), 8);
        frame.set(payload, 28);
        return frame.buffer;
      }

      function replyReplay(
        channel: FakeDataChannel,
        request: Record<string, unknown>,
        text: string,
      ) {
        const requestId = String(request.request_id);
        const operation = String(request.operation);
        const payload = encoder.encode(text);
        channel.receive(
          JSON.stringify({
            version: 1,
            kind: "response",
            request_id: requestId,
            operation,
            ok: true,
            plain: false,
            pty_offset: state.ptyOffset,
            total_bytes: payload.length,
            chunks: payload.length === 0 ? 0 : 1,
            ...(state.historyEpoch
              ? { history_epoch: state.historyEpoch, history_offset: state.historyOffset }
              : {}),
          }),
        );
        if (payload.length > 0) channel.receive(ctlChunk(requestId, payload));
      }

      class FakeDataChannel {
        label: string;
        ordered: boolean;
        maxPacketLifeTime: number | null;
        maxRetransmits: number | null;
        readyState: RTCDataChannelState = "connecting";
        binaryType = "arraybuffer";
        bufferedAmount = 0;
        bufferedAmountLowThreshold = 0;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          const listeners =
            this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
          listeners.add(listener);
          this.listeners.set(type, listeners);
        }
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          this.listeners.get(type)?.delete(listener);
        }

        constructor(label: string, init?: RTCDataChannelInit) {
          this.label = label;
          this.ordered = init?.ordered ?? true;
          this.maxPacketLifeTime = init?.maxPacketLifeTime ?? null;
          this.maxRetransmits = init?.maxRetransmits ?? null;
          if (label === "spawn.ctl" && state.stallUploadBackpressure) {
            this.bufferedAmount = 2 * 1024 * 1024;
          }
          state.channels.set(label, this);
          if (label === "spawn.pty") state.ptyChannels.push(this);
        }

        send(value: string | ArrayBuffer | ArrayBufferView | Blob) {
          let capture: string;
          if (typeof value === "string") {
            capture = value;
          } else {
            const bytes =
              value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : ArrayBuffer.isView(value)
                  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                  : new Uint8Array();
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            capture = btoa(binary);
          }
          void (
            window as unknown as {
              __spawnRecordRtcTestMessage: (label: string, value: string) => Promise<void>;
            }
          ).__spawnRecordRtcTestMessage(this.label, capture);

          if (this.label !== "spawn.ctl") return;
          if (typeof value !== "string") {
            const bytes =
              value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : ArrayBuffer.isView(value)
                  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                  : new Uint8Array();
            if (
              bytes.length < 29 ||
              String.fromCharCode(...bytes.subarray(0, 4)) !== "SPCT" ||
              bytes[4] !== 1 ||
              bytes[5] !== 2
            ) {
              return;
            }
            const uploadId = bytesUuid(bytes.subarray(8, 24));
            const upload = state.uploads.get(uploadId);
            if (!upload) return;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const sequence = view.getUint32(24, true);
            if (sequence !== upload.nextSequence) return;
            upload.chunks.push(bytes.slice(28));
            upload.nextSequence += 1;
            if ((view.getUint16(6, true) & 1) === 0) return;
            const totalBytes = Number(upload.request.total_bytes);
            const merged = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of upload.chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            if (offset !== totalBytes) return;
            state.uploads.delete(uploadId);
            let binary = "";
            for (const byte of merged) binary += String.fromCharCode(byte);
            void (
              window as unknown as {
                __spawnRecordRtcTestUpload: (
                  name: string,
                  mimeType: string,
                  destination: string,
                  value: string,
                ) => Promise<void>;
              }
            ).__spawnRecordRtcTestUpload(
              String(upload.request.name),
              String(upload.request.mime_type),
              String(upload.request.destination),
              btoa(binary),
            );
            const completion = JSON.stringify({
              version: 1,
              kind: "response",
              request_id: uploadId,
              operation: "upload_complete",
              ok: true,
              state: "complete",
              path: `/Users/tester/projects/spawn/${String(upload.request.name)}`,
              total_bytes: totalBytes,
              sha256: upload.request.sha256,
            });
            if (state.uploadFinalAction === "disconnect") {
              queueMicrotask(() => this.close());
              return;
            }
            if (state.uploadFinalAction === "hold") {
              state.heldUploadCompletes.push({ channel: this, message: completion });
              return;
            }
            queueMicrotask(() => this.receive(completion));
            return;
          }
          let request: Record<string, unknown>;
          try {
            request = JSON.parse(value);
          } catch {
            return;
          }
          if (request.kind !== "request") return;
          const operation = String(request.operation);
          if (operation === "upload_start") {
            const uploadId = String(request.request_id);
            const existing = state.uploads.get(uploadId);
            if (!existing) {
              state.uploads.set(uploadId, { request, nextSequence: 0, chunks: [] });
            }
            const active = state.uploads.get(uploadId);
            queueMicrotask(() =>
              this.receive(
                JSON.stringify({
                  version: 1,
                  kind: "response",
                  request_id: uploadId,
                  operation: "upload_start",
                  ok: true,
                  state: "ready",
                  next_sequence: active?.nextSequence ?? 0,
                  received_bytes: active?.chunks.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0,
                }),
              ),
            );
          } else if (operation === "upload_cancel") {
            state.uploads.delete(String(request.upload_id));
            queueMicrotask(() =>
              this.receive(
                JSON.stringify({
                  version: 1,
                  kind: "response",
                  request_id: request.request_id,
                  operation,
                  ok: true,
                }),
              ),
            );
          } else if (operation === "history") {
            const selected = state.connections === 1 ? state.history : state.secondHistory;
            queueMicrotask(() => replyReplay(this, request, selected));
          } else if (operation === "snapshot") {
            if (state.autoSnapshot) {
              queueMicrotask(() => replyReplay(this, request, state.history));
            } else {
              state.pendingReplay.push({ channel: this, request });
            }
          } else {
            queueMicrotask(() => {
              this.receive(
                JSON.stringify({
                  version: 1,
                  kind: "response",
                  request_id: request.request_id,
                  operation,
                  ok: true,
                }),
              );
              if (operation === "take_control") {
                this.receive(
                  JSON.stringify({
                    version: 1,
                    kind: "event",
                    event: "display_state",
                    ...state.control,
                    owner: true,
                  }),
                );
              }
            });
          }
        }

        close() {
          if (this.readyState === "closed") return;
          this.readyState = "closed";
          this.onclose?.();
        }

        open() {
          this.readyState = "open";
          this.onopen?.();
          if (this.label === "spawn.ctl") {
            if (state.sendReady) {
              this.receive(
                JSON.stringify({
                  version: 1,
                  kind: "event",
                  event: "ready",
                  upload_capability: "00112233-4455-4677-8899-aabbccddeeff",
                  agent_generation: 1,
                  upload_max_bytes: 20 * 1024 * 1024,
                  upload_chunk_bytes: 48 * 1024,
                }),
              );
            }
            this.receive(
              JSON.stringify({
                version: 1,
                kind: "event",
                event: "display_state",
                ...state.control,
              }),
            );
          }
        }

        receive(data: string | ArrayBuffer) {
          this.onmessage?.(new MessageEvent("message", { data }));
        }

        drainBufferedAmount() {
          this.bufferedAmount = 0;
          const event = new Event("bufferedamountlow");
          for (const listener of this.listeners.get("bufferedamountlow") ?? []) {
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
          }
          this.listeners.delete("bufferedamountlow");
        }
      }

      class FakePeerConnection {
        localDescription: RTCSessionDescriptionInit | null = null;
        remoteDescription: RTCSessionDescriptionInit | null = null;
        connectionState: RTCPeerConnectionState = "new";
        iceConnectionState: RTCIceConnectionState = "new";
        onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        channels: FakeDataChannel[] = [];

        constructor() {
          state.connections += 1;
        }

        createDataChannel(label: string, init?: RTCDataChannelInit) {
          const channel = new FakeDataChannel(label, init);
          this.channels.push(channel);
          return channel as unknown as RTCDataChannel;
        }

        async createOffer() {
          return { type: "offer" as const, sdp: "v=0\r\nmock-offer" };
        }

        async setLocalDescription(description: RTCSessionDescriptionInit) {
          this.localDescription = description;
        }

        async setRemoteDescription(description: RTCSessionDescriptionInit) {
          this.remoteDescription = description;
          if (!state.openChannels) return;
          this.connectionState = "connected";
          this.iceConnectionState = "connected";
          for (const channel of this.channels) channel.open();
          state.activePtyChannel =
            this.channels.find((channel) => channel.label === "spawn.pty") ?? null;
          this.onconnectionstatechange?.();
          this.oniceconnectionstatechange?.();
        }

        async addIceCandidate() {}
        async getStats() {
          return new Map();
        }
        close() {
          this.connectionState = "closed";
          if (state.activePtyChannel && this.channels.includes(state.activePtyChannel)) {
            state.activePtyChannel = null;
          }
          for (const channel of this.channels) channel.close();
        }
      }

      (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection =
        FakePeerConnection as unknown as typeof RTCPeerConnection;
      (
        window as unknown as {
          __spawnRtcTest: {
            ptyReady: () => boolean;
            sendPty: (text: string, connectionIndex?: number) => boolean;
            replyReplay: (text: string) => void;
            setControl: (next: typeof control) => void;
            channelReliability: (label: string) => {
              ordered: boolean;
              maxPacketLifeTime: number | null;
              maxRetransmits: number | null;
            } | null;
            releaseUploadBackpressure: () => void;
            releaseHeldUploadCompletion: () => void;
            queueActiveUploadCompletion: () => boolean;
            replaceRtcGeneration: () => void;
            sendHistoryDelta: (epoch: string, offset: number, text: string) => void;
            sendHistoryWipe: (epoch: string) => void;
            sendHistoryGap: () => void;
          };
        }
      ).__spawnRtcTest = {
        ptyReady() {
          return (
            state.activePtyChannel?.readyState === "open" &&
            state.activePtyChannel.onmessage !== null
          );
        },
        sendPty(text, connectionIndex) {
          const bytes = encoder.encode(text);
          const channel =
            connectionIndex == null ? state.activePtyChannel : state.ptyChannels[connectionIndex];
          if (!channel) return false;
          state.ptyOffset += bytes.length;
          channel.receive(bytes.buffer);
          return true;
        },
        replyReplay(text) {
          const pending = state.pendingReplay.shift();
          if (pending) replyReplay(pending.channel, pending.request, text);
        },
        setControl(next) {
          state.control = next;
          state.channels
            .get("spawn.ctl")
            ?.receive(
              JSON.stringify({ version: 1, kind: "event", event: "display_state", ...next }),
            );
        },
        channelReliability(label) {
          const channel = state.channels.get(label);
          return channel
            ? {
                ordered: channel.ordered,
                maxPacketLifeTime: channel.maxPacketLifeTime,
                maxRetransmits: channel.maxRetransmits,
              }
            : null;
        },
        releaseUploadBackpressure() {
          state.channels.get("spawn.ctl")?.drainBufferedAmount();
        },
        releaseHeldUploadCompletion() {
          const held = state.heldUploadCompletes.shift();
          if (held) held.channel.receive(held.message);
        },
        queueActiveUploadCompletion() {
          const active = state.uploads.entries().next().value as
            | [string, { request: Record<string, unknown> }]
            | undefined;
          const channel = state.channels.get("spawn.ctl");
          if (!active || !channel) return false;
          const [uploadId, upload] = active;
          channel.receive(
            JSON.stringify({
              version: 1,
              kind: "response",
              request_id: uploadId,
              operation: "upload_complete",
              ok: true,
              state: "complete",
              path: `/Users/tester/projects/spawn/${String(upload.request.name)}`,
              total_bytes: upload.request.total_bytes,
              sha256: upload.request.sha256,
            }),
          );
          return true;
        },
        replaceRtcGeneration() {
          state.channels.get("spawn.ctl")?.close();
        },
        sendHistoryDelta(epoch, offset, text) {
          const bytes = encoder.encode(text);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          state.historyOffset = offset + bytes.length;
          state.channels.get("spawn.ctl")?.receive(
            JSON.stringify({
              version: 1,
              kind: "event",
              event: "history_delta",
              history_epoch: epoch,
              history_offset: offset,
              data: btoa(binary),
            }),
          );
        },
        sendHistoryWipe(epoch) {
          state.historyEpoch = epoch;
          state.historyOffset = 0;
          state.channels.get("spawn.ctl")?.receive(
            JSON.stringify({
              version: 1,
              kind: "event",
              event: "history_wipe",
              history_epoch: epoch,
            }),
          );
        },
        sendHistoryGap() {
          state.channels
            .get("spawn.ctl")
            ?.receive(JSON.stringify({ version: 1, kind: "event", event: "history_gap" }));
        },
      };
    },
    {
      history: options.history ?? "\u001b[31mRED\u001b[0m\r\n",
      secondHistory: options.secondHistory ?? "after reconnect\r\n",
      control: options.control ?? { owner: true, cols: 100, rows: 30, viewers: 1 },
      openChannels: options.openChannels ?? true,
      sendReady: options.sendReady ?? true,
      autoSnapshot: options.autoSnapshot ?? false,
      uploadFinalAction: options.uploadFinalAction ?? "complete",
      stallUploadBackpressure: options.stallUploadBackpressure ?? false,
      historyEpoch: options.historyEpoch,
      historyOffset: options.historyOffset,
    },
  );
}

export function handleAgentRtcSignal(ws: WebSocketRoute, message: string | Buffer) {
  if (typeof message !== "string") return;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(message);
  } catch {
    return;
  }
  if (frame.type !== "rtc.offer") return;
  const agentId = new URL(ws.url()).searchParams.get("agent_id");
  if (
    frame.agent_id !== agentId ||
    frame.scope_type !== "agent" ||
    frame.scope_id !== agentId ||
    frame.protocol !== "spawn.pty" ||
    frame.protocol_version !== 2
  ) {
    return;
  }
  const binding = {
    session_id: frame.session_id,
    binding_nonce: frame.binding_nonce,
    binding_generation: 1,
    agent_id: agentId,
    scope_type: "agent",
    scope_id: agentId,
    protocol: "spawn.pty",
    protocol_version: 2,
  };
  ws.send(JSON.stringify({ type: "rtc.status", ...binding, status: "negotiating" }));
  ws.send(JSON.stringify({ type: "rtc.answer", ...binding, sdp: "v=0\r\nmock-answer" }));
}

export async function sendPty(page: Page, text: string, connectionIndex?: number) {
  if (connectionIndex === undefined) {
    await page.waitForFunction(() => {
      return (
        window as unknown as {
          __spawnRtcTest?: { ptyReady: () => boolean };
        }
      ).__spawnRtcTest?.ptyReady();
    });
  }
  const delivered = await page.evaluate(
    ({ value, index }) => {
      return (
        window as unknown as {
          __spawnRtcTest: { sendPty: (text: string, connectionIndex?: number) => boolean };
        }
      ).__spawnRtcTest.sendPty(value, index);
    },
    { value: text, index: connectionIndex },
  );
  if (!delivered) throw new Error("RTC mock has no ready spawn.pty channel");
}

export async function replyReplay(page: Page, text: string) {
  await page.evaluate((value) => {
    (
      window as unknown as { __spawnRtcTest: { replyReplay: (text: string) => void } }
    ).__spawnRtcTest.replyReplay(value);
  }, text);
}

export async function sendHistoryDelta(page: Page, epoch: string, offset: number, text: string) {
  await page.evaluate(
    ({ epoch, offset, text }) => {
      (
        window as unknown as {
          __spawnRtcTest: {
            sendHistoryDelta: (epoch: string, offset: number, text: string) => void;
          };
        }
      ).__spawnRtcTest.sendHistoryDelta(epoch, offset, text);
    },
    { epoch, offset, text },
  );
}

export async function sendHistoryWipe(page: Page, epoch: string) {
  await page.evaluate((value) => {
    (
      window as unknown as { __spawnRtcTest: { sendHistoryWipe: (epoch: string) => void } }
    ).__spawnRtcTest.sendHistoryWipe(value);
  }, epoch);
}

export async function setDisplayControl(
  page: Page,
  control: { owner: boolean; cols: number; rows: number; viewers: number },
) {
  await page.evaluate((value) => {
    (
      window as unknown as {
        __spawnRtcTest: { setControl: (next: typeof value) => void };
      }
    ).__spawnRtcTest.setControl(value);
  }, control);
}
