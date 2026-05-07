/**
 * WebSocket helpers for the per-agent browser stream.
 *
 * See `proto/README.md`:
 *   - URL: `${WS_URL}/ws/browser?agent_id=<uuid>`
 *   - Subprotocol: `spawn.v1`
 *   - Inbound: text JSON ({type:"history", bytes_b64} | {type:"agent.exit",...} |
 *             {type:"agent.status",...} | {type:"upload.saved",...} |
 *             {type:"upload.error",...}); binary stdout bytes.
 *   - Outbound: text JSON ({type:"resize",cols,rows} | {type:"scroll",lines} |
 *              {type:"upload",...});
 *               binary stdin bytes.
 */

// When this env var is unset/empty, we build the WS URL from the current
// window.location so deployed/tunnelled single-origin setups Just Work
// (Next.js rewrites also proxy /ws/*). Override in dev with
// NEXT_PUBLIC_SPAWN_WS_URL=ws://localhost:8000 if you're running the
// FastAPI server on a different port.
const WS_URL = process.env.NEXT_PUBLIC_SPAWN_WS_URL ?? "";

export const SPAWN_WS_SUBPROTOCOL = "spawn.v1";

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

// ---------- Inbound JSON frame types ----------

export type InboundMessage =
  | { type: "history"; bytes_b64: string }
  | { type: "snapshot"; bytes_b64: string; plain?: boolean }
  | { type: "agent.exit"; exit_code: number | null; signal: string | null }
  | { type: "agent.status"; status: "starting" | "running" | "exited" | "killed" }
  | { type: "upload.saved"; path: string; client_id?: string }
  | { type: "upload.error"; message: string };

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
  | { type: "scroll"; lines: number }
  | { type: "snapshot"; lines?: number; plain?: boolean }
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

export { WS_URL };
