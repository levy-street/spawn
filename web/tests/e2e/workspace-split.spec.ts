import { expect, type Page, test } from "@playwright/test";
import { HOST_ID, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

/**
 * Split view: two to four workspaces side by side in one window.
 *
 * The arrangement is a *group* of workspace ids held in localStorage, and the
 * URL names whichever of them you are working in — so the interesting cases
 * are all about those two facts coming apart, which is where the feature used
 * to lose a workspace.
 */

const SECOND_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000b1";
const THIRD_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000c1";
const FOURTH_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000d1";
const FIFTH_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000e1";

async function setup(
  page: Page,
  options: { pair?: [string, string]; group?: string[]; collapsed?: boolean } = {},
) {
  await mockApp(page, {
    workspaces: [
      workspace({ id: WORKSPACE_ID, name: "alpha", position: 0, host_id: HOST_ID }),
      workspace({ id: SECOND_WORKSPACE_ID, name: "beta", position: 1, host_id: HOST_ID }),
      workspace({ id: THIRD_WORKSPACE_ID, name: "gamma", position: 2, host_id: HOST_ID }),
      workspace({ id: FOURTH_WORKSPACE_ID, name: "delta", position: 3, host_id: HOST_ID }),
      workspace({ id: FIFTH_WORKSPACE_ID, name: "epsilon", position: 4, host_id: HOST_ID }),
    ],
  });
  await page.addInitScript(
    ({ pair, group, collapsed }) => {
      // Only on the first load: a reload must find what the page wrote, not
      // this seed all over again.
      if (window.sessionStorage.getItem("split-seeded")) return;
      window.sessionStorage.setItem("split-seeded", "1");
      if (collapsed) window.localStorage.setItem("spawn.sidebar.collapsed", "true");
      if (pair) {
        // The shape every existing user has stored: two named halves and a ratio.
        window.localStorage.setItem(
          "spawn.workspaces.split",
          JSON.stringify({ primaryId: pair[0], secondaryId: pair[1], ratio: 0.5 }),
        );
      }
      if (group) {
        window.localStorage.setItem("spawn.workspaces.split", JSON.stringify({ members: group }));
      }
    },
    { pair: options.pair ?? null, group: options.group ?? null, collapsed: options.collapsed },
  );
}

/** The order the columns are actually drawn in, left to right. */
async function columns(page: Page): Promise<string[]> {
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

/** A point `fraction` of the way across the canvas, halfway down it. */
async function acrossCanvas(page: Page, fraction: number) {
  const boxes = await page
    .locator("[data-workspace-pane]")
    .evaluateAll((panes) =>
      panes
        .map((pane) => pane.getBoundingClientRect())
        .map((r) => [r.left, r.right, r.top, r.bottom]),
    );
  const left = Math.min(...boxes.map((box) => box[0] ?? 0));
  const right = Math.max(...boxes.map((box) => box[1] ?? 0));
  const top = Math.min(...boxes.map((box) => box[2] ?? 0));
  const bottom = Math.max(...boxes.map((box) => box[3] ?? 0));
  return { x: left + (right - left) * fraction, y: (top + bottom) / 2 };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("an existing user's stored pair comes up as the same split", async ({ page }) => {
  await setup(page, { pair: [SECOND_WORKSPACE_ID, WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();
  // Same order — the right-hand one stays on the right — and an even seam.
  expect(await columns(page)).toEqual([SECOND_WORKSPACE_ID, WORKSPACE_ID]);
  const widths = await page
    .locator("[data-workspace-pane]")
    .evaluateAll((panes) => panes.map((pane) => Math.round(pane.getBoundingClientRect().width)));
  expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThanOrEqual(1);
  // The rail draws it as the pair it was, with the pair's own control.
  await expect(page.getByRole("button", { name: "Unsplit, keep beta" })).toBeVisible();
  // And it is still that split after a reload.
  await page.reload();
  await expect(page.getByRole("tablist", { name: "beta tabs" })).toBeVisible();
  expect(await columns(page)).toEqual([SECOND_WORKSPACE_ID, WORKSPACE_ID]);
});

test("a workspace outside the split opens alone and leaves the split standing", async ({
  page,
}) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "beta tabs" })).toBeVisible();

  // Somewhere else entirely: one window, and the split waiting in the rail.
  await page.getByRole("link", { name: "gamma" }).click();
  await expect(page).toHaveURL(new RegExp(THIRD_WORKSPACE_ID));
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible();
  expect(await columns(page)).toEqual([THIRD_WORKSPACE_ID]);
  const parked = page.locator("[data-split-member]", { hasText: "beta" });
  await expect(parked).toBeVisible();

  // And opening any member puts it back — from the right-hand one, which
  // used to be the arrangement's definition of "that is the whole window now".
  await parked.click();
  await expect(page).toHaveURL(new RegExp(SECOND_WORKSPACE_ID));
  expect(await columns(page)).toEqual([WORKSPACE_ID, SECOND_WORKSPACE_ID]);
});

test("the strip's own name carries its workspace to another column", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "alpha tabs" })).toBeVisible();

  await carry(
    page,
    await centre(page, '[aria-label="alpha workspace"]'),
    await centre(page, '[data-split-column="1"]'),
  );

  // The two traded places, and the address bar did not have to move: it is
  // still about a workspace the window is showing.
  expect(await columns(page)).toEqual([SECOND_WORKSPACE_ID, WORKSPACE_ID]);
  await expect(page).toHaveURL(new RegExp(WORKSPACE_ID));
});

test("remove from split keeps the other half and follows it", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "alpha workspace" }).click();
  await page.getByRole("menuitem", { name: "Remove from split" }).click();

  await expect(page).toHaveURL(new RegExp(SECOND_WORKSPACE_ID));
  expect(await columns(page)).toEqual([SECOND_WORKSPACE_ID]);
  await expect(page.locator("[data-split-member]")).toHaveCount(0);
});

test("dragging from the rail adds a third and a fourth column", async ({ page }) => {
  await setup(page, { pair: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "beta tabs" })).toBeVisible();

  // The right-hand edge of the right-hand column: after it.
  await carry(
    page,
    await centre(page, `[data-workspace-row="${THIRD_WORKSPACE_ID}"]`),
    await acrossCanvas(page, 0.95),
  );
  await expect(page.getByRole("tablist", { name: "gamma tabs" })).toBeVisible();
  await expect
    .poll(() => columns(page))
    .toEqual([WORKSPACE_ID, SECOND_WORKSPACE_ID, THIRD_WORKSPACE_ID]);

  // The seam between the first two columns: between them.
  await carry(
    page,
    await centre(page, `[data-workspace-row="${FOURTH_WORKSPACE_ID}"]`),
    await acrossCanvas(page, 1 / 3),
  );
  await expect
    .poll(() => columns(page))
    .toEqual([WORKSPACE_ID, FOURTH_WORKSPACE_ID, SECOND_WORKSPACE_ID, THIRD_WORKSPACE_ID]);
  // Four columns, evenly shared once the newcomer has swept open, and one
  // grouped row in the rail.
  await expect
    .poll(async () => {
      const widths = await page
        .locator("[data-workspace-pane]")
        .evaluateAll((panes) =>
          panes.map((pane) => Math.round(pane.getBoundingClientRect().width)),
        );
      return Math.max(...widths) - Math.min(...widths);
    })
    .toBeLessThanOrEqual(2);
  await expect(page.getByRole("group", { name: "Split: alpha, delta, beta, gamma" })).toBeVisible();
  await expect(page.locator("[data-split-member]")).toHaveCount(4);

  // A full window has nowhere to put a fifth: a drop replaces the column.
  await carry(
    page,
    await centre(page, `[data-workspace-row="${FIFTH_WORKSPACE_ID}"]`),
    await centre(page, '[data-split-column="3"]'),
  );
  await expect
    .poll(() => columns(page))
    .toEqual([WORKSPACE_ID, FOURTH_WORKSPACE_ID, SECOND_WORKSPACE_ID, FIFTH_WORKSPACE_ID]);
});

test("one member steps out of a group and the rest stay split", async ({ page }) => {
  await setup(page, { group: [WORKSPACE_ID, SECOND_WORKSPACE_ID, THIRD_WORKSPACE_ID] });
  await page.goto(`/w/${SECOND_WORKSPACE_ID}`);
  await expect(page.getByRole("tablist", { name: "gamma tabs" })).toBeVisible();

  // The join before gamma releases gamma alone.
  await page.getByRole("button", { name: "Remove gamma from split" }).click();
  await expect.poll(() => columns(page)).toEqual([WORKSPACE_ID, SECOND_WORKSPACE_ID]);

  // And the routed column stepping out hands the address bar to the column
  // that took its place.
  await page.getByRole("button", { name: "beta workspace" }).click();
  await page.getByRole("menuitem", { name: "Remove from split" }).click();
  await expect(page).toHaveURL(new RegExp(WORKSPACE_ID));
  await expect.poll(() => columns(page)).toEqual([WORKSPACE_ID]);
});

test("the collapsed rail stacks a split and carries a tile out to split", async ({ page }) => {
  await setup(page, { collapsed: true, group: [WORKSPACE_ID, SECOND_WORKSPACE_ID] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const group = page.getByRole("group", { name: "Split: alpha, beta" });
  await expect(group).toBeVisible();
  // One beneath the other, joined.
  const [top, bottom] = await group
    .locator("[data-split-member]")
    .evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect().top));
  expect(bottom ?? 0).toBeGreaterThan(top ?? 0);
  await expect(group.getByRole("button", { name: "Unsplit, keep alpha" })).toBeVisible();

  await carry(
    page,
    await centre(page, `[data-workspace-row="${THIRD_WORKSPACE_ID}"]`),
    await acrossCanvas(page, 0.95),
  );
  await expect
    .poll(() => columns(page))
    .toEqual([WORKSPACE_ID, SECOND_WORKSPACE_ID, THIRD_WORKSPACE_ID]);
  await expect(page.getByRole("group", { name: "Split: alpha, beta, gamma" })).toBeVisible();
});

test("a narrow window still splits two, and its columns stay grids", async ({ page }) => {
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
  // Two ~310px columns, and neither has fallen back to the phone stack.
  await expect(page.locator("[data-pane-stack]")).toHaveCount(0);

  // Too narrow for a third at the minimum width: the drop replaces instead.
  await carry(
    page,
    await centre(page, `[data-workspace-row="${THIRD_WORKSPACE_ID}"]`),
    await centre(page, '[data-split-column="1"]'),
  );
  await expect.poll(() => columns(page)).toEqual([WORKSPACE_ID, THIRD_WORKSPACE_ID]);
});

test("a group too wide for a narrowed window folds to the columns that fit", async ({ page }) => {
  await setup(page, {
    group: [WORKSPACE_ID, SECOND_WORKSPACE_ID, THIRD_WORKSPACE_ID, FOURTH_WORKSPACE_ID],
  });
  await page.goto(`/w/${FOURTH_WORKSPACE_ID}`);
  await expect.poll(() => columns(page)).toHaveLength(4);

  await page.setViewportSize({ width: 900, height: 800 });
  // Two fit, and the one the URL is about is one of them.
  await expect.poll(() => columns(page)).toEqual([THIRD_WORKSPACE_ID, FOURTH_WORKSPACE_ID]);
  // All four are still the split.
  await expect(page.locator("[data-split-member]")).toHaveCount(4);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => columns(page)).toHaveLength(4);
});
