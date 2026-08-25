import {
  filterWorkspaces,
  selectActivePaneId,
  selectActiveSession,
  selectActiveTabId,
  selectOrderedWorkspaces,
  selectTabHome,
  selectTabItems,
  tabStats,
  workspaceRecency,
  workspaceStats,
} from "@/data/selectors/workspace";
import type { AgentDef, DomainSnapshot, Host, Session, Workspace } from "@/data/types/domain";
import type { Tile } from "@/data/types/layout";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: `Session ${id}`,
    host_id: "host",
    host_name: "Mac",
    cwd: `/work/${id}`,
    status: "running",
    started_at: "2026-08-20T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: "2026-08-22T00:00:00Z",
    last_input_at: "2026-08-22T01:00:00Z",
    last_activity_at: "2026-08-22T01:00:00Z",
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: "codex",
    ...overrides,
  };
}

function host(status = "online"): Host {
  return {
    id: "host",
    name: "Mac",
    os: null,
    arch: null,
    version: null,
    daemon_tree: null,
    update: null,
    host_key_algorithm: null,
    host_public_key: null,
    status,
    last_seen_at: null,
    session_count: 2,
    supports_account_chains: false,
    cpu_cores: null,
    cpu_physical_cores: null,
    cpu_model: null,
    memory_bytes: null,
    gpu: null,
    cpu_bucket: null,
    mem_bucket: null,
    capacity_at: null,
  };
}

const AGENT: AgentDef = {
  id: "codex",
  owner_user_id: null,
  name: "codex",
  kind: "codex",
  command: "codex",
  env: {},
  install: null,
  yolo_args: null,
  yolo_env: {},
  yolo: false,
};

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  const tiles: Tile[] = [
    { session_id: "active", x: 0, y: 0, w: 8, h: 24 },
    { session_id: "dead", x: 8, y: 0, w: 8, h: 24 },
    {
      session_id: "files",
      x: 16,
      y: 0,
      w: 8,
      h: 24,
      widget: { kind: "files", host_id: "host", path: "/work" },
    },
  ];
  return {
    id: "workspace",
    name: "Spawn",
    host_id: "host",
    cwd: "/workspace-home",
    layout: {
      version: 3,
      active_tab: "one",
      tabs: [
        { id: "one", name: "One", host_id: null, cwd: null, layout: { version: 3, tiles } },
        {
          id: "two",
          name: "Two",
          host_id: "host",
          cwd: "/tab-home",
          layout: { version: 3, tiles: [] },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    ...overrides,
  };
}

function snapshot(current: Workspace = workspace()): DomainSnapshot {
  return {
    workspacesById: new Map([[current.id, current]]),
    sessionsById: new Map([
      [
        "active",
        session("active", { activity_state: "waiting", activity_label: "Awaiting input" }),
      ],
      [
        "dead",
        session("dead", { status: "exited", activity_state: "exited", activity_label: "Exited" }),
      ],
    ]),
    hostsById: new Map([["host", host()]]),
    agents: [AGENT],
  };
}

describe("workspace rollups", () => {
  it("computes per-tab and per-workspace counts without treating widgets as sessions", () => {
    const state = snapshot();
    const current = workspace();
    const stats = tabStats(
      current.layout.tabs[0] as NonNullable<(typeof current.layout.tabs)[0]>,
      state.sessionsById,
    );

    expect(stats).toMatchObject({
      tiles: 3,
      terminals: 2,
      widgets: 1,
      running: 1,
      waiting: 1,
      dead: 1,
      attention: 2,
      nominalRemaining: 13,
      canAdd: true,
    });
    expect(workspaceStats(current, state.sessionsById)).toMatchObject({
      tabs: 2,
      tiles: 3,
      terminals: 2,
      widgets: 1,
      attention: 2,
      remainingTabs: 6,
      nominalRemainingPanes: 29,
      archived: false,
    });
  });

  it("returns zeroed representative values for empty layouts", () => {
    const empty = workspace({
      layout: {
        version: 3,
        active_tab: "empty",
        tabs: [
          {
            id: "empty",
            name: "Empty",
            host_id: null,
            cwd: null,
            layout: { version: 3, tiles: [] },
          },
        ],
      },
    });
    expect(workspaceStats(empty, new Map())).toMatchObject({
      tabs: 1,
      tiles: 0,
      terminals: 0,
      widgets: 0,
      attention: 0,
      nominalRemainingPanes: 16,
    });
  });

  it("uses newest session input for recency with workspace update as fallback", () => {
    const current = workspace();
    expect(workspaceRecency(current, snapshot().sessionsById)).toBe(
      Date.parse("2026-08-22T01:00:00Z"),
    );
    expect(workspaceRecency(current, new Map())).toBe(Date.parse(current.updated_at));
  });
});

describe("workspace selection and ordering", () => {
  it("applies explicit, focus, device, persisted, then first-tab precedence", () => {
    const current = workspace();
    expect(selectActiveTabId(current, { explicitTabId: "two", focusPaneId: "active" })).toBe("two");
    expect(selectActiveTabId(current, { focusPaneId: "active", deviceTabId: "two" })).toBe("one");
    expect(selectActiveTabId(current, { deviceTabId: "two" })).toBe("two");
    expect(
      selectActiveTabId({ ...current, layout: { ...current.layout, active_tab: "missing" } }, {}),
    ).toBe("one");
  });

  it("selects a retained pane/session or the first geometry-ordered fallback", () => {
    const tab = workspace().layout.tabs[0] as NonNullable<Workspace["layout"]["tabs"][0]>;
    expect(selectActivePaneId(tab, "dead")).toBe("dead");
    expect(selectActivePaneId(tab, "missing")).toBe("active");
    expect(selectActiveSession(tab, snapshot().sessionsById, "dead")?.id).toBe("dead");
    expect(selectActiveSession(tab, snapshot().sessionsById, "files")?.id).toBe("active");
  });

  it("resolves complete tab homes, then complete workspace homes", () => {
    const current = workspace();
    expect(selectTabHome(current, "two")).toEqual({ host_id: "host", cwd: "/tab-home" });
    expect(selectTabHome(current, "one")).toEqual({ host_id: "host", cwd: "/workspace-home" });
    expect(selectTabHome({ ...current, host_id: null }, "one")).toBeNull();
  });

  it("sorts active and archived workspaces without mutating source and filters normalized names", () => {
    const active = [
      workspace({ id: "second", name: "Beta Project", position: 1 }),
      workspace({ id: "first", name: "Alpha Project", position: 0 }),
    ];
    expect(
      selectOrderedWorkspaces(
        { ...snapshot(), workspacesById: new Map(active.map((item) => [item.id, item])) },
        false,
      ).map((item) => item.id),
    ).toEqual(["first", "second"]);
    expect(filterWorkspaces(active, "  beta ").map((item) => item.id)).toEqual(["second"]);
    expect(active[0]?.id).toBe("second");

    const archived = [
      workspace({ id: "old", archived_at: "2026-08-20T00:00:00Z" }),
      workspace({ id: "new", archived_at: "2026-08-22T00:00:00Z" }),
    ];
    expect(
      selectOrderedWorkspaces(
        { ...snapshot(), workspacesById: new Map(archived.map((item) => [item.id, item])) },
        true,
      ).map((item) => item.id),
    ).toEqual(["new", "old"]);
  });
});

describe("tab pane projections", () => {
  it("projects terminal and files rows in geometry order", () => {
    const items = selectTabItems(snapshot(), "workspace", "one");
    expect(items.map((item) => item.kind)).toEqual(["terminal", "terminal", "files"]);
    expect(items[0]).toMatchObject({
      sessionId: "active",
      typeLabel: "Codex",
      statusTone: "waiting",
      attention: "waiting",
      running: true,
    });
    expect(items[2]).toMatchObject({ hostId: "host", path: "/work", hostOnline: true });
  });

  it("preserves unknown widget rows as non-terminal unavailable projections", () => {
    const current = workspace();
    const unknown = {
      ...current,
      layout: {
        ...current.layout,
        tabs: [
          {
            ...(current.layout.tabs[0] as NonNullable<Workspace["layout"]["tabs"][0]>),
            layout: {
              version: 3 as const,
              tiles: [
                {
                  session_id: "future",
                  x: 0,
                  y: 0,
                  w: 24,
                  h: 24,
                  widget: { kind: "future", data: true },
                },
              ],
            },
          },
        ],
      },
    };
    expect(selectTabItems(snapshot(unknown), "workspace", "one")).toEqual([
      expect.objectContaining({ paneId: "future", kind: "missing", statusTone: "offline" }),
    ]);
  });

  it("returns an empty projection when workspace or tab is absent", () => {
    expect(selectTabItems(snapshot(), "missing", "one")).toEqual([]);
    expect(selectTabItems(snapshot(), "workspace", "missing")).toEqual([]);
  });
});
