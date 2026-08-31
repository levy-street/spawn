import { CLIENT_INSTANCE_ID } from "@/data/api/client-instance";
import { qk } from "@/data/queryKeys";

import type { AlertFrame, DataEvent } from "@/data/realtime/alert-socket";

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

/** Query-key prefixes to refetch per data-changed resource. A prefix key
 * (`["workspace"]` without an id) covers every detail query under it. */
function dataEffects(event: DataEvent): CacheEffect[] {
  if (event.origin === CLIENT_INSTANCE_ID) {
    // This launch's own echo. Refetching here is not merely wasted work: an
    // optimistic layout write mid-drag must not be raced by a refetch of the
    // very layout it is about to replace.
    return [{ kind: "none", reason: "own echo" }];
  }
  switch (event.resource) {
    case "workspaces":
      return [
        { kind: "invalidate", key: qk.workspaces() },
        { kind: "invalidate", key: ["workspace"] },
      ];
    case "workspace-templates":
      return [{ kind: "invalidate", key: qk.workspaceTemplates() }];
    case "sessions":
      return [
        { kind: "invalidate", key: qk.sessions() },
        event.id !== null
          ? { kind: "invalidate", key: qk.session(event.id) }
          : { kind: "invalidate", key: ["session"] },
      ];
    case "hosts":
      return [
        { kind: "invalidate", key: qk.hosts() },
        { kind: "invalidate", key: ["host"] },
        { kind: "invalidate", key: ["host-agents"] },
      ];
    case "agents":
      return [
        { kind: "invalidate", key: qk.agents() },
        { kind: "invalidate", key: qk.skills() },
      ];
    case "profile":
      return [
        { kind: "invalidate", key: qk.profile() },
        { kind: "invalidate", key: qk.me() },
      ];
    default:
      return [{ kind: "none", reason: "unknown data resource" }];
  }
}

export function effectsForFrame(frame: RealtimeFrame): CacheEffect[] {
  switch (frame.type) {
    case "alert":
      return [{ kind: "invalidate", key: qk.sessions() }];
    case "data":
      return dataEffects(frame as { type: "data" } & DataEvent);
    case "trust":
      // A knock or its answer changes who may connect, so every cached trust
      // fact goes at once: the pending list, and each host's verdict on this
      // device. They all live under the one prefix.
      return [{ kind: "invalidate", key: qk.trust() }];
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
