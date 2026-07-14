import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { AGENT_B_ID, AGENT_ID, agent, mockAuthenticatedApi, SCREEN_ID, screen } from "./app-mocks";

const agentA = agent({ name: "alpha" });
const agentB = agent({ id: AGENT_B_ID, name: "beta", argv: ["bash", "-l"] });
const SCREEN_B_ID = "00000000-0000-4000-8000-000000000009";

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

test("empty state offers the first screen and forwards to it", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    screens: [],
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
  await expect(page.getByRole("heading", { name: "No screens yet" })).toBeVisible();
  await page.getByRole("button", { name: "Add screen" }).click();
  await expect.poll(() => createdBody).toMatchObject({ name: "Screen 1" });
  await page.waitForURL(`**/screens/${SCREEN_ID}`);
});

test("screens render as tabs along the top and switch on click", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen(), screen({ id: SCREEN_B_ID, name: "second", layout: { root: null } })],
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  await expect(page.getByRole("tab", { name: "daily drive" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resize panes" })).toBeVisible();

  await page.getByRole("tab", { name: "second" }).click();
  await page.waitForURL(`**/screens/${SCREEN_B_ID}`);
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
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
      const last = patches.at(-1) as { layout?: { root: { ratio: number } } } | undefined;
      return last?.layout?.root?.ratio;
    })
    .toBeLessThan(0.5);
});

test("edge drops split the target pane on the chosen side", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen({ layout: { root: paneNode(AGENT_ID) } })],
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
        root: {
          type: "split",
          direction: "column",
          a: { type: "pane", agent_id: AGENT_ID },
          b: { type: "pane", agent_id: AGENT_B_ID },
        },
      },
    });
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
});

test("center drop swaps two panes that are already on the screen", async ({ page }) => {
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
  const betaHeader = page.getByRole("region", { name: "beta" }).locator("div").first();
  await dragAgent(page, betaHeader, page.getByRole("region", { name: "alpha" }), {
    x: 0.5,
    y: 0.5,
  });

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        root: {
          type: "split",
          direction: "row",
          a: { type: "pane", agent_id: AGENT_B_ID },
          b: { type: "pane", agent_id: AGENT_ID },
        },
      },
    });
});

test("dropping a pane on another screen's tab moves it across screens", async ({ page }) => {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen(), screen({ id: SCREEN_B_ID, name: "second", layout: { root: null } })],
    updateScreen: async (id, body, route) => {
      patches.push({ id, body: body as Record<string, unknown> });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...screen(), ...(body as Record<string, unknown>) },
      });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  const betaHeader = page.getByRole("region", { name: "beta" }).locator("div").first();
  await dragAgent(page, betaHeader, page.getByRole("tab", { name: "second" }));

  // Target screen gains the pane; the current screen loses it.
  await expect
    .poll(() => patches.find((p) => p.id === SCREEN_B_ID)?.body)
    .toMatchObject({ layout: { root: { type: "pane", agent_id: AGENT_B_ID } } });
  await expect
    .poll(() => patches.find((p) => p.id === SCREEN_ID)?.body)
    .toMatchObject({ layout: { root: { type: "pane", agent_id: AGENT_ID } } });
  await expect(page.getByRole("region", { name: "beta" })).toHaveCount(0);
});

test("zoom fills the screen with one pane and restores", async ({ page }) => {
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

test("pane kebab exposes agent actions and restarts the agent", async ({ page }) => {
  let restarted = false;
  await mockAuthenticatedApi(page, {
    agents: [agentA, agentB],
    screens: [screen()],
    restartAgent: async (id, route) => {
      if (id === AGENT_ID) restarted = true;
      await route.fulfill({ status: 200, contentType: "application/json", json: agentA });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  const alpha = page.getByRole("region", { name: "alpha" });
  await alpha.getByRole("button", { name: "alpha pane actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Open full page" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Restart agent" }).click();
  await expect.poll(() => restarted).toBe(true);
});

test("waiting agents surface an attention badge on the screen tab", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [agent({ name: "alpha", activity_state: "waiting", activity_label: "Awaiting input" }), agentB],
    screens: [screen()],
  });
  await page.goto(`/screens/${SCREEN_ID}`);
  // The active tab shows a "1" attention count for the one waiting pane.
  const tab = page.getByRole("tab", { name: /daily drive/ });
  await expect(tab).toContainText("1");
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
  await page.getByRole("button", { name: "daily drive options" }).click();
  await page.getByRole("menuitem", { name: "Even rows" }).click();

  await expect
    .poll(() => patches.at(-1))
    .toMatchObject({
      layout: {
        root: {
          type: "split",
          direction: "column",
          a: { type: "pane", agent_id: AGENT_ID },
          b: { type: "pane", agent_id: AGENT_B_ID },
        },
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
        root: {
          type: "split",
          direction: "row",
          a: { type: "pane", agent_id: AGENT_ID },
          b: { type: "pane", agent_id: AGENT_B_ID },
        },
      },
    });
  await page.waitForURL(`**/screens/${SCREEN_ID}`);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("stacked panes, home escape hatch, and modifier bar", async ({ page }) => {
    await mockAuthenticatedApi(page, {
      agents: [agentA, agentB],
      screens: [screen()],
    });

    await page.goto(`/screens/${SCREEN_ID}`);
    await expect(page.getByRole("region", { name: "alpha" })).toBeVisible();
    await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
    // Narrow containers stack panes: no split divider to drag.
    await expect(page.getByRole("button", { name: "Resize panes" })).toHaveCount(0);
    // Shared modifier bar serves the focused pane on touch devices.
    await expect(page.getByRole("button", { name: "Esc" })).toBeVisible();
    // The shell chrome is hidden here, so the header carries an escape hatch.
    await page.getByRole("link", { name: "Home" }).click();
    await page.waitForURL((url) => url.pathname === "/");
  });
});
