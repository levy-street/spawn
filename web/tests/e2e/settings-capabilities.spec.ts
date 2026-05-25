import { expect, test } from "@playwright/test";
import {
  agent,
  host,
  MCP_SERVER_ID,
  mcpServer,
  mockAuthenticatedApi,
  PRESET_ID,
  SKILL_ID,
  skill,
} from "./app-mocks";

test("settings can create MCP servers, spawn MCP, and skills", async ({ page }) => {
  let spawnMcpBody: Record<string, unknown> | null = null;
  let customMcpBody: Record<string, unknown> | null = null;
  let skillBody: Record<string, unknown> | null = null;

  await mockAuthenticatedApi(page, {
    mcpServers: [mcpServer({ name: "existing docs", enabled_by_default: true })],
    skills: [skill({ name: "existing review", enabled_by_default: true })],
    createSpawnMcpServer: async (body, route) => {
      spawnMcpBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: mcpServer({ ...(body as Record<string, unknown>), name: "spawn" }),
      });
    },
    createMcpServer: async (body, route) => {
      customMcpBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: mcpServer({ ...(body as Record<string, unknown>), name: "docs" }),
      });
    },
    createSkill: async (body, route) => {
      skillBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: skill({ ...(body as Record<string, unknown>), name: "triage" }),
      });
    },
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("existing docs")).toBeVisible();
  await expect(page.getByText("existing review")).toBeVisible();

  await page.getByRole("button", { name: "Add Spawn MCP" }).click();
  await expect
    .poll(() => spawnMcpBody)
    .toMatchObject({
      name: "spawn",
      enabled_by_default: false,
    });

  await page.locator("#mcp-name").fill("docs");
  await page.locator("#mcp-url").fill("https://docs.example/mcp");
  await page.locator("#mcp-headers").fill("Authorization=Bearer token\nX_TEAM=spawn");
  await page.getByRole("button", { name: "Add server" }).click();
  await expect
    .poll(() => customMcpBody)
    .toMatchObject({
      name: "docs",
      transport: "streamable_http",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer token", X_TEAM: "spawn" },
      enabled_by_default: false,
    });

  const skillsForm = page.locator("form").filter({ has: page.locator("#skill-content") });
  await skillsForm.locator("#skill-name").fill("triage");
  await skillsForm.locator("#skill-description").fill("Triage changed files");
  await skillsForm.locator("#skill-content").fill("Inspect the current diff and report issues.");
  await skillsForm.getByLabel("Grant to new agents by default").check();
  await skillsForm.getByRole("button", { name: "Add skill" }).click();
  await expect
    .poll(() => skillBody)
    .toMatchObject({
      name: "triage",
      description: "Triage changed files",
      content: "Inspect the current diff and report issues.",
      enabled_by_default: true,
    });
});

test("new agent form sends selected MCP servers and skills", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    mcpServers: [mcpServer({ id: MCP_SERVER_ID, name: "spawn MCP", enabled_by_default: true })],
    skills: [skill({ id: SKILL_ID, name: "review skill", enabled_by_default: true })],
    createAgent: async (body, route) => {
      createdBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent({ ...(body as Record<string, unknown>), name: "capability-check" }),
      });
    },
  });

  await page.goto("/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByLabel("spawn MCP")).toBeChecked();
  await expect(page.getByLabel("review skill")).toBeChecked();
  await page.getByLabel("Name").fill("capability-check");
  await page.getByRole("button", { name: "Spawn" }).click();

  await expect
    .poll(() => createdBody)
    .toMatchObject({
      name: "capability-check",
      host_id: host.id,
      preset_id: PRESET_ID,
      mcp_server_ids: [MCP_SERVER_ID],
      skill_ids: [SKILL_ID],
    });
});

test("settings can edit and delete MCP servers and skills", async ({ page }) => {
  let mcpPatch: { id: string; body: Record<string, unknown> } | null = null;
  let mcpDeleteId: string | null = null;
  let skillPatch: { id: string; body: Record<string, unknown> } | null = null;
  let skillDeleteId: string | null = null;

  page.on("dialog", (dialog) => dialog.accept());

  await mockAuthenticatedApi(page, {
    mcpServers: [mcpServer({ id: MCP_SERVER_ID, name: "existing docs" })],
    skills: [skill({ id: SKILL_ID, name: "existing review" })],
    updateMcpServer: async (id, body, route) => {
      mcpPatch = { id, body: body as Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: mcpServer({ id, ...(body as Record<string, unknown>) }),
      });
    },
    deleteMcpServer: async (id, route) => {
      mcpDeleteId = id;
      await route.fulfill({ status: 204 });
    },
    updateSkill: async (id, body, route) => {
      skillPatch = { id, body: body as Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: skill({ id, ...(body as Record<string, unknown>) }),
      });
    },
    deleteSkill: async (id, route) => {
      skillDeleteId = id;
      await route.fulfill({ status: 204 });
    },
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit MCP server existing docs" }).click();
  await page.locator("#mcp-url").fill("https://updated.example/mcp");
  await page.getByLabel("Grant to new agents by default").first().check();
  await page.getByRole("button", { name: "Update server" }).click();
  await expect
    .poll(() => mcpPatch)
    .toMatchObject({
      id: MCP_SERVER_ID,
      body: {
        name: "existing docs",
        transport: "streamable_http",
        url: "https://updated.example/mcp",
        enabled_by_default: true,
      },
    });

  await page.getByRole("button", { name: "Delete MCP server existing docs" }).click();
  await expect.poll(() => mcpDeleteId).toBe(MCP_SERVER_ID);

  await page.getByRole("button", { name: "Edit skill existing review" }).click();
  await page.locator("#skill-description").fill("Updated review guidance");
  await page.locator("#skill-content").fill("Review the diff and identify regressions.");
  await page.getByRole("button", { name: "Update skill" }).click();
  await expect
    .poll(() => skillPatch)
    .toMatchObject({
      id: SKILL_ID,
      body: {
        name: "existing review",
        description: "Updated review guidance",
        content: "Review the diff and identify regressions.",
      },
    });

  await page.getByRole("button", { name: "Delete skill existing review" }).click();
  await expect.poll(() => skillDeleteId).toBe(SKILL_ID);
});
