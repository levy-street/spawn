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

export const SOCKET_UNAUTHORIZED_EVENT = "spawn:socket-unauthorized";

export interface BackoffOptions {
  base: number;
  cap: number;
}

/** Exponential reconnect delay with enough jitter to keep waking tabs from
 * redialling in lockstep. `attempt=0` is the first retry. */
export function backoffDelay(
  attempt: number,
  { base, cap }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(0, Math.min(30, Math.floor(attempt)));
  const ceiling = Math.max(0, cap);
  const exponential = Math.min(ceiling, Math.max(0, base) * 2 ** boundedAttempt);
  return exponential * (0.7 + Math.min(1, Math.max(0, random())) * 0.6);
}

export type SocketCloseAction =
  | "reconnect"
  | "reconnect_immediately"
  | "unauthorized"
  | "client_bug"
  | "client_stale";

/** One close-code policy shared by browser, host, and alert signalling. */
export function socketCloseAction(code: number): SocketCloseAction {
  if (code === 1008) return "unauthorized";
  if (code === 4002 || code === 1002) return "client_bug";
  if (code === 4003) return "client_stale";
  if (code === 4010) return "reconnect_immediately";
  return "reconnect";
}

export function notifySocketUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SOCKET_UNAUTHORIZED_EVENT));
}

const ICE_URL_PATTERN = /^(stuns?|turns?):/i;
const TURN_URL_PATTERN = /^turns?:/i;
const MAX_ICE_SERVER_ENTRIES = 8;

/** Treat server-provided ICE configuration as untrusted protocol input. */
export function sanitizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];
  const sanitized: RTCIceServer[] = [];
  for (const candidate of value) {
    if (sanitized.length >= MAX_ICE_SERVER_ENTRIES) break;
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const rawUrls = record.urls;
    const urls = typeof rawUrls === "string" ? [rawUrls] : rawUrls;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.some((url) => typeof url !== "string" || !ICE_URL_PATTERN.test(url))
    ) {
      continue;
    }
    const needsCredentials = urls.some((url) => TURN_URL_PATTERN.test(url));
    if (
      needsCredentials &&
      (typeof record.username !== "string" ||
        record.username.length === 0 ||
        typeof record.credential !== "string" ||
        record.credential.length === 0)
    ) {
      continue;
    }
    sanitized.push({
      urls: typeof rawUrls === "string" ? rawUrls : (urls as string[]),
      ...(typeof record.username === "string" ? { username: record.username } : {}),
      ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
      ...(record.credentialType === "password" ? { credentialType: "password" as const } : {}),
    });
  }
  return sanitized;
}

/** Coturn REST usernames start with their Unix expiry. Refresh one hour early. */
export function iceServersNeedRefresh(
  iceServers: readonly RTCIceServer[],
  nowMs = Date.now(),
): boolean {
  const refreshBeforeSeconds = Math.floor(nowMs / 1000) + 60 * 60;
  for (const server of iceServers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!urls.some((url) => TURN_URL_PATTERN.test(url))) continue;
    const expiry = Number.parseInt(server.username?.split(":", 1)[0] ?? "", 10);
    if (Number.isSafeInteger(expiry) && expiry <= refreshBeforeSeconds) return true;
  }
  return false;
}

/**
 * A live socket hears a server ping at least every 25 s. Silence past this,
 * on a socket still claiming OPEN, says the socket is a corpse a sleep left
 * behind — macOS suspend routinely half-opens TCP without ever firing
 * `onclose`, and everything sent into one "succeeds" into nothing.
 */
export const SIGNAL_SILENCE_SUSPECT_MS = 35_000;

/**
 * An RTC start or ICE restart still "in flight" after this long is presumed
 * frozen, not slow: its awaits (an IndexedDB trust read, `createOffer` on a
 * post-suspend WebKit) can simply never settle after a sleep, and the latch
 * they hold would otherwise turn every later retry into a no-op — the exact
 * shape of "reconnecting forever until a reload". A healthy pass finishes in
 * a couple of seconds; every legitimate timer inside one is 10 s or less.
 */
export const RTC_LATCH_TIMEOUT_MS = 20_000;

/**
 * The wake signal none of the browser's events deliver: a machine that slept
 * with the page visible and frontmost fires no `visibilitychange`, fires
 * `online` only if the network stack noticed, and `pageshow` only from
 * bfcache — inside the desktop shell's webview, typically nothing at all. A
 * timer that should have ticked every `intervalMs` and instead skipped more
 * than `gapMs` proves the clock jumped, which only a suspend does.
 */
export function watchSuspendResume(
  onResume: () => void,
  intervalMs = 15_000,
  gapMs = 45_000,
  now: () => number = Date.now,
): () => void {
  if (typeof window === "undefined") return () => {};
  let last = now();
  const timer = setInterval(() => {
    const current = now();
    const gap = current - last;
    last = current;
    if (gap > gapMs) onResume();
  }, intervalMs);
  return () => clearInterval(timer);
}

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
  sameDevice?: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export type InboundMessage =
  | { type: "ping"; ts: number }
  | { type: "error"; code?: string; frame_type?: string; message?: string }
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
  | { type: "pong"; ts: number }
  | { type: "rtc.config.request" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control"; cols: number; rows: number }
  | { type: "scroll"; lines: number }
  | { type: "snapshot"; lines?: number; plain?: boolean; rtc_session_id?: string }
  | (SessionRtcTuple & {
      type: "rtc.offer";
      session_id: string;
      binding_nonce: string;
      binding_generation?: number;
      ice_restart?: boolean;
      sdp: string;
    })
  | (SessionRtcTuple & {
      type: "rtc.offer";
      session_id: string;
      binding_nonce: string;
      binding_generation?: number;
      ice_restart?: boolean;
      signed_envelope: string;
    })
  | (SessionRtcTuple & {
      type: "rtc.candidate";
      session_id: string;
      binding_nonce: string;
      binding_generation?: number;
      candidate: RTCIceCandidateInit;
    })
  | (SessionRtcTuple & { type: "rtc.close"; session_id: string; binding_nonce: string })
  | (SessionRtcTuple & {
      type: "rtc.resume";
      session_id: string;
      binding_nonce: string;
      binding_generation: number;
    });

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
