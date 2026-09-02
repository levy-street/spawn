import { CLIENT_INSTANCE_ID } from "@/data/api/client-instance";
import { effectsForFrame, type RealtimeFrame } from "@/data/realtime/event-map";

describe("effectsForFrame", () => {
  it("invalidates the caches a data-changed frame names", () => {
    expect(
      effectsForFrame({
        type: "data",
        resource: "workspaces",
        id: "w-1",
        origin: "another-client",
        at: "now",
      }),
    ).toEqual([
      { kind: "invalidate", key: ["workspaces"] },
      { kind: "invalidate", key: ["workspace"] },
    ]);
    expect(
      effectsForFrame({ type: "data", resource: "sessions", id: "s-1", origin: null, at: "now" }),
    ).toEqual([
      { kind: "invalidate", key: ["sessions"] },
      { kind: "invalidate", key: ["session", "s-1"] },
    ]);
  });

  it("skips this launch's own echo so optimistic writes are never raced", () => {
    expect(
      effectsForFrame({
        type: "data",
        resource: "workspaces",
        id: "w-1",
        origin: CLIENT_INSTANCE_ID,
        at: "now",
      }),
    ).toEqual([{ kind: "none", reason: "own echo" }]);
  });

  it("maps an unknown data resource to no effect", () => {
    expect(
      effectsForFrame({ type: "data", resource: "futures", id: null, origin: null, at: "now" }),
    ).toEqual([{ kind: "none", reason: "unknown data resource" }]);
  });

  it.each(["agent.finished", "agent.awaiting_input", "session.died"] as const)(
    "invalidates the sessions prefix for %s",
    (event) => {
      expect(
        effectsForFrame({
          type: "alert",
          event,
          session_id: "session-1",
          command: event === "session.died" ? null : "codex",
          exit_code: null,
          signal: null,
          at: "now",
        }),
      ).toEqual([{ kind: "invalidate", key: ["sessions"] }]);
    },
  );

  it.each([
    ["alerts.ping", "keepalive only"],
    ["protocol.required", "protocol failure is connection-local"],
    ["session.status", "session lifecycle stays transport-local"],
    ["session.exit", "session lifecycle stays transport-local"],
    ["rtc.config", "signalling stays transport-local"],
    ["rtc.answer", "signalling stays transport-local"],
    ["rtc.candidate", "signalling stays transport-local"],
    ["rtc.status", "signalling stays transport-local"],
    ["future.frame", "unknown realtime frame"],
  ])("maps %s without mutating React Query", (type, reason) => {
    const frame = { type } as RealtimeFrame;
    expect(effectsForFrame(frame)).toEqual([{ kind: "none", reason }]);
  });
});
