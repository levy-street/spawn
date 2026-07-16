/**
 * WebSocket helpers for the per-agent browser stream.
 *
 * See `proto/README.md`:
 *   - URL: `${WS_URL}/ws/browser?agent_id=<uuid>`
 *   - Subprotocol: `spawn.v2` preferred, `spawn.v1` legacy.
 *   - Legacy-v1 inbound: text JSON ({type:"history", bytes_b64} | {type:"display.control",...} |
 *             {type:"agent.exit",...} | {type:"agent.status",...} |
 *             {type:"upload.saved",...} | {type:"upload.error",...} |
 *             WebRTC signaling frames); binary stdout bytes.
 *   - Legacy-v1 outbound: text JSON ({type:"resize",cols,rows} | {type:"take_control",cols,rows} |
 *              {type:"scroll",lines} | {type:"upload",...});
 *               binary stdin bytes.
 */

// When this env var is unset/empty, we build the WS URL from the current
// window.location so deployed/tunnelled single-origin setups Just Work.
// The Next rewrite proxies /ws/* to the API server in local development.
const WS_URL = process.env.NEXT_PUBLIC_SPAWN_WS_URL ?? "";

// Offered in preference order. On spawn.v2 browser input and browser-requested
// history use spawn.pty/spawn.ctl WebRTC DataChannels. Until P2-AGENT-02,
// however, spawnd still mirrors live output through the legacy server path;
// the protocol label must not imply that the server cannot observe content.
// spawn.v1 also keeps browser input/history on the legacy relay.
export const SPAWN_WS_SUBPROTOCOLS = ["spawn.v2", "spawn.v1"];

export function spawnWsSubprotocols(): string[] {
  // Test hook: Playwright's WS mock always selects the first offered
  // subprotocol, so relay-path specs pin the client to v1 explicitly.
  if (
    typeof window !== "undefined" &&
    (window as { __spawnForceWsV1?: boolean }).__spawnForceWsV1
  ) {
    return ["spawn.v1"];
  }
  return SPAWN_WS_SUBPROTOCOLS;
}

function originForWs(): string {
  if (WS_URL) return WS_URL;
  if (typeof window === "undefined") return "ws://localhost:3000";
  const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${wsScheme}://${window.location.host}`;
}

export function buildAgentWsUrl(
  agentId: string,
  size?: { cols: number; rows: number } | null,
): string {
  const u = new URL(`${originForWs()}/ws/browser`);
  u.searchParams.set("agent_id", agentId);
  if (size) {
    u.searchParams.set("cols", String(size.cols));
    u.searchParams.set("rows", String(size.rows));
  }
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
  | { type: "history"; bytes_b64: string }
  | ({ type: "display.control" } & DisplayControlState)
  | {
      type: "snapshot";
      bytes_b64: string;
      plain?: boolean;
      dc_offset?: number;
      rtc_session_id?: string;
    }
  | { type: "agent.exit"; exit_code: number | null; signal: string | null }
  | { type: "agent.status"; status: "starting" | "running" | "exited" | "killed" }
  | { type: "upload.saved"; path: string; client_id?: string }
  | { type: "upload.error"; message: string }
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
      sdp: string;
    }
  | {
      type: "rtc.candidate";
      session_id: string;
      agent_id?: string;
      binding_nonce?: string;
      binding_generation?: number;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: "rtc.status";
      session_id?: string;
      agent_id?: string;
      binding_nonce?: string;
      binding_generation?: number;
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

export type OutboundMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control"; cols: number; rows: number }
  | { type: "scroll"; lines: number }
  | { type: "snapshot"; lines?: number; plain?: boolean; rtc_session_id?: string }
  | { type: "rtc.offer"; session_id: string; binding_nonce: string; sdp: string }
  | {
      type: "rtc.candidate";
      session_id: string;
      binding_nonce: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: "rtc.close"; session_id: string; binding_nonce: string }
  | {
      type: "upload";
      name: string;
      mime_type: string;
      bytes_b64: string;
      paste?: boolean;
      client_id?: string;
    };

// ---------- Base64 helpers (history replay payload) ----------

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "undefined") {
    // Server-side fallback (we should not really hit this, but just in case).
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface RtcBindingIdentity {
  sessionId: string;
  bindingNonce: string;
  bindingGeneration: number | null;
}

export interface RtcBindingFrame {
  session_id?: string;
  binding_nonce?: string;
  binding_generation?: number;
}

/** Match the immutable RTC identity, not merely its reusable session id. */
export function rtcBindingFrameMatches(
  current: RtcBindingIdentity,
  frame: RtcBindingFrame,
  required: boolean,
): boolean {
  if (frame.session_id !== current.sessionId) return false;
  if (frame.binding_nonce === undefined && frame.binding_generation === undefined) {
    return !required;
  }
  if (frame.binding_nonce === undefined || frame.binding_generation === undefined) return false;
  return (
    frame.binding_nonce === current.bindingNonce &&
    Number.isSafeInteger(frame.binding_generation) &&
    frame.binding_generation > 0 &&
    (current.bindingGeneration === null || frame.binding_generation === current.bindingGeneration)
  );
}

export { WS_URL };
