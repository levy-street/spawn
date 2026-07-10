import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { AGENT_B_ID, AGENT_ID, agent, mockAuthenticatedApi, SCREEN_ID, screen } from "./app-mocks";

const agentA = agent({ name: "alpha" });
const agentB = agent({ id: AGENT_B_ID, name: "beta", argv: ["bash", "-l"] });

function paneNode(agentId: string) {
  return { type: "pane", agent_id: agentId };
}

async function dragAgent(
  page: Page,
  source: Locator,
  target: Locator,
  position?: { x: number; y: number },
) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  const box = await target.boundingBox();
  const coords = box
    ? {
        clientX: Math.round(box.x + box.width * (position?.x ?? 0.5)),
        clientY: Math.round(box.y + box.height * (position?.y ?? 0.5)),
      }
    : {};
  await target.dispatchEvent("dragenter", { dataTransfer, ...coords });
  await target.dispatchEvent("dragover", { dataTransfer, ...coords });
  await target.dispatchEvent("drop", { dataTransfer, ...coords });
}

test("screens list shows saved arrangements and creates a new screen", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    screens: [screen()],
    createScreen: async (body, route) => {
      createdBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: screen({ ...(body as Record<string, unknown>), id: SCREEN_ID }),
      });
    },
  });

  await page.goto("/screens");
  await expect(page.getByRole("heading", { name: "Screens" })).toBeVisible();
  await expect(page.getByText("daily drive")).toBeVisible();
  await expect(page.getByText("1 tab · 2 agents")).toBeVisible();

  await page.getByRole("button", { name: "New screen" }).click();
  await expect.poll(() => createdBody).toMatchObject({ name: "Screen 2" });
  await page.waitForURL(`**/screens/${SCREEN_ID}`);
});

test("screen renders split panes with mini headers and a resizable divider", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  await expect(page.getByRole("button", { name: "daily drive" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Tab 1" })).toBeVisible();
  await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resize panes" })).toBeVisible();
});

test("dragging the divider persists the new split ratio", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
    updateScreen: async (_id, body, route) => {
      patches.push(body as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...screen(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  const divider = page.getByRole("button", { name: "Resize panes" });
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(() => {
      const last = patches.at(-1) as
        | { layout?: { tabs: Array<{ root: { ratio: number } }> } }
        | undefined;
      return last?.layout?.tabs[0]?.root?.ratio;
    })
    .toBeLessThan(0.5);
});

test("edge drops split the target pane on the chosen side", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen({ layout: { tabs: [{ name: null, root: paneNode(AGENT_ID) }] } })],
    updateScreen: async (_id, body, route) => {
      patches.push(body as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...screen(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();

  // Drop near the bottom edge -> column split with the new pane second.
  const source = page.locator("aside").getByRole("link", { name: /beta/ });
  await dragAgent(page, source, page.getByRole("region", { name: "alpha" }), { x: 0.5, y: 0.92 });

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        tabs: [
          {
            root: {
              type: "split",
              direction: "column",
              a: { type: "pane", agent_id: AGENT_ID },
              b: { type: "pane", agent_id: AGENT_B_ID },
            },
          },
        ],
      },
    });
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
});

test("center drop swaps two panes that are already in the tab", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
    updateScreen: async (_id, body, route) => {
      patches.push(body as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...screen(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  // Drag beta's pane header onto the center of alpha's pane -> swap.
  const betaHeader = page.getByRole("region", { name: "beta" }).locator("div").first();
  await dragAgent(page, betaHeader, page.getByRole("region", { name: "alpha" }), {
    x: 0.5,
    y: 0.5,
  });

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        tabs: [
          {
            root: {
              type: "split",
              direction: "row",
              a: { type: "pane", agent_id: AGENT_B_ID },
              b: { type: "pane", agent_id: AGENT_ID },
            },
          },
        ],
      },
    });
});

test("zoom fills the tab with one pane and restores", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  const alpha = page.getByRole("region", { name: "alpha" });
  const beta = page.getByRole("region", { name: "beta" });
  await expect(beta).toBeVisible();

  await alpha.getByRole("button", { name: "Zoom pane" }).click();
  await expect(beta).toBeHidden();
  // Hidden, not unmounted: beta's pane stays in the DOM so sockets survive.
  // (display:none drops it from the a11y tree, so count via CSS.)
  await expect(page.locator('section[aria-label="beta"]')).toHaveCount(1);

  await alpha.getByRole("button", { name: "Restore pane" }).click();
  await expect(beta).toBeVisible();
});

test("arrange presets rebuild the split tree", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
    updateScreen: async (_id, body, route) => {
      patches.push(body as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...screen(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  await page.getByRole("button", { name: "Tab 1 tab options" }).click();
  await page.getByRole("menuitem", { name: "Even rows" }).click();

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        tabs: [
          {
            root: {
              type: "split",
              direction: "column",
              a: { type: "pane", agent_id: AGENT_ID },
              b: { type: "pane", agent_id: AGENT_B_ID },
            },
          },
        ],
      },
    });
});

test("dropping an agent on another agent's terminal creates a split screen", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
    createScreen: async (body, route) => {
      createdBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: screen({ ...(body as Record<string, unknown>), id: SCREEN_ID }),
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
      layout: {
        tabs: [
          {
            root: {
              type: "split",
              direction: "row",
              a: { type: "pane", agent_id: AGENT_ID },
              b: { type: "pane", agent_id: AGENT_B_ID },
            },
          },
        ],
      },
    });
  await page.waitForURL(`**/screens/${SCREEN_ID}`);
});
