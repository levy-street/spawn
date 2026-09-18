import { authToken } from "@/data/api/auth-token";
import { buildHostSocketUrl } from "@/data/api/socket-urls";
import { registerRealtimeGenerationTarget } from "@/data/realtime/lifecycle";
import type { SignalChannel } from "@/data/realtime/session-signal";
import { ReconnectingSocket, type SocketState } from "@/data/realtime/socket";
import { useConnectionStore } from "@/data/stores/connection";

export const HOST_SIGNAL_PROTOCOL = "spawn.host.v1";
const SIGNAL_RECONNECT_CAP_MS = 30_000;
const SIGNAL_RECONNECT_BASE_MS = 500;

function signalReconnectDelay(attempt: number, random: number): number {
  const base = Math.min(SIGNAL_RECONNECT_CAP_MS, SIGNAL_RECONNECT_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.7 + Math.max(0, Math.min(1, random)) * 0.6));
}

type SignalFrameObserver = (hostId: string, frame: unknown) => void;
const FRAME_OBSERVERS = new Set<SignalFrameObserver>();

export function subscribeHostSignalFrames(observer: SignalFrameObserver): () => void {
  FRAME_OBSERVERS.add(observer);
  return () => {
    FRAME_OBSERVERS.delete(observer);
  };
}

function parseSignalFrame(value: string): unknown | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class HostSignalChannel implements SignalChannel {
  private readonly socket: ReconnectingSocket<unknown>;
  private readonly listeners = new Set<(frame: unknown) => void>();
  private readonly unsubscribers: Array<() => void>;
  private readonly unregisterGenerationTarget: () => void;

  constructor(private readonly hostId: string) {
    this.socket = new ReconnectingSocket({
      url: (baseUrl) => buildHostSocketUrl(hostId, baseUrl),
      protocol: HOST_SIGNAL_PROTOCOL,
      authorization: () => authToken.snapshot(),
      watchdogMs: 80_000,
      watchdogFrameTypes: ["ping"],
      reconnectDelayMs: signalReconnectDelay,
      maxReconnectAttempt: 64,
    });
    this.unregisterGenerationTarget = registerRealtimeGenerationTarget({
      retire: (reason) => {
        if (reason !== "interface-change") this.socket.retire();
      },
      reopen: () => this.socket.connect(),
    });
    this.unsubscribers = [
      this.socket.subscribe((state) => {
        useConnectionStore.getState().setHostSignal(this.hostId, state);
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
        for (const observer of FRAME_OBSERVERS) {
          try {
            observer(this.hostId, frame);
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

  get closeInfo() {
    return this.socket.closeInfo;
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

  onState(fn: (state: SocketState) => void): () => void {
    return this.socket.subscribe(fn);
  }

  close(): void {
    this.unregisterGenerationTarget();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers.length = 0;
    this.listeners.clear();
    this.socket.close();
    useConnectionStore.getState().removeHost(this.hostId);
  }
}

export function openHostSignal(hostId: string): SignalChannel {
  return new HostSignalChannel(hostId);
}
