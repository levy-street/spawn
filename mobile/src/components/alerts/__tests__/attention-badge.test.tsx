import { render, screen, waitFor } from "@testing-library/react-native";

import { AttentionBadge, attentionAccessibilityLabel } from "@/components/alerts/attention-badge";
import {
  attentionSummaryFromCounts,
  findAlertPlacement,
  sessionAttentionSummary,
  tabAttentionSummary,
  workspaceAttentionSummary,
} from "@/data/queries/alerts";
import type { Session, Workspace } from "@/data/types/domain";
import { ThemeProvider } from "@/theme";

jest.mock("expo-notifications", () => ({}));

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    host_id: "host-1",
    host_name: "Mac",
    cwd: `/work/${id}`,
    status: "running",
    started_at: "2026-08-22T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: "2026-08-22T00:01:00Z",
    last_input_at: null,
    last_activity_at: "2026-08-22T00:01:00Z",
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: "codex",
    agent_id: null,
    agent_session_id: null,
    ...overrides,
  };
}

function workspace(): Workspace {
  return {
    id: "workspace-1",
    name: "Project",
    host_id: "host-1",
    cwd: "/work",
    layout: {
      version: 3,
      active_tab: "tab-1",
      tabs: [
        {
          id: "tab-1",
          name: "Main",
          host_id: null,
          cwd: null,
          layout: {
            version: 3,
            tiles: [
              { session_id: "waiting", x: 0, y: 0, w: 8, h: 24 },
              { session_id: "dead", x: 8, y: 0, w: 8, h: 24 },
              {
                session_id: "files-widget",
                x: 16,
                y: 0,
                w: 8,
                h: 24,
                widget: { kind: "files", host_id: "host-1", path: "/work" },
              },
            ],
          },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}

const SESSIONS = new Map<string, Session>([
  ["waiting", session("waiting", { activity_state: "waiting" })],
  ["dead", session("dead", { status: "killed", activity_state: "killed" })],
]);

describe("attention selector wiring", () => {
  it("gives dead attention precedence while retaining the complete count", () => {
    expect(attentionSummaryFromCounts(2, 1)).toEqual({
      total: 3,
      waiting: 2,
      dead: 1,
      highest: "dead",
    });
    expect(attentionSummaryFromCounts(0, 0)).toBeNull();
  });

  it("computes session, tab, and workspace summaries from domain selectors", () => {
    const current = workspace();
    expect(sessionAttentionSummary(SESSIONS.get("waiting") as Session)?.highest).toBe("waiting");
    expect(sessionAttentionSummary(session("quiet"))).toBeNull();
    expect(
      tabAttentionSummary(current.layout.tabs[0] as Workspace["layout"]["tabs"][0], SESSIONS),
    ).toEqual({
      total: 2,
      waiting: 1,
      dead: 1,
      highest: "dead",
    });
    expect(workspaceAttentionSummary(current, SESSIONS)?.total).toBe(2);
  });

  it("finds the real session placement without treating a files widget as a terminal", () => {
    const current = workspace();
    expect(findAlertPlacement([current], "waiting")).toMatchObject({
      workspace: current,
      tabId: "tab-1",
    });
    expect(findAlertPlacement([current], "files-widget")).toBeNull();
  });
});

describe("AttentionBadge", () => {
  it("renders a counted badge with a complete accessible description", async () => {
    const summary = attentionSummaryFromCounts(1, 1);
    await render(
      <ThemeProvider>
        <AttentionBadge summary={summary} testID="attention" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("attention-count")).toHaveTextContent("2");
    expect(
      screen.getByRole("image", {
        name: "1 session exited or killed, 1 session awaiting input",
      }),
    ).toBeOnTheScreen();
    expect(summary ? attentionAccessibilityLabel(summary) : "").toContain("awaiting input");
  });

  it("supports a compact dot and renders nothing without attention", async () => {
    const { rerender } = await render(
      <ThemeProvider>
        <AttentionBadge display="dot" summary={attentionSummaryFromCounts(1, 0)} testID="dot" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("dot-dot", { includeHiddenElements: true })).toBeOnTheScreen();

    rerender(
      <ThemeProvider>
        <AttentionBadge summary={null} testID="dot" />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("dot")).not.toBeOnTheScreen();
    });
  });
});
