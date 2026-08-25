import { authToken } from "@/data/api/auth-token";
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

/**
 * Trust events share this socket because they have the same shape of problem
 * attention events do: something happened that the operator must see on
 * whichever device they are looking at, not the one it happened on. A distinct
 * frame `type` keeps the alert validation exactly as narrow as it was.
 */
export type TrustEventKind = "device.approval_requested" | "device.approval_resolved";

export interface TrustEvent {
  event: TrustEventKind;
  request_id: string;
  browser_device_id: string;
  label: string | null;
  /** Present on a request; the operator compares it against the asking device. */
  fingerprint: string | null;
  status: "approved" | "denied" | null;
  at: string;
}

export type AlertFrame =
  | ({ type: "alert" } & AlertEvent)
  | ({ type: "trust" } & TrustEvent)
  | { type: "alerts.ping" }
  | { type: "protocol.required"; protocol: "spawn.alerts.v1"; version: 1 };

type AlertListener = (alert: AlertEvent) => void;
type TrustListener = (event: TrustEvent) => void;
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

function isTrustEventKind(value: unknown): value is TrustEventKind {
  return value === "device.approval_requested" || value === "device.approval_resolved";
}

function parseTrustFrame(frame: Record<string, unknown>): AlertFrame | null {
  if (!isTrustEventKind(frame["event"])) return null;
  const requestId = frame["request_id"];
  const deviceId = frame["browser_device_id"];
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  if (typeof deviceId !== "string" || deviceId.length === 0) return null;
  const status = frame["status"];
  return {
    type: "trust",
    event: frame["event"],
    request_id: requestId,
    browser_device_id: deviceId,
    label: typeof frame["label"] === "string" ? frame["label"] : null,
    fingerprint: typeof frame["fingerprint"] === "string" ? frame["fingerprint"] : null,
    status: status === "approved" || status === "denied" ? status : null,
    at: typeof frame["at"] === "string" ? frame["at"] : "",
  };
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
  if (frame.type === "trust") {
    return parseTrustFrame(parsed as Record<string, unknown>);
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
  private readonly trustListeners = new Set<TrustListener>();
  private readonly unsubscribeMessage: () => void;

  constructor(
    url: () => string | Promise<string>,
    createWebSocket?: (url: string, protocol: string) => WebSocket,
  ) {
    this.socket = new ReconnectingSocket({
      url,
      protocol: ALERT_PROTOCOL,
      ...(createWebSocket ? {} : { authorization: () => authToken.get() }),
      watchdogFrameTypes: ["alerts.ping"],
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
      } else if (frame.type === "trust") {
        const { type: _trustType, ...trustEvent } = frame;
        for (const listener of this.trustListeners) {
          try {
            listener(trustEvent);
          } catch {
            // Trust delivery stays isolated per subscriber.
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

  onTrustEvent(listener: TrustListener): () => void {
    this.trustListeners.add(listener);
    return () => {
      this.trustListeners.delete(listener);
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
    this.trustListeners.clear();
  }
}

export function openAlertSocket(): AlertSocketClient {
  const client = new AlertSocketClient(buildAlertsSocketUrl);
  client.connect();
  return client;
}
