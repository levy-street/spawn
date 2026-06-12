import type { Page, Route } from "@playwright/test";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const HOST_ID = "00000000-0000-4000-8000-000000000002";
export const PRESET_ID = "00000000-0000-4000-8000-000000000003";
export const AGENT_ID = "00000000-0000-4000-8000-000000000004";
export const MCP_SERVER_ID = "00000000-0000-4000-8000-000000000005";
export const SKILL_ID = "00000000-0000-4000-8000-000000000006";
export const CREATED_AT = "2026-05-24T00:00:00Z";

export const user = {
  id: USER_ID,
  email: "tester@example.com",
  created_at: CREATED_AT,
};

export const host = {
  id: HOST_ID,
  name: "Mac",
  os: "macos",
  arch: "aarch64",
  version: "0.1.0",
  status: "online",
  last_seen_at: CREATED_AT,
  agent_count: 1,
  home_dir: "/Users/tester",
};

export const preset = {
  id: PRESET_ID,
  owner_user_id: null,
  name: "codex",
  agent_kind: "codex",
  default_argv: ["codex"],
  env_template: {},
  install: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
};

export function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: "palette",
    tmux_session: `spawn-palette--${AGENT_ID}`,
    host_id: HOST_ID,
    host_name: "Mac",
    preset_id: PRESET_ID,
    cwd: "/Users/tester/projects/spawn",
    argv: ["codex"],
    env: {},
    status: "running",
    started_at: CREATED_AT,
    exited_at: null,
    last_output_at: CREATED_AT,
    last_input_at: null,
    last_activity_at: CREATED_AT,
    activity_state: "quiet",
    activity_label: "Quiet",
    exit_code: null,
    pinned_at: null,
    archived_at: null,
    ...overrides,
  };
}

export function mcpServer(overrides: Record<string, unknown> = {}) {
  return {
    id: MCP_SERVER_ID,
    owner_user_id: USER_ID,
    name: "spawn MCP",
    transport: "streamable_http",
    url: "http://localhost:3002/mcp",
    command: null,
    args: [],
    env: {},
    headers: {},
    enabled_by_default: false,
    created_at: CREATED_AT,
    ...overrides,
  };
}

export function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: SKILL_ID,
    owner_user_id: USER_ID,
    name: "review skill",
    description: "Review local changes",
    content: "Use /review on the current diff.",
    enabled_by_default: false,
    created_at: CREATED_AT,
    ...overrides,
  };
}

export async function mockAuthenticatedApi(
  page: Page,
  options: {
    agents?: unknown[];
    mcpServers?: unknown[];
    skills?: unknown[];
    createAgent?: (body: unknown, route: Route) => Promise<void> | void;
    createMcpServer?: (body: unknown, route: Route) => Promise<void> | void;
    createSpawnMcpServer?: (body: unknown, route: Route) => Promise<void> | void;
    updateMcpServer?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    deleteMcpServer?: (id: string, route: Route) => Promise<void> | void;
    createSkill?: (body: unknown, route: Route) => Promise<void> | void;
    updateSkill?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    deleteSkill?: (id: string, route: Route) => Promise<void> | void;
  } = {},
) {
  const agents = options.agents ?? [];
  const mcpServerList = options.mcpServers ?? [];
  const skillList = options.skills ?? [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/me") {
      await route.fulfill({ status: 200, contentType: "application/json", json: { user } });
      return;
    }
    if (path === "/api/hosts") {
      await route.fulfill({ status: 200, contentType: "application/json", json: [host] });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}/tools`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { tools: [] },
      });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}/dirs`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          path: url.searchParams.get("path") ?? host.home_dir,
          home_dir: host.home_dir,
          parent: "/Users",
          entries: [{ name: "projects", path: "/Users/tester/projects" }],
          error: null,
        },
      });
      return;
    }
    if (path === "/api/presets") {
      await route.fulfill({ status: 200, contentType: "application/json", json: [preset] });
      return;
    }
    if (path === "/api/mcp-servers" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: mcpServerList });
      return;
    }
    if (path === "/api/mcp-servers" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createMcpServer) {
        await options.createMcpServer(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: mcpServer({ ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path === "/api/mcp-servers/spawn" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createSpawnMcpServer) {
        await options.createSpawnMcpServer(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: mcpServer({
          ...(body as Record<string, unknown>),
          name: (body as { name?: string }).name ?? "spawn",
        }),
      });
      return;
    }
    if (path.startsWith("/api/mcp-servers/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateMcpServer) {
        await options.updateMcpServer(id, body, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: mcpServer({ id, ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/mcp-servers/") && method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (options.deleteMcpServer) {
        await options.deleteMcpServer(id, route);
        return;
      }
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/skills" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: skillList });
      return;
    }
    if (path === "/api/skills" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createSkill) {
        await options.createSkill(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: skill({ ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/skills/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateSkill) {
        await options.updateSkill(id, body, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: skill({ id, ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/skills/") && method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (options.deleteSkill) {
        await options.deleteSkill(id, route);
        return;
      }
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/agents" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: agents });
      return;
    }
    if (path === "/api/agents" && method === "POST") {
      if (options.createAgent) {
        await options.createAgent(await request.postDataJSON(), route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent(await request.postDataJSON()),
      });
      return;
    }
    if (path === `/api/agents/${AGENT_ID}`) {
      await route.fulfill({ status: 200, contentType: "application/json", json: agent() });
      return;
    }
    if (path === `/api/agents/${AGENT_ID}/access`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { agent_id: AGENT_ID, mcp_servers: [], skills: [] },
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      json: { detail: `unmocked ${method} ${path}` },
    });
  });
}
