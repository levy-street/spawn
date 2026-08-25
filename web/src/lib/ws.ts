/**
 * WebSocket helpers for the per-session browser stream.
 *
 * See `proto/README.md`:
 *   - URL: `${WS_URL}/ws/browser?session_id=<uuid>`
 *   - Subprotocol: `spawn.v3` (signaling and disclosed lifecycle only).
 *   - Terminal bytes and viewport/history operations are mandatory
 *     `spawn.pty`/`spawn.ctl` WebRTC DataChannel traffic.
 *
 * Naming note: RTC signaling frames carry TWO identities. `session_id` is the
 * RTC *signaling* session (one per WebRTC generation, minted by the browser),
 * while the PTY session — the thing `/api/sessions` names — travels as the
 * scope: `scope_type: "session"`, `scope_id: <PTY session uuid>`.
 */

// When this env var is unset/empty, we build the WS URL from the current
// window.location so deployed/tunnelled single-origin setups Just Work.
// The Next rewrite proxies /ws/* to the API server in local development.
const WS_URL = process.env.NEXT_PUBLIC_SPAWN_WS_URL ?? "";

export const SPAWN_WS_SUBPROTOCOL = "spawn.v3";

function originForWs(): string {
  if (WS_URL) return WS_URL;
  if (typeof window === "undefined") return "ws://localhost:3000";
  const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${wsScheme}://${window.location.host}`;
}

export function buildSessionWsUrl(sessionId: string): string {
  const u = new URL(`${originForWs()}/ws/browser`);
  u.searchParams.set("session_id", sessionId);
  return u.toString();
}

export function buildHostWsUrl(hostId: string): string {
  const url = new URL(`${originForWs()}/ws/host`);
  url.searchParams.set("host_id", hostId);
  return url.toString();
}

/**
 * Owner-scoped attention stream. One per tab, not one per session: the whole
 * point is to hear about a session that has no pane open.
 */
export function buildAlertsWsUrl(): string {
  return new URL(`${originForWs()}/ws/alerts`).toString();
}

// ---------- Inbound JSON frame types ----------

export interface DisplayControlState {
  owner: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export type InboundMessage =
  | { type: "session.exit"; exit_code: number | null; signal: string | null }
  | { type: "session.status"; status: "starting" | "running" | "exited" | "killed" }
  | {
      type: "rtc.config";
      enabled: boolean;
      ice_servers?: RTCIceServer[];
      /** "relay" when the deployment offers no direct path at all. */
      ice_transport_policy?: RTCIceTransportPolicy;
      binding_nonce_required?: boolean;
    }
  | {
      type: "rtc.answer";
      session_id: string;
      binding_nonce?: string;
      binding_generation?: number;
      scope_type?: string;
      scope_id?: string;
      protocol?: string;
      protocol_version?: number;
      /** Mutually exclusive relay carriers. A locally signed offer freezes
       * signed mode, so a raw sibling can never become its answer fallback. */
      signed_envelope?: string;
      sdp?: string;
    }
  | {
      type: "rtc.candidate";
      session_id: string;
      binding_nonce?: string;
      binding_generation?: number;
      scope_type?: string;
      scope_id?: string;
      protocol?: string;
      protocol_version?: number;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: "rtc.status";
      session_id?: string;
      binding_nonce?: string;
      binding_generation?: number;
      scope_type?: string;
      scope_id?: string;
      protocol?: string;
      protocol_version?: number;
      status: string;
      message?: string;
    };

export function parseInbound(raw: string): InboundMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || typeof obj.type !== "string") return null;
    return obj as InboundMessage;
  } catch {
    return null;
  }
}

// ---------- Outbound JSON frame types ----------

export interface SessionRtcTuple {
  scope_type: "session";
  scope_id: string;
  protocol: "spawn.pty";
  protocol_version: 2;
}

export function sessionRtcTuple(sessionId: string): SessionRtcTuple {
  return {
    scope_type: "session",
    scope_id: sessionId,
    protocol: "spawn.pty",
    protocol_version: 2,
  };
}

export type OutboundMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control"; cols: number; rows: number }
  | { type: "scroll"; lines: number }
  | { type: "snapshot"; lines?: number; plain?: boolean; rtc_session_id?: string }
  | (SessionRtcTuple & {
      type: "rtc.offer";
      session_id: string;
      binding_nonce: string;
      sdp: string;
    })
  | (SessionRtcTuple & {
      type: "rtc.offer";
      session_id: string;
      binding_nonce: string;
      signed_envelope: string;
    })
  | (SessionRtcTuple & {
      type: "rtc.candidate";
      session_id: string;
      binding_nonce: string;
      candidate: RTCIceCandidateInit;
    })
  | (SessionRtcTuple & { type: "rtc.close"; session_id: string; binding_nonce: string });

export interface RtcBindingIdentity {
  /** RTC signaling session (wire `session_id`). */
  rtcSessionId: string;
  bindingNonce: string;
  bindingGeneration: number | null;
  /** The PTY session (wire `scope_id` under `scope_type: "session"`). */
  sessionId: string;
}

export interface RtcBindingFrame {
  session_id?: string;
  binding_nonce?: string;
  binding_generation?: number;
  scope_type?: string;
  scope_id?: string;
  protocol?: string;
  protocol_version?: number;
}

/** Match the immutable RTC identity, not merely its reusable session id. */
export function rtcBindingFrameMatches(
  current: RtcBindingIdentity,
  frame: RtcBindingFrame,
): boolean {
  if (frame.session_id !== current.rtcSessionId) return false;
  if (frame.binding_nonce === undefined || frame.binding_generation === undefined) return false;
  return (
    frame.binding_nonce === current.bindingNonce &&
    Number.isSafeInteger(frame.binding_generation) &&
    frame.binding_generation > 0 &&
    (current.bindingGeneration === null ||
      frame.binding_generation === current.bindingGeneration) &&
    frame.scope_type === "session" &&
    frame.scope_id === current.sessionId &&
    frame.protocol === "spawn.pty" &&
    frame.protocol_version === 2
  );
}

export { WS_URL };
