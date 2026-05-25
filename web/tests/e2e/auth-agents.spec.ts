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
  await expect(page.getByText(host.name)).toBeVisible();
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

  await page.goto("/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Name").fill("review");
  await page.getByRole("button", { name: "Spawn" }).click();

  await expect
    .poll(() => createdBody)
    .toMatchObject({
      name: "review",
      host_id: host.id,
      preset_id: PRESET_ID,
      cwd: "/Users/tester",
      cols: 120,
      rows: 32,
      create_cwd: true,
    });
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

  await page.goto("/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("button", { name: "Spawn" }).click();

  await expect(page.getByText("CSRF token missing or invalid")).toBeVisible();
});
