import type { Page, Route } from "@playwright/test";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const HOST_ID = "00000000-0000-4000-8000-000000000002";
export const PRESET_ID = "00000000-0000-4000-8000-000000000003";
export const AGENT_ID = "00000000-0000-4000-8000-000000000004";
export const SKILL_ID = "00000000-0000-4000-8000-000000000006";
export const SCREEN_ID = "00000000-0000-4000-8000-000000000007";
export const AGENT_B_ID = "00000000-0000-4000-8000-000000000008";
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

export function screen(overrides: Record<string, unknown> = {}) {
  return {
    id: SCREEN_ID,
    name: "daily drive",
    layout: {
      root: {
        type: "split",
        direction: "row",
        ratio: 0.5,
        a: { type: "pane", agent_id: AGENT_ID },
        b: { type: "pane", agent_id: AGENT_B_ID },
      },
    },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

export function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "notes.txt",
    path: "/Users/tester/notes.txt",
    is_dir: false,
    size: 2048,
    modified_at: 1750000000,
    ...overrides,
  };
}

export function fileListing(overrides: Record<string, unknown> = {}) {
  return {
    path: "/Users/tester",
    home_dir: "/Users/tester",
    parent: "/Users",
    entries: [
      fileEntry({ name: "projects", path: "/Users/tester/projects", is_dir: true, size: null }),
      fileEntry(),
    ],
    error: null,
    ...overrides,
  };
}

export async function mockAuthenticatedApi(
  page: Page,
  options: {
    agents?: unknown[];
    hosts?: unknown[];
    screens?: unknown[];
    updateScreen?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    createScreen?: (body: unknown, route: Route) => Promise<void> | void;
    skills?: unknown[];
    createAgent?: (body: unknown, route: Route) => Promise<void> | void;
    updateAgent?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    createSkill?: (body: unknown, route: Route) => Promise<void> | void;
    updateSkill?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    deleteSkill?: (id: string, route: Route) => Promise<void> | void;
    files?: (hostId: string, path: string | null) => unknown;
    fileUpload?: (hostId: string, route: Route) => Promise<void> | void;
    fileMkdir?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
    fileDelete?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
    fileTransfer?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  } = {},
) {
  const agents = options.agents ?? [];
  const hostList = options.hosts ?? [host];
  const screenList = options.screens ?? [];
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
      await route.fulfill({ status: 200, contentType: "application/json", json: hostList });
      return;
    }
    const filesMatch = path.match(/^\/api\/hosts\/([^/]+)\/files(?:\/([a-z]+))?$/);
    if (filesMatch) {
      const [, hostId, op] = filesMatch;
      if (!op && method === "GET") {
        const listing = options.files?.(hostId, url.searchParams.get("path")) ?? fileListing();
        await route.fulfill({ status: 200, contentType: "application/json", json: listing });
        return;
      }
      if (op === "download" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { "Content-Disposition": 'attachment; filename="notes.txt"' },
          body: Buffer.from("hi"),
        });
        return;
      }
      if (op === "upload" && method === "POST") {
        if (options.fileUpload) {
          await options.fileUpload(hostId, route);
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { path: "/Users/tester/upload.txt" },
        });
        return;
      }
      if ((op === "mkdir" || op === "delete" || op === "transfer") && method === "POST") {
        const body = await request.postDataJSON();
        const handler =
          op === "mkdir"
            ? options.fileMkdir
            : op === "delete"
              ? options.fileDelete
              : options.fileTransfer;
        if (handler) {
          await handler(hostId, body, route);
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { path: (body as { path?: string }).path ?? null },
        });
        return;
      }
    }
    if (path.match(/^\/api\/hosts\/[^/]+$/) && method === "GET") {
      const id = path.split("/").at(-1) ?? "";
      const match = (hostList as Array<{ id?: string }>).find((h) => h.id === id);
      await route.fulfill({
        status: match ? 200 : 404,
        contentType: "application/json",
        json: match ?? { detail: "host not found" },
      });
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
    if (path === "/api/screens" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: screenList });
      return;
    }
    if (path === "/api/screens" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createScreen) {
        await options.createScreen(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: screen({ ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "GET") {
      const id = path.split("/").at(-1) ?? "";
      const match = (screenList as Array<{ id?: string }>).find((v) => v.id === id);
      await route.fulfill({
        status: match ? 200 : 404,
        contentType: "application/json",
        json: match ?? { detail: "screen not found" },
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateScreen) {
        await options.updateScreen(id, body, route);
        return;
      }
      const match = (screenList as Array<Record<string, unknown>>).find((v) => v.id === id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...(match ?? screen()), ...(body as Record<string, unknown>) },
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "DELETE") {
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
    if (path.match(/^\/api\/agents\/[^/]+$/) && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateAgent) {
        await options.updateAgent(id, body, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: agent({ id, ...(body as Record<string, unknown>) }),
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
        json: { agent_id: AGENT_ID, skills: [] },
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
