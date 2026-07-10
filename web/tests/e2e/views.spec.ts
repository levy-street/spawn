import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

async function dragAgent(page: Page, source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

test("dragging an agent from the sidebar drops a pane into the active tab", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    views: [view({ layout: { tabs: [{ name: null, agent_ids: [AGENT_ID] }] } })],
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
  await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();

  const source = page.locator("aside").getByRole("link", { name: /beta/ });
  await dragAgent(page, source, page.getByRole("region", { name: "alpha" }));

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({ layout: { tabs: [{ agent_ids: [AGENT_ID, AGENT_B_ID] }] } });
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
});

test("dropping an agent on a tab pill targets that tab", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    views: [
      view({
        layout: {
          tabs: [
            { name: null, agent_ids: [AGENT_ID] },
            { name: "spare", agent_ids: [] },
          ],
        },
      }),
    ],
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
  const source = page.locator("aside").getByRole("link", { name: /beta/ });
  await dragAgent(page, source, page.getByRole("tab", { name: "spare" }));

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: { tabs: [{ agent_ids: [AGENT_ID] }, { agent_ids: [AGENT_B_ID] }] },
    });
});

test("dropping an agent on another agent's terminal creates a split view", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
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

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();

  const source = page.locator("aside").getByRole("link", { name: /beta/ });
  await dragAgent(page, source, page.getByLabel("Agent terminal"));

  await expect
    .poll(() => createdBody)
    .toMatchObject({
      name: "palette · beta",
      layout: { tabs: [{ agent_ids: [AGENT_ID, AGENT_B_ID] }] },
    });
  await page.waitForURL(`**/views/${VIEW_ID}`);
});
