import { expect, test } from "@playwright/test";
import { AGENT_B_ID, AGENT_ID, agent, mockAuthenticatedApi, VIEW_ID, view } from "./app-mocks";

const agentA = agent({ name: "alpha" });
const agentB = agent({ id: AGENT_B_ID, name: "beta", argv: ["bash", "-l"] });

test("views list shows saved arrangements and creates a new view", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    views: [view()],
    createView: async (body, route) => {
      createdBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: view({ ...(body as Record<string, unknown>), id: VIEW_ID }),
      });
    },
  });

  await page.goto("/views");
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(page.getByText("daily drive")).toBeVisible();
  await expect(page.getByText("1 tab · 2 agents")).toBeVisible();

  await page.getByRole("button", { name: "New view" }).click();
  await expect.poll(() => createdBody).toMatchObject({ name: "View 2" });
  await page.waitForURL(`**/views/${VIEW_ID}`);
});

test("view screen renders tab strip and a mini header per pane", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    views: [view()],
  });

  await page.goto(`/views/${VIEW_ID}`);
  await expect(page.getByRole("button", { name: "daily drive" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Tab 1" })).toBeVisible();

  // One mini header per split, each carrying the agent identity.
  await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
});

test("adding a tab and removing a pane persist the layout", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    views: [view()],
    updateView: async (_id, body, route) => {
      patches.push(body as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...view(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/views/${VIEW_ID}`);
  await page.getByRole("button", { name: "New tab" }).first().click();
  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        tabs: [{ agent_ids: [AGENT_ID, AGENT_B_ID] }, { agent_ids: [] }],
      },
    });
  await expect(page.getByRole("tab", { name: "Tab 2" })).toBeVisible();

  // Back to the first tab; remove beta's pane.
  await page.getByRole("tab", { name: "Tab 1" }).click();
  await page
    .getByRole("region", { name: "beta" })
    .getByRole("button", { name: "Remove pane" })
    .click();
  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        tabs: [{ agent_ids: [AGENT_ID] }, { agent_ids: [] }],
      },
    });
  await expect(page.getByRole("region", { name: "beta" })).toHaveCount(0);
});
