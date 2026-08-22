import { buildAlertsSocketUrl } from "@/data/api/socket-urls";
import { ReconnectingSocket, type SocketState } from "@/data/realtime/socket";

export const ALERT_PROTOCOL = "spawn.alerts.v1";

export type AlertEventKind = "agent.finished" | "agent.awaiting_input" | "session.died";

export interface AlertEvent {
  event: AlertEventKind;
  session_id: string;
  command: string | null;
  exit_code: number | null;
  signal: string | null;
  at: string;
}

export type AlertFrame =
  | ({ type: "alert" } & AlertEvent)
  | { type: "alerts.ping" }
  | { type: "protocol.required"; protocol: "spawn.alerts.v1"; version: 1 };

type AlertListener = (alert: AlertEvent) => void;
type FrameListener = (frame: AlertFrame) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface UnknownAlertFrame {
  type?: unknown;
  protocol?: unknown;
  version?: unknown;
  event?: unknown;
  session_id?: unknown;
  command?: unknown;
  exit_code?: unknown;
  signal?: unknown;
  at?: unknown;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isAlertEventKind(value: unknown): value is AlertEventKind {
  return value === "agent.finished" || value === "agent.awaiting_input" || value === "session.died";
}

export function parseAlertFrame(value: unknown): AlertFrame | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) {
    return null;
  }
  const frame = parsed as UnknownAlertFrame;
  if (typeof frame.type !== "string") {
    return null;
  }
  if (frame.type === "alerts.ping") {
    return { type: "alerts.ping" };
  }
  if (frame.type === "protocol.required") {
    return frame.protocol === ALERT_PROTOCOL && frame.version === 1
      ? { type: "protocol.required", protocol: ALERT_PROTOCOL, version: 1 }
      : null;
  }
  if (frame.type !== "alert" || !isAlertEventKind(frame.event)) {
    return null;
  }
  if (typeof frame.session_id !== "string" || frame.session_id.trim().length === 0) {
    return null;
  }
  if (
    frame.command !== undefined &&
    frame.command !== null &&
    (typeof frame.command !== "string" || frame.command.length > 64)
  ) {
    return null;
  }

  return {
    type: "alert",
    event: frame.event,
    session_id: frame.session_id,
    command: typeof frame.command === "string" ? frame.command : null,
    exit_code:
      typeof frame.exit_code === "number" && Number.isFinite(frame.exit_code)
        ? frame.exit_code
        : null,
    signal: typeof frame.signal === "string" ? frame.signal : null,
    at: typeof frame.at === "string" ? frame.at : "",
  };
}

export class AlertSocketClient {
  private readonly socket: ReconnectingSocket<never>;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly alertListeners = new Set<AlertListener>();
  private readonly unsubscribeMessage: () => void;

  constructor(
    url: () => string | Promise<string>,
    createWebSocket?: (url: string, protocol: string) => WebSocket,
  ) {
    this.socket = new ReconnectingSocket({
      url,
      protocol: ALERT_PROTOCOL,
      ...(createWebSocket ? { createWebSocket } : {}),
    });
    this.unsubscribeMessage = this.socket.onMessage((value) => {
      const frame = parseAlertFrame(value);
      if (!frame) {
        return;
      }
      for (const listener of this.frameListeners) {
        try {
          listener(frame);
        } catch {
          // Alert delivery stays isolated per subscriber.
        }
      }
      if (frame.type === "alert") {
        const { type: _type, ...alert } = frame;
        for (const listener of this.alertListeners) {
          try {
            listener(alert);
          } catch {
            // Alert delivery stays isolated per subscriber.
          }
        }
      }
    });
  }

  get state(): SocketState {
    return this.socket.state;
  }

  connect(): void {
    this.socket.connect();
  }

  hardReconnect(): void {
    this.socket.hardReconnect();
  }

  subscribe(listener: (state: SocketState) => void): () => void {
    return this.socket.subscribe(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    return () => {
      this.alertListeners.delete(listener);
    };
  }

  retire(): void {
    this.socket.retire();
  }

  close(): void {
    this.unsubscribeMessage();
    this.socket.close();
    this.frameListeners.clear();
    this.alertListeners.clear();
  }
}

export function openAlertSocket(): AlertSocketClient {
  const client = new AlertSocketClient(buildAlertsSocketUrl);
  client.connect();
  return client;
}
