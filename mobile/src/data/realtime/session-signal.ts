import { buildBrowserSocketUrl } from "@/data/api/socket-urls";
import { registerRealtimeGenerationTarget } from "@/data/realtime/lifecycle";
import { ReconnectingSocket, type SocketState } from "@/data/realtime/socket";
import { useConnectionStore } from "@/data/stores/connection";
import { useSessionUiStore } from "@/data/stores/session-ui";

export const SESSION_SIGNAL_PROTOCOL = "spawn.v3";
const SIGNAL_RECONNECT_CAP_MS = 10_000;
const SIGNAL_RECONNECT_STEP_MS = 500;

export interface SignalChannel {
  readonly state: SocketState;
  send(frame: unknown): void;
  onFrame(fn: (frame: unknown) => void): () => void;
  close(): void;
}

type SignalFrameObserver = (sessionId: string, frame: unknown) => void;
const FRAME_OBSERVERS = new Set<SignalFrameObserver>();

export function subscribeSessionSignalFrames(observer: SignalFrameObserver): () => void {
  FRAME_OBSERVERS.add(observer);
  return () => {
    FRAME_OBSERVERS.delete(observer);
  };
}

function parseSignalFrame(value: unknown): unknown | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function frameType(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null || !("type" in frame)) {
    return null;
  }
  return typeof frame.type === "string" ? frame.type : null;
}

function sessionStatus(frame: unknown): string | null {
  if (frameType(frame) !== "session.status" || typeof frame !== "object" || frame === null) {
    return null;
  }
  return "status" in frame && typeof frame.status === "string" ? frame.status : null;
}

class SessionSignalChannel implements SignalChannel {
  private readonly socket: ReconnectingSocket<unknown>;
  private readonly listeners = new Set<(frame: unknown) => void>();
  private readonly unsubscribers: Array<() => void>;
  private readonly unregisterGenerationTarget: () => void;

  constructor(private readonly sessionId: string) {
    this.socket = new ReconnectingSocket({
      url: () => buildBrowserSocketUrl(sessionId),
      protocol: SESSION_SIGNAL_PROTOCOL,
      watchdogMs: null,
      reconnectDelayMs: (attempt) =>
        Math.min(SIGNAL_RECONNECT_CAP_MS, SIGNAL_RECONNECT_STEP_MS * (attempt + 1)),
      maxReconnectAttempt: SIGNAL_RECONNECT_CAP_MS / SIGNAL_RECONNECT_STEP_MS,
    });
    this.unregisterGenerationTarget = registerRealtimeGenerationTarget({
      retire: () => this.socket.retire(),
      reopen: () => this.socket.connect(),
    });
    this.unsubscribers = [
      this.socket.subscribe((state) => {
        useConnectionStore.getState().setSessionSignal(this.sessionId, state);
      }),
      this.socket.onMessage((value) => {
        if (typeof value !== "string") {
          this.socket.failProtocol("binary signalling frame");
          return;
        }
        const frame = parseSignalFrame(value);
        if (!frame) {
          return;
        }
        const type = frameType(frame);
        const status = sessionStatus(frame);
        if (type === "session.exit" || status === "exited" || status === "killed") {
          useConnectionStore.getState().setSessionTransport(this.sessionId, "closed");
          useSessionUiStore.getState().cleanup(this.sessionId);
        }
        for (const observer of FRAME_OBSERVERS) {
          try {
            observer(this.sessionId, frame);
          } catch {
            // A cache observer cannot interrupt the transport relay.
          }
        }
        for (const listener of this.listeners) {
          try {
            listener(frame);
          } catch {
            // The WebView bridge and other consumers are isolated.
          }
        }
      }),
    ];
    this.socket.connect();
  }

  get state(): SocketState {
    return this.socket.state;
  }

  send(frame: unknown): void {
    this.socket.send(frame);
  }

  onFrame(fn: (frame: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  close(): void {
    this.unregisterGenerationTarget();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers.length = 0;
    this.listeners.clear();
    this.socket.close();
    useConnectionStore.getState().removeSession(this.sessionId);
  }
}

export function openSessionSignal(sessionId: string): SignalChannel {
  return new SessionSignalChannel(sessionId);
}
