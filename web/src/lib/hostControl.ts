import { buildHostWsUrl } from "@/lib/ws";

export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl";
export const HOST_CONTROL_VERSION = 1;

const HOST_SIGNAL_SUBPROTOCOL = "spawn.host.v1";
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;

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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HostControlRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HostControlClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  reconnectBaseDelayMs?: number;
}

export class HostControlClient {
  private state: HostControlState = "idle";
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private stopped = true;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(state: HostControlState) => void>();

  constructor(
    readonly hostId: string,
    private readonly options: HostControlClientOptions = {},
  ) {}

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
    this.clearConnectDeadline();
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
    if (this.pending.size >= this.maxPendingRequests()) {
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
      const timeoutMs = Math.max(
        1,
        options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
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
    this.clearConnectDeadline();
    this.connectTimer = setTimeout(
      () => {
        this.connectTimer = null;
        this.failRtc();
      },
      Math.max(1, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
    );
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
      this.setState("open");
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.failRtc();
        return;
      }
      if (!isJsonObject(parsed)) {
        this.failRtc();
        return;
      }
      const message = parsed as unknown as SignalMessage;
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
          .catch(() => this.failRtc(message.session_id));
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
        this.failRtc(message.session_id);
      }
    };
    ws.onerror = () => this.setState("error");
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectDeadline();
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
        this.failRtc(sessionId);
      }
    };
    channel.onmessage = (event) => this.handleControlMessage(event.data, sessionId);
    channel.onclose = () => {
      this.failRtc(sessionId);
    };
    channel.onerror = () => {
      this.setState("error");
      this.failRtc(sessionId);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.sessionId !== sessionId) return;
      this.sendSignal({ type: "rtc.offer", session_id: sessionId, sdp: offer.sdp ?? "" });
    } catch {
      this.failRtc(sessionId);
    }
  }

  private handleControlMessage(raw: unknown, sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    if (typeof raw !== "string") {
      this.failRtc(sessionId);
      return;
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_FRAME_BYTES) {
      this.failRtc(sessionId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.failRtc(sessionId);
      return;
    }
    if (!isJsonObject(parsed)) {
      this.failRtc(sessionId);
      return;
    }
    const message = parsed as {
      version?: number;
      type?: string;
      protocol?: string;
      request_id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string };
    };
    if (message.version !== HOST_CONTROL_VERSION) {
      this.failRtc(sessionId);
      return;
    }
    if (message.type === "hello" && message.protocol === HOST_CONTROL_PROTOCOL) {
      this.clearConnectDeadline();
      this.reconnectAttempt = 0;
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
    try {
      this.channel.send(
        JSON.stringify({ version: HOST_CONTROL_VERSION, type: "cancel", request_id: requestId }),
      );
    } catch {
      // Cancellation is best-effort. Timeout/abort must still settle the
      // original request even if the channel failed between those steps.
    }
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
    this.clearConnectDeadline();
    this.reconnectAttempt += 1;
    const delay = Math.min(
      10_000,
      Math.max(1, this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS) *
        this.reconnectAttempt,
    );
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

  private failRtc(expectedSessionId?: string): void {
    if (expectedSessionId !== undefined && this.sessionId !== expectedSessionId) return;
    if (this.sessionId === null && this.reconnectTimer) return;
    this.cleanupRtc(true);
    this.scheduleReconnect();
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private maxPendingRequests(): number {
    const configured = this.options.maxPendingRequests;
    if (configured === undefined || !Number.isFinite(configured)) return MAX_PENDING_REQUESTS;
    return Math.max(0, Math.min(MAX_PENDING_REQUESTS, Math.floor(configured)));
  }

  private setState(state: HostControlState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
