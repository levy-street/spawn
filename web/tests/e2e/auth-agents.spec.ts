import { expect, test } from "@playwright/test";
import { agent, host, mockAuthenticatedApi, PRESET_ID } from "./app-mocks";

test("logged-out root shows the public landing page", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      json: { detail: "not authenticated" },
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "spawn" })).toBeVisible();
  await expect(page.getByText("Browser control for CLI coding agents")).toBeVisible();
});

test("logged-in root shows the dashboard", async ({ page }) => {
  await mockAuthenticatedApi(page, { agents: [agent()] });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("main").getByText("Hosts")).toBeVisible();
  await expect(page.getByText("Recent agents")).toBeVisible();
  await expect(page.getByRole("main").getByText(host.name)).toBeVisible();
});

test("new agent form posts with the authenticated session context", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    createAgent: async (body, route) => {
      createdBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent({ ...(body as Record<string, unknown>), name: "review" }),
      });
    },
  });

  await page.goto("/agents/new");
  await expect(page.getByRole("button", { name: host.name })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Name").fill("review");
  await page.getByRole("button", { name: "Spawn agent" }).click();

  await expect
    .poll(() => createdBody)
    .toMatchObject({
      name: "review",
      host_id: host.id,
      preset_id: PRESET_ID,
      cwd: "/Users/tester",
      create_cwd: true,
    });
  expect(createdBody).not.toHaveProperty("cols");
  expect(createdBody).not.toHaveProperty("rows");
});

test("agent create permission errors are rendered as controlled form errors", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    createAgent: async (_body, route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        json: { detail: "CSRF token missing or invalid" },
      });
    },
  });

  await page.goto("/agents/new");
  await page.getByRole("button", { name: "Spawn agent" }).click();

  await expect(page.getByText("CSRF token missing or invalid")).toBeVisible();
});

test("sidebar agent rows expose actions via kebab menu", async ({ page }) => {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  await mockAuthenticatedApi(page, {
    agents: [agent()],
    updateAgent: async (id, body, route) => {
      patches.push({ id, body: body as Record<string, unknown> });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: agent({ id, ...(body as Record<string, unknown>) }),
      });
    },
  });

  await page.goto("/agents");
  const row = page.locator("aside").getByRole("link", { name: /palette/ });
  await row.hover();
  const kebab = page.locator("aside").getByRole("button", { name: "palette actions" });
  await expect(kebab).toBeVisible();
  await kebab.click();
  await page.getByRole("menuitem", { name: "Pin" }).click();

  await expect.poll(() => patches.at(-1)).toMatchObject({ body: { pinned: true } });
});
