import { expect, type Page, test } from "@playwright/test";
import { HOST_ID, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

/**
 * Split view: two workspaces side by side in one window.
 *
 * The arrangement is a *pair* of workspace ids held in localStorage, and the
 * URL names whichever of them you are working in — so the interesting cases
 * are all about those two facts coming apart, which is where the feature used
 * to lose a workspace.
 */

const SECOND_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000b1";
const THIRD_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000c1";

async function setup(page: Page, options: { pair?: [string, string] } = {}) {
  await mockApp(page, {
    workspaces: [
      workspace({ id: WORKSPACE_ID, name: "alpha", position: 0, host_id: HOST_ID }),
      workspace({ id: SECOND_WORKSPACE_ID, name: "beta", position: 1, host_id: HOST_ID }),
      workspace({ id: THIRD_WORKSPACE_ID, name: "gamma", position: 2, host_id: HOST_ID }),
    ],
  });
  if (!options.pair) return;
  await page.addInitScript(([primaryId, secondaryId]) => {
    window.localStorage.setItem(
      "spawn.workspaces.split",
      JSON.stringify({ primaryId, secondaryId, ratio: 0.5 }),
    );
  }, options.pair);
}

/** The order the halves are actually drawn in, left to right. */
async function halves(page: Page): Promise<string[]> {
  return page
    .locator("[data-workspace-pane]")
    .evaluateAll((panes) => panes.map((pane) => pane.getAttribute("data-workspace-pane") ?? ""));
}

/**
 * A pointer drag the workspace carry recognises: press, travel past its
 * threshold in steps so every move is seen, release.
 */
async function carry(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
      { steps: 2 },
    );
  }
  await page.mouse.up();
}

/** The middle of an element, in viewport coordinates. */
async function centre(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox()) ?? null;
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("a third workspace opens alone and leaves the pair standing", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "beta tabs" })).toBeVisible();

  // Somewhere else entirely: one window, and the split waiting in the rail.
  await page.getByRole("link", { name: "gamma" }).click();
  await expect(page).toHaveURL(new RegExp(THIRD_WORKSPACE_ID));
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible();
  expect(await halves(page)).toEqual([THIRD_WORKSPACE_ID]);
  const parked = page.locator("[data-pair-half]", { hasText: "beta" });
  await expect(parked).toBeVisible();

  // And opening either member puts it back — from the right-hand one, which
  // used to be the arrangement's definition of "that is the whole window now".
  await parked.click();
  await expect(page).toHaveURL(new RegExp(SECOND_WORKSPACE_ID));
  expect(await halves(page)).toEqual([WORKSPACE_ID, SECOND_WORKSPACE_ID]);
});

test("the strip's own name carries its workspace to the other half", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();

  await carry(
    page,
    await centre(page, '[aria-label="alpha workspace"]'),
    await centre(page, '[data-split-side="secondary"]'),
  );

  // The two traded places, and the address bar did not have to move: it is
  // still about a workspace the window is showing.
  expect(await halves(page)).toEqual([SECOND_WORKSPACE_ID, WORKSPACE_ID]);
  await expect(page).toHaveURL(new RegExp(WORKSPACE_ID));
});

test("remove from split keeps the other half and follows it", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "alpha workspace" }).click();
  await page.getByRole("menuitem", { name: "Remove from split" }).click();

  await expect(page).toHaveURL(new RegExp(SECOND_WORKSPACE_ID));
  expect(await halves(page)).toEqual([SECOND_WORKSPACE_ID]);
  await expect(page.locator("[data-pair-half]")).toHaveCount(0);
});

test("a narrow window still splits, and its halves stay grids", async ({ page }) => {
  // Well under the width the split used to demand before it would draw one.
  await page.setViewportSize({ width: 900, height: 800 });
  await setup(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible();

  const pane = (await page.locator("[data-workspace-pane]").first().boundingBox()) ?? null;
  if (!pane) throw new Error("no pane");
  await carry(page, await centre(page, `[data-workspace-row="${SECOND_WORKSPACE_ID}"]`), {
    x: pane.x + pane.width * 0.8,
    y: pane.y + pane.height / 2,
  });

  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "beta tabs" })).toBeVisible();
  // Two ~310px halves, and neither has fallen back to the phone stack.
  await expect(page.locator("[data-pane-stack]")).toHaveCount(0);
});
