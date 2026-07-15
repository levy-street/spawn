import { buildHostWsUrl } from "@/lib/ws";

export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl";
export const HOST_CONTROL_VERSION = 1;

const HOST_SIGNAL_SUBPROTOCOL = "spawn.host.v1";
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type HostControlState = "idle" | "connecting" | "open" | "ready" | "closed" | "error";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface SignalMetadata {
  scope_type: "host";
  scope_id: string;
  protocol: typeof HOST_CONTROL_PROTOCOL;
  protocol_version: typeof HOST_CONTROL_VERSION;
}

type SignalMessage =
  | ({
      type: "rtc.config";
      enabled: boolean;
      ice_servers?: RTCIceServer[];
      ice_transport_policy?: RTCIceTransportPolicy;
    } & SignalMetadata)
  | ({ type: "rtc.answer"; session_id: string; sdp: string } & SignalMetadata)
  | ({ type: "rtc.candidate"; session_id: string; candidate: RTCIceCandidateInit } & SignalMetadata)
  | ({ type: "rtc.status"; session_id?: string; status: string } & SignalMetadata);

export interface HostControlRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HostControlClient {
  private state: HostControlState = "idle";
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private stopped = true;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(state: HostControlState) => void>();

  constructor(readonly hostId: string) {}

  getState(): HostControlState {
    return this.state;
  }

  subscribe(listener: (state: HostControlState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.openWebSocket();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cleanupRtc(true);
    this.ws?.close(1000, "host control closed");
    this.ws = null;
    this.rejectPending(new Error("Host control connection closed"));
    this.setState("closed");
  }

  request<T = unknown>(
    operation: string,
    payload?: unknown,
    options: HostControlRequestOptions = {},
  ): Promise<T> {
    if (this.state !== "ready" || this.channel?.readyState !== "open") {
      return Promise.reject(new Error("Host control channel is not ready"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Too many pending host control requests"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException("Host control request aborted", "AbortError"));
    }
    const requestId = crypto.randomUUID();
    const frame = JSON.stringify({
      version: HOST_CONTROL_VERSION,
      type: "request",
      request_id: requestId,
      operation,
      ...(payload === undefined ? {} : { payload }),
    });
    if (new TextEncoder().encode(frame).byteLength > MAX_CONTROL_FRAME_BYTES) {
      return Promise.reject(new Error("Host control request is too large"));
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const timer = setTimeout(() => {
        const current = this.finishPending(requestId);
        if (!current) return;
        this.sendCancel(requestId);
        current.reject(new Error("Host control request timed out"));
      }, timeoutMs);
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      if (options.signal) {
        const onAbort = () => {
          if (!this.pending.delete(requestId)) return;
          clearTimeout(timer);
          this.sendCancel(requestId);
          reject(new DOMException("Host control request aborted", "AbortError"));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(requestId, pending);
      try {
        this.channel?.send(frame);
      } catch (error) {
        this.finishPending(requestId);
        reject(error instanceof Error ? error : new Error("Host control send failed"));
      }
    });
  }

  ping(options?: HostControlRequestOptions): Promise<{ pong: true }> {
    return this.request<{ pong: true }>("ping", undefined, options);
  }

  private openWebSocket(): void {
    if (this.stopped) return;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildHostWsUrl(this.hostId), HOST_SIGNAL_SUBPROTOCOL);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("open");
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data) as SignalMessage;
      } catch {
        return;
      }
      if (!this.matchesMetadata(message)) return;
      if (message.type === "rtc.config" && message.enabled) {
        void this.startRtc(
          message.ice_servers ?? [],
          message.ice_transport_policy === "relay" ? "relay" : "all",
        );
      } else if (message.type === "rtc.answer" && message.session_id === this.sessionId) {
        const pc = this.pc;
        if (!pc) return;
        void pc
          .setRemoteDescription({ type: "answer", sdp: message.sdp })
          .then(() => {
            for (const candidate of this.pendingRemoteCandidates.splice(0)) {
              void pc.addIceCandidate(candidate).catch(() => {});
            }
          })
          .catch(() => this.failRtc());
      } else if (message.type === "rtc.candidate" && message.session_id === this.sessionId) {
        if (this.pc?.remoteDescription) {
          void this.pc.addIceCandidate(message.candidate).catch(() => {});
        } else {
          this.pendingRemoteCandidates.push(message.candidate);
        }
      } else if (
        message.type === "rtc.status" &&
        message.session_id === this.sessionId &&
        ["failed", "disabled", "unavailable"].includes(message.status)
      ) {
        this.cleanupRtc(false);
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => this.setState("error");
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.cleanupRtc(false);
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private async startRtc(
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy,
  ): Promise<void> {
    this.cleanupRtc(true);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const sessionId = crypto.randomUUID();
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    const channel = pc.createDataChannel(HOST_CONTROL_PROTOCOL, { ordered: true });
    this.pc = pc;
    this.channel = channel;
    this.sessionId = sessionId;
    this.pendingRemoteCandidates = [];
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.sessionId !== sessionId) return;
      this.sendSignal({
        type: "rtc.candidate",
        session_id: sessionId,
        candidate: event.candidate.toJSON(),
      });
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        this.cleanupRtc(false);
        this.scheduleReconnect();
      }
    };
    channel.onmessage = (event) => this.handleControlMessage(event.data);
    channel.onopen = () => {
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        this.cleanupRtc(true);
        this.scheduleReconnect();
      }, 5_000);
    };
    channel.onclose = () => {
      this.rejectPending(new Error("Host control channel closed"));
      if (!this.stopped) {
        this.setState("open");
        this.scheduleReconnect();
      }
    };
    channel.onerror = () => {
      this.setState("error");
      this.failRtc();
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.sessionId !== sessionId) return;
      this.sendSignal({ type: "rtc.offer", session_id: sessionId, sdp: offer.sdp ?? "" });
    } catch {
      this.cleanupRtc(false);
      this.scheduleReconnect();
    }
  }

  private handleControlMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      this.failRtc();
      return;
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_FRAME_BYTES) {
      this.failRtc();
      return;
    }
    let message: {
      version?: number;
      type?: string;
      protocol?: string;
      request_id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      this.failRtc();
      return;
    }
    if (message.version !== HOST_CONTROL_VERSION) {
      this.failRtc();
      return;
    }
    if (message.type === "hello" && message.protocol === HOST_CONTROL_PROTOCOL) {
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.setState("ready");
      return;
    }
    if (message.type !== "response" || typeof message.request_id !== "string") return;
    const pending = this.finishPending(message.request_id);
    if (!pending) return;
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.code ?? "Host control request failed"));
  }

  private sendSignal(values: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        ...values,
        scope_type: "host",
        scope_id: this.hostId,
        protocol: HOST_CONTROL_PROTOCOL,
        protocol_version: HOST_CONTROL_VERSION,
      }),
    );
  }

  private matchesMetadata(message: SignalMessage): boolean {
    return (
      message.scope_type === "host" &&
      message.scope_id === this.hostId &&
      message.protocol === HOST_CONTROL_PROTOCOL &&
      message.protocol_version === HOST_CONTROL_VERSION
    );
  }

  private sendCancel(requestId: string): void {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(
      JSON.stringify({ version: HOST_CONTROL_VERSION, type: "cancel", request_id: requestId }),
    );
  }

  private finishPending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    return pending;
  }

  private rejectPending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finishPending(requestId)?.reject(error);
    }
  }

  private cleanupRtc(notifyServer: boolean): void {
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (notifyServer && sessionId) this.sendSignal({ type: "rtc.close", session_id: sessionId });
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const channel = this.channel;
    const pc = this.pc;
    this.channel = null;
    this.pc = null;
    this.pendingRemoteCandidates = [];
    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    this.rejectPending(new Error("Host control session ended"));
    if (!this.stopped && this.state === "ready") this.setState("open");
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const ws = this.ws;
      this.ws = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      this.cleanupRtc(false);
      this.openWebSocket();
    }, delay);
  }

  private failRtc(): void {
    this.cleanupRtc(true);
    this.scheduleReconnect();
  }

  private setState(state: HostControlState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
