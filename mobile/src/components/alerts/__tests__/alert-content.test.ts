import { alertBody, alertTitle, alertToastMessage } from "@/components/alerts/alert-content";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import type { AgentDef, Session } from "@/data/types/domain";

const AGENT: AgentDef = {
  id: "agent-1",
  owner_user_id: "owner-1",
  name: "My Helper",
  kind: "custom",
  command: "helper",
  env: {},
  install: null,
  yolo_args: null,
  yolo_env: {},
  yolo: false,
};

const SESSION: Session = {
  id: "session-12345678",
  name: "spawn",
  host_id: "host-1",
  host_name: "Mac",
  cwd: "/work/spawn",
  status: "running",
  started_at: "2026-08-22T00:00:00Z",
  exited_at: null,
  exit_code: null,
  last_output_at: "2026-08-22T00:01:00Z",
  last_input_at: null,
  last_activity_at: "2026-08-22T00:01:00Z",
  activity_state: "waiting",
  activity_label: "Awaiting input",
  foreground_command: "helper",
};

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    event: "agent.finished",
    session_id: SESSION.id,
    command: "helper",
    exit_code: null,
    signal: null,
    at: "2026-08-22T00:02:00Z",
    ...overrides,
  };
}

describe("alert content", () => {
  it("maps each event to the exact person-facing title", () => {
    expect(alertTitle(alert(), [AGENT])).toBe("My Helper finished");
    expect(alertTitle(alert({ event: "agent.awaiting_input" }), [AGENT])).toBe(
      "My Helper is waiting for you",
    );
    expect(alertTitle(alert({ event: "session.died", signal: "SIGKILL" }), [AGENT])).toBe(
      "My Helper was killed",
    );
    expect(alertTitle(alert({ event: "session.died", command: null, signal: null }), [AGENT])).toBe(
      "Session exited",
    );
  });

  it("builds a concise location without repeating the folder", () => {
    const context = { session: SESSION, agents: [AGENT], workspaceName: "Project" };
    expect(alertBody(alert(), context)).toBe("Project · spawn");
    expect(alertToastMessage(alert(), context)).toBe("My Helper finished: Project · spawn");
  });

  it("adds exit detail and has a safe missing-session fallback", () => {
    expect(
      alertBody(alert({ event: "session.died", exit_code: 137 }), {
        session: SESSION,
        agents: [AGENT],
      }),
    ).toBe("spawn · exit 137");
    expect(alertBody(alert({ session_id: "abcdefgh-more" }))).toBe("Session abcdefgh");
  });
});
