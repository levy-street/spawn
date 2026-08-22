import { qk } from "@/data/queryKeys";

import type { AlertFrame } from "@/data/realtime/alert-socket";

export type CacheEffect =
  | { kind: "invalidate"; key: readonly unknown[] }
  | { kind: "patch"; key: readonly unknown[]; update: (prev: unknown) => unknown }
  | { kind: "none"; reason: string };

export type RealtimeFrame =
  | AlertFrame
  | { type: "protocol.required"; protocol: string; version: number }
  | { type: "session.status"; status: string }
  | { type: "session.exit"; exit_code: number | null; signal: string | null }
  | { type: "rtc.config"; [key: string]: unknown }
  | { type: "rtc.answer"; [key: string]: unknown }
  | { type: "rtc.candidate"; [key: string]: unknown }
  | { type: "rtc.status"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export function effectsForFrame(frame: RealtimeFrame): CacheEffect[] {
  switch (frame.type) {
    case "alert":
      return [{ kind: "invalidate", key: qk.sessions() }];
    case "alerts.ping":
      return [{ kind: "none", reason: "keepalive only" }];
    case "protocol.required":
      return [{ kind: "none", reason: "protocol failure is connection-local" }];
    case "session.status":
    case "session.exit":
      return [{ kind: "none", reason: "session lifecycle stays transport-local" }];
    case "rtc.config":
    case "rtc.answer":
    case "rtc.candidate":
    case "rtc.status":
      return [{ kind: "none", reason: "signalling stays transport-local" }];
    default:
      return [{ kind: "none", reason: "unknown realtime frame" }];
  }
}
