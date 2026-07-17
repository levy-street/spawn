/**
 * WebSocket helpers for the per-agent browser stream.
 *
 * See `proto/README.md`:
 *   - URL: `${WS_URL}/ws/browser?agent_id=<uuid>`
 *   - Subprotocol: `spawn.v2` (signaling and disclosed lifecycle only).
 *   - Terminal bytes and viewport/history operations are mandatory
 *     `spawn.pty`/`spawn.ctl` WebRTC DataChannel traffic.
 */

// When this env var is unset/empty, we build the WS URL from the current
// window.location so deployed/tunnelled single-origin setups Just Work.
// The Next rewrite proxies /ws/* to the API server in local development.
const WS_URL = process.env.NEXT_PUBLIC_SPAWN_WS_URL ?? "";

export const SPAWN_WS_SUBPROTOCOL = "spawn.v2";

function originForWs(): string {
  if (WS_URL) return WS_URL;
  if (typeof window === "undefined") return "ws://localhost:3000";
  const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${wsScheme}://${window.location.host}`;
}

export function buildAgentWsUrl(agentId: string): string {
  const u = new URL(`${originForWs()}/ws/browser`);
  u.searchParams.set("agent_id", agentId);
  return u.toString();
}

export function buildHostWsUrl(hostId: string): string {
  const url = new URL(`${originForWs()}/ws/host`);
  url.searchParams.set("host_id", hostId);
  return url.toString();
}

// ---------- Inbound JSON frame types ----------

export interface DisplayControlState {
  owner: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export type InboundMessage =
  | { type: "agent.exit"; exit_code: number | null; signal: string | null }
  | { type: "agent.status"; status: "starting" | "running" | "exited" | "killed" }
  | {
      type: "rtc.config";
      enabled: boolean;
      ice_servers?: RTCIceServer[];
      binding_nonce_required?: boolean;
    }
  | {
      type: "rtc.answer";
      session_id: string;
      agent_id?: string;
      binding_nonce?: string;
      binding_generation?: number;
      scope_type?: string;
      scope_id?: string;
      protocol?: string;
      protocol_version?: number;
      sdp: string;
    }
  | {
      type: "rtc.candidate";
      session_id: string;
      agent_id?: string;
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
      agent_id?: string;
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

export interface AgentRtcTuple {
  agent_id: string;
  scope_type: "agent";
  scope_id: string;
  protocol: "spawn.pty";
  protocol_version: 2;
}

export function agentRtcTuple(agentId: string): AgentRtcTuple {
  return {
    agent_id: agentId,
    scope_type: "agent",
    scope_id: agentId,
    protocol: "spawn.pty",
    protocol_version: 2,
  };
}

export type OutboundMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control"; cols: number; rows: number }
  | { type: "scroll"; lines: number }
  | { type: "snapshot"; lines?: number; plain?: boolean; rtc_session_id?: string }
  | (AgentRtcTuple & {
      type: "rtc.offer";
      session_id: string;
      binding_nonce: string;
      sdp: string;
    })
  | (AgentRtcTuple & {
      type: "rtc.candidate";
      session_id: string;
      binding_nonce: string;
      candidate: RTCIceCandidateInit;
    })
  | (AgentRtcTuple & { type: "rtc.close"; session_id: string; binding_nonce: string });

export interface RtcBindingIdentity {
  sessionId: string;
  bindingNonce: string;
  bindingGeneration: number | null;
  agentId: string;
}

export interface RtcBindingFrame {
  session_id?: string;
  binding_nonce?: string;
  binding_generation?: number;
  agent_id?: string;
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
  if (frame.session_id !== current.sessionId) return false;
  if (frame.binding_nonce === undefined || frame.binding_generation === undefined) return false;
  return (
    frame.binding_nonce === current.bindingNonce &&
    Number.isSafeInteger(frame.binding_generation) &&
    frame.binding_generation > 0 &&
    (current.bindingGeneration === null ||
      frame.binding_generation === current.bindingGeneration) &&
    frame.agent_id === current.agentId &&
    frame.scope_type === "agent" &&
    frame.scope_id === current.agentId &&
    frame.protocol === "spawn.pty" &&
    frame.protocol_version === 2
  );
}

export { WS_URL };
