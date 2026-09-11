import type { AuthTokenSnapshot } from "@/data/api/auth-token";
import { ApiError, reportUnauthenticated } from "@/data/api/client";

export type SocketState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "failed"
  | "unauthenticated";

export interface SocketCloseInfo {
  code: number;
  reason: string;
}

export const SOCKET_TIMING = {
  serverPingMs: 25_000,
  watchdogMs: 80_000,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 15_000,
  jitterMin: 0.7,
  jitterMax: 1.3,
} as const;

const WS_OPEN = 1;
const NORMAL_CLOSE = 1000;
const PROTOCOL_CLOSE = 1002;
const PERMANENT_CLOSE_CODES = new Set([1002, 1009, 4002, 4003]);

type Listener<T> = (value: T) => void;
interface RetirableSocket {
  retire(): void;
}

const SOCKET_REGISTRY = new Set<RetirableSocket>();
const PROTOCOL_REQUIRED_LISTENERS = new Set<() => void>();

export function subscribeProtocolRequired(listener: () => void): () => void {
  PROTOCOL_REQUIRED_LISTENERS.add(listener);
  return () => {
    PROTOCOL_REQUIRED_LISTENERS.delete(listener);
  };
}

function emitProtocolRequired(): void {
  for (const listener of PROTOCOL_REQUIRED_LISTENERS) {
    try {
      listener();
    } catch {
      // One update listener cannot prevent the rest from hearing the refusal.
    }
  }
}

export function retireAll(): void {
  for (const socket of SOCKET_REGISTRY) {
    socket.retire();
  }
}

export interface ReconnectingSocketOptions {
  url: (baseUrl?: string) => string | Promise<string>;
  protocol: string;
  watchdogMs?: number | null;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  maxReconnectAttempt?: number;
  reconnectDelayMs?: (attempt: number, random: number) => number;
  random?: () => number;
  watchdogFrameTypes?: readonly string[];
  authorization?: () => Promise<AuthTokenSnapshot>;
  createWebSocket?: (
    url: string,
    protocol: string,
    options?: { headers: Record<string, string> },
  ) => WebSocket;
}

/** A generation-fenced JSON socket. Application protocols own frame validation. */
export class ReconnectingSocket<Outbound = unknown> {
  private readonly options: Required<
    Pick<ReconnectingSocketOptions, "url" | "protocol" | "random" | "createWebSocket">
  > & {
    watchdogMs: number | null;
    reconnectBaseMs: number;
    reconnectCapMs: number;
    maxReconnectAttempt: number;
    reconnectDelayMs: ((attempt: number, random: number) => number) | null;
    watchdogFrameTypes: readonly string[];
    authorization: (() => Promise<AuthTokenSnapshot>) | null;
  };

  private current: WebSocket | null = null;
  private stateValue: SocketState = "idle";
  private generationValue = 0;
  private reconnectAttemptValue = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private hasConnected = false;
  private watchdogStarted = false;
  private closeInfoValue: SocketCloseInfo | null = null;
  private readonly stateListeners = new Set<Listener<SocketState>>();
  private readonly messageListeners = new Set<Listener<unknown>>();

  constructor(options: ReconnectingSocketOptions) {
    this.options = {
      url: options.url,
      protocol: options.protocol,
      watchdogMs: options.watchdogMs === undefined ? SOCKET_TIMING.watchdogMs : options.watchdogMs,
      reconnectBaseMs: options.reconnectBaseMs ?? SOCKET_TIMING.reconnectBaseMs,
      reconnectCapMs: options.reconnectCapMs ?? SOCKET_TIMING.reconnectCapMs,
      maxReconnectAttempt: options.maxReconnectAttempt ?? 6,
      reconnectDelayMs: options.reconnectDelayMs ?? null,
      watchdogFrameTypes: options.watchdogFrameTypes ?? ["ping", "alerts.ping"],
      authorization: options.authorization ?? null,
      random: options.random ?? Math.random,
      createWebSocket:
        options.createWebSocket ??
        ((url, protocol, socketOptions) => {
          const NativeWebSocket = WebSocket as unknown as new (
            url: string,
            protocols: string,
            options: { headers: Record<string, string> },
          ) => WebSocket;
          return new NativeWebSocket(url, protocol, socketOptions ?? { headers: {} });
        }),
    };
    SOCKET_REGISTRY.add(this);
  }

  get state(): SocketState {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get reconnectAttempt(): number {
    return this.reconnectAttemptValue;
  }

  get closeInfo(): SocketCloseInfo | null {
    return this.closeInfoValue;
  }

  connect(): void {
    if (this.stateValue === "open" || this.stateValue === "connecting") {
      return;
    }

    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    this.startConnection(this.hasConnected);
  }

  hardReconnect(): void {
    this.retireCurrent();
    this.intentionallyClosed = false;
    this.startConnection(this.hasConnected);
  }

  send(frame: Outbound): void {
    if (!this.current || this.current.readyState !== WS_OPEN || this.stateValue !== "open") {
      throw new Error("WebSocket is not open");
    }
    this.current.send(JSON.stringify(frame));
  }

  subscribe(listener: Listener<SocketState>): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onMessage(listener: Listener<unknown>): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  retire(): void {
    this.intentionallyClosed = true;
    this.retireCurrent();
    this.setState("closed");
  }

  close(): void {
    this.retire();
    SOCKET_REGISTRY.delete(this);
    this.stateListeners.clear();
    this.messageListeners.clear();
  }

  failProtocol(reason: string): void {
    const socket = this.current;
    if (!socket) {
      this.intentionallyClosed = true;
      this.clearReconnectTimer();
      this.clearWatchdog();
      this.generationValue += 1;
      this.setState("failed");
      return;
    }
    this.failGeneration(socket, this.generationValue, PROTOCOL_CLOSE, reason);
  }

  private async startConnection(reconnecting: boolean): Promise<void> {
    const generation = ++this.generationValue;
    this.setState(reconnecting ? "reconnecting" : "connecting");

    let url: string;
    let credentials: AuthTokenSnapshot | undefined;
    let token: string | null | undefined;
    try {
      // Freeze the origin with its bearer before resolving a native socket URL.
      // A server switch must never pair one server's URL with another's token.
      credentials = await this.options.authorization?.();
      token = credentials?.token;
      url = await this.options.url(credentials?.baseUrl);
      if (this.options.authorization && token === null) {
        throw new ApiError(401, "not_authenticated", "No access token");
      }
    } catch {
      if (generation === this.generationValue && !this.intentionallyClosed) {
        this.setState("failed");
      }
      return;
    }

    if (generation !== this.generationValue || this.intentionallyClosed) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.options.createWebSocket(
        url,
        this.options.protocol,
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      );
    } catch {
      this.scheduleReconnect(generation);
      return;
    }

    this.current = socket;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) {
        return;
      }
      if (socket.protocol !== this.options.protocol) {
        this.failGeneration(socket, generation, PROTOCOL_CLOSE, "subprotocol mismatch");
        return;
      }

      this.hasConnected = true;
      this.reconnectAttemptValue = 0;
      this.closeInfoValue = null;
      this.watchdogStarted = false;
      this.setState("open");
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) {
        return;
      }
      if (this.watchdogStarted || this.isWatchdogStartFrame(event.data)) {
        this.watchdogStarted = true;
        this.armWatchdog(generation);
      }
      for (const listener of this.messageListeners) {
        try {
          listener(event.data);
        } catch {
          // A consumer cannot prevent delivery to the remaining subscribers.
        }
      }
    };
    socket.onerror = () => {
      // React Native follows an error with close; reconnect is scheduled there.
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) {
        return;
      }
      this.current = null;
      this.clearWatchdog();
      this.closeInfoValue = { code: event.code, reason: event.reason ?? "" };
      if (this.intentionallyClosed) {
        this.setState("closed");
        return;
      }
      if (event.code === 4003) emitProtocolRequired();
      if (event.code === 1008) {
        this.setState("unauthenticated");
        void reportUnauthenticated(credentials);
        return;
      }
      if (PERMANENT_CLOSE_CODES.has(event.code)) {
        this.setState("failed");
        return;
      }
      if (event.code === 4010) {
        void this.startConnection(true);
        return;
      }
      this.scheduleReconnect(generation);
    };
  }

  private isWatchdogStartFrame(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      const frame = JSON.parse(value) as { type?: unknown };
      return (
        typeof frame === "object" &&
        frame !== null &&
        typeof frame.type === "string" &&
        this.options.watchdogFrameTypes.includes(frame.type)
      );
    } catch {
      return false;
    }
  }

  private scheduleReconnect(generation: number): void {
    if (generation !== this.generationValue || this.intentionallyClosed) {
      return;
    }
    this.current = null;
    this.clearWatchdog();
    this.clearReconnectTimer();
    this.setState("reconnecting");

    const random = Math.max(0, Math.min(1, this.options.random()));
    const delay = this.options.reconnectDelayMs
      ? this.options.reconnectDelayMs(this.reconnectAttemptValue, random)
      : this.defaultReconnectDelay(this.reconnectAttemptValue, random);
    this.reconnectAttemptValue = Math.min(
      this.reconnectAttemptValue + 1,
      this.options.maxReconnectAttempt,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation === this.generationValue && !this.intentionallyClosed) {
        void this.startConnection(true);
      }
    }, delay);
  }

  private defaultReconnectDelay(attempt: number, random: number): number {
    const base = Math.min(this.options.reconnectCapMs, this.options.reconnectBaseMs * 2 ** attempt);
    const jitter =
      SOCKET_TIMING.jitterMin + random * (SOCKET_TIMING.jitterMax - SOCKET_TIMING.jitterMin);
    return base * jitter;
  }

  private armWatchdog(generation: number): void {
    this.clearWatchdog();
    if (this.options.watchdogMs === null) {
      return;
    }
    this.watchdogTimer = setTimeout(() => {
      if (generation !== this.generationValue || this.intentionallyClosed) {
        return;
      }
      const socket = this.current;
      this.current = null;
      this.generationValue += 1;
      socket?.close(4008, "keepalive timeout");
      this.scheduleReconnect(this.generationValue);
    }, this.options.watchdogMs);
  }

  private failGeneration(
    socket: WebSocket,
    generation: number,
    code: number,
    reason: string,
  ): void {
    if (!this.isCurrent(socket, generation)) {
      return;
    }
    this.clearWatchdog();
    this.current = null;
    this.generationValue += 1;
    socket.close(code, reason);
    this.setState("failed");
  }

  private retireCurrent(): void {
    this.clearReconnectTimer();
    this.clearWatchdog();
    const socket = this.current;
    this.current = null;
    this.generationValue += 1;
    if (socket) {
      socket.close(NORMAL_CLOSE, "retired");
    }
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.current === socket && this.generationValue === generation;
  }

  private setState(state: SocketState): void {
    if (state === this.stateValue) {
      return;
    }
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
