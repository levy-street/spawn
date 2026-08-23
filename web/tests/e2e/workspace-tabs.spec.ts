import { expect, type Locator, type Page, test } from "@playwright/test";
import type { LayoutV3 } from "../../src/lib/tabs";
import { HOST_ID, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

const THREE_TABS: LayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  tabs: [
    { id: "tab-1", name: "Alpha", layout: { version: 3, tiles: [] } },
    { id: "tab-2", name: "Beta", layout: { version: 3, tiles: [] } },
    { id: "tab-3", name: "Gamma", layout: { version: 3, tiles: [] } },
  ],
};

/** Two tabs, the second holding a window — what a merge has to carry over. */
const TABS_WITH_A_WINDOW: LayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  tabs: [
    { id: "tab-1", name: "Alpha", layout: { version: 3, tiles: [] } },
    {
      id: "tab-2",
      name: "Beta",
      layout: {
        version: 3,
        tiles: [
          {
            session_id: "00000000-0000-4000-8000-0000000000f1",
            x: 0,
            y: 0,
            w: 24,
            h: 24,
            widget: { kind: "files", host_id: HOST_ID, path: "/Users/tester" },
          },
        ],
      },
    },
  ],
};

const FILES = { kind: "files" as const, host_id: HOST_ID, path: "/Users/tester" };

function widgetTile(id: string, x: number, y: number, w: number, h: number) {
  return { session_id: id, x, y, w, h, widget: FILES };
}

/** An occupied tab beside one holding two windows side by side. */
const AIMED_TABS: LayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  tabs: [
    {
      id: "tab-1",
      name: "Alpha",
      layout: {
        version: 3,
        tiles: [widgetTile("00000000-0000-4000-8000-0000000000a1", 0, 0, 24, 24)],
      },
    },
    {
      id: "tab-2",
      name: "Beta",
      layout: {
        version: 3,
        tiles: [
          widgetTile("00000000-0000-4000-8000-0000000000b1", 0, 0, 12, 24),
          widgetTile("00000000-0000-4000-8000-0000000000b2", 12, 0, 12, 24),
        ],
      },
    },
  ],
};

const ONE_TAB: LayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  tabs: [{ id: "tab-1", name: "Solo", layout: { version: 3, tiles: [] } }],
};

async function setupTabs(page: Page) {
  const store = await mockApp(page, {
    sessions: [],
    workspaces: [workspace({ layout: THREE_TABS })],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible();
  return store;
}

/** The order the strip is painting in, left to right. */
async function paintedOrder(strip: Locator) {
  const boxes = await Promise.all(
    (await strip.getByRole("tab").all()).map(async (tab) => ({
      name: (await tab.textContent())?.trim() ?? "",
      x: (await tab.boundingBox())?.x ?? 0,
    })),
  );
  return boxes.sort((a, b) => a.x - b.x).map((box) => box.name);
}

function patchedOrder(body: unknown) {
  return ((body as { layout: LayoutV3 }).layout.tabs ?? []).map((tab) => tab.name);
}

/**
 * The layout writes among the workspace PATCHes. A workspace with a home of
 * its own also gets an icon PATCH the first time it is opened, which says
 * nothing about tabs.
 */
function layoutPatches(patches: Array<{ body: unknown }>) {
  return patches
    .map((patch) => (patch.body as { layout?: LayoutV3 }).layout)
    .filter((layout): layout is LayoutV3 => layout !== undefined);
}

/** Press the tab itself and carry it to `toX` — the whole tab is the grab. */
async function dragTab(page: Page, tab: Locator, toX: number) {
  const box = await tab.boundingBox();
  if (!box) throw new Error("tab geometry unavailable");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 8 });
  await page.mouse.up();
}

test("dragging a tab past its neighbour reorders the strip and persists it", async ({ page }) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  expect(await paintedOrder(strip)).toEqual(["Alpha", "Beta", "Gamma"]);

  const beta = await strip.getByRole("tab", { name: "Beta" }).boundingBox();
  if (!beta) throw new Error("tab geometry unavailable");
  // Just past Beta's middle: half a tab of travel is what a swap costs.
  await dragTab(page, strip.getByRole("tab", { name: "Alpha" }), beta.x + beta.width * 0.6);

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Beta",
    "Alpha",
    "Gamma",
  ]);
  await expect.poll(() => paintedOrder(strip)).toEqual(["Beta", "Alpha", "Gamma"]);
  // The drop is not a click: the selected tab keeps its label, not a rename box.
  await expect(strip.getByRole("textbox")).toHaveCount(0);
  await expect(strip.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
});

test("a middle tab reaches the first and last slots", async ({ page }) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });

  // Onto the first slot: covering half of Alpha claims it, and the clamp at
  // the strip's left edge leaves room to get there.
  const alpha = await strip.getByRole("tab", { name: "Alpha" }).boundingBox();
  if (!alpha) throw new Error("tab geometry unavailable");
  await dragTab(page, strip.getByRole("tab", { name: "Beta" }), alpha.x + alpha.width * 0.4);
  await expect.poll(() => paintedOrder(strip)).toEqual(["Beta", "Alpha", "Gamma"]);

  // And onto the last, from the middle again.
  const gamma = await strip.getByRole("tab", { name: "Gamma" }).boundingBox();
  if (!gamma) throw new Error("tab geometry unavailable");
  await dragTab(page, strip.getByRole("tab", { name: "Alpha" }), gamma.x + gamma.width * 0.6);
  await expect.poll(() => paintedOrder(strip)).toEqual(["Beta", "Gamma", "Alpha"]);
  expect(patchedOrder(store.requests.workspacePatches[1]?.body)).toEqual([
    "Beta",
    "Gamma",
    "Alpha",
  ]);
});

test("a short press is still a click, and travel short of a neighbour saves nothing", async ({
  page,
}) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });

  // A nudge that never reaches Beta's middle puts the tab back, unsaved.
  const alpha = await strip.getByRole("tab", { name: "Alpha" }).boundingBox();
  if (!alpha) throw new Error("tab geometry unavailable");
  await dragTab(page, strip.getByRole("tab", { name: "Alpha" }), alpha.x + alpha.width * 0.9);
  expect(await paintedOrder(strip)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(store.requests.workspacePatches).toHaveLength(0);

  // And a plain click still switches tabs.
  await strip.getByRole("tab", { name: "Gamma" }).click();
  await expect(strip.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
  expect(store.requests.workspacePatches).toHaveLength(0);
});

test("Alt+Shift+Arrow moves the focused tab without a pointer", async ({ page }) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });

  await strip.getByRole("tab", { name: "Gamma" }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Alpha",
    "Gamma",
    "Beta",
  ]);
  await expect.poll(() => paintedOrder(strip)).toEqual(["Alpha", "Gamma", "Beta"]);

  // The far end is the last slot, not an error.
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect.poll(() => paintedOrder(strip)).toEqual(["Alpha", "Beta", "Gamma"]);
});

test("⌘ dragging a tab carries the copy under the hand, gap by gap", async ({ page }) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist");
  const alpha = page.getByRole("tab", { name: "Alpha" });
  const box = await alpha.boundingBox();
  const beta = await page.getByRole("tab", { name: "Beta" }).boundingBox();
  const gamma = await page.getByRole("tab", { name: "Gamma" }).boundingBox();
  if (!box || !beta || !gamma) throw new Error("tab geometry unavailable");
  const step = beta.x - box.x;
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // Carried one tab's travel to the right, the copy's leading edge sits on
  // Beta's resting edge — so that is the gap it claims.
  await page.mouse.move(box.x + box.width / 2 + step, y, { steps: 8 });
  await page.keyboard.down("Meta");

  // The ghost says where the copy lands, and says it in place: it has left the
  // end of the strip for the gap Beta opened by sliding aside.
  const ghost = page.locator("[data-workspace-tab-ghost]");
  await expect(ghost).toContainText("Alpha copy");
  await expect
    .poll(async () => Math.round((await ghost.boundingBox())?.x ?? 0))
    .toBe(Math.round(beta.x));
  // The strip's own order never changes, and Alpha has gone back to its own
  // slot rather than riding the pointer.
  expect(await paintedOrder(strip)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect((await alpha.boundingBox())?.x).toBeCloseTo(box.x, 0);

  // Another tab's travel, another gap — the copy keeps pace with the pointer
  // however far along the strip it has come.
  await page.mouse.move(box.x + box.width / 2 + step * 2, y, { steps: 8 });
  await expect
    .poll(async () => Math.round((await ghost.boundingBox())?.x ?? 0))
    .toBe(Math.round(gamma.x));

  await page.mouse.up();
  await page.keyboard.up("Meta");

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Alpha",
    "Beta",
    "Alpha copy",
    "Gamma",
  ]);
});

test("the copy reaches either end of the strip", async ({ page }) => {
  const store = await setupTabs(page);
  const gamma = page.getByRole("tab", { name: "Gamma" });
  const box = await gamma.boundingBox();
  const alpha = await page.getByRole("tab", { name: "Alpha" }).boundingBox();
  const beta = await page.getByRole("tab", { name: "Beta" }).boundingBox();
  if (!box || !alpha || !beta) throw new Error("tab geometry unavailable");
  const gap = beta.x - (alpha.x + alpha.width);
  const y = box.y + box.height / 2;
  const ghost = page.locator("[data-workspace-tab-ghost]");

  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 8, y);
  await page.keyboard.down("Meta");

  // Carried to the head of the strip: the copy parts it before Alpha.
  await page.mouse.move(alpha.x + 4, y, { steps: 8 });
  await expect
    .poll(async () => Math.round((await ghost.boundingBox())?.x ?? 0))
    .toBe(Math.round(alpha.x));

  // Carried back past the last tab, it rests where it started — the end of
  // the strip is a gap like any other, and the one the drop uses.
  await page.mouse.move(box.x + box.width * 1.5, y, { steps: 8 });
  await expect
    .poll(async () => Math.round((await ghost.boundingBox())?.x ?? 0))
    .toBe(Math.round(box.x + box.width + gap));

  await page.mouse.up();
  await page.keyboard.up("Meta");

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Alpha",
    "Beta",
    "Gamma",
    "Gamma copy",
  ]);
});

test("a lone tab copies too, the modifier pressed after the drag is under way", async ({
  page,
}) => {
  const store = await mockApp(page, {
    sessions: [],
    workspaces: [workspace({ layout: ONE_TAB })],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const solo = page.getByRole("tab", { name: "Solo" });
  await expect(solo).toBeVisible();
  const box = await solo.boundingBox();
  if (!box) throw new Error("tab geometry unavailable");
  const y = box.y + box.height / 2;

  // Nothing to reorder against, so the gesture has to arm on the press alone
  // and wait to find out what it is.
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 1.5, y, { steps: 8 });
  await page.keyboard.down("Meta");
  await expect(page.locator("[data-workspace-tab-ghost]")).toContainText("Solo copy");

  await page.mouse.up();
  await page.keyboard.up("Meta");

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual(["Solo", "Solo copy"]);
});

test("a plain tab drag still reorders — the modifier is what copies", async ({ page }) => {
  const store = await setupTabs(page);
  const gamma = page.getByRole("tab", { name: "Gamma" });
  const alphaBox = await page.getByRole("tab", { name: "Alpha" }).boundingBox();
  if (!alphaBox) throw new Error("tab geometry unavailable");

  await dragTab(page, gamma, alphaBox.x + 4);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Gamma",
    "Alpha",
    "Beta",
  ]);
  expect(store.requests.sessions).toEqual([]);
});

test("the + asks what goes in the tab, and makes the tab and the window together", async ({
  page,
}) => {
  const store = await mockApp(page, {
    sessions: [],
    // A workspace with a home: one click answers "what", and "where" is
    // already known, which is the whole point of the picker being one step.
    workspaces: [workspace({ layout: THREE_TABS, host_id: HOST_ID, cwd: "/Users/tester" })],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  await expect(strip.getByRole("tab", { name: "Alpha" })).toBeVisible();

  // Opening the picker makes nothing: there is no empty tab to abandon.
  await page.getByRole("button", { name: "New tab" }).click();
  // The trigger already says New tab, so the menu is the choices alone — and
  // only the choices: a new tab opens at the workspace's folder, so the
  // "somewhere else" row has nothing to add.
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /A plain login shell/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /another folder|another host/ })).toHaveCount(0);
  expect(layoutPatches(store.requests.workspacePatches)).toHaveLength(0);
  expect(store.requests.sessions).toHaveLength(0);

  // Choosing what goes in it writes the tab, then opens the window there.
  await menu.getByRole("menuitem", { name: /A plain login shell/ }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  const added = layoutPatches(store.requests.workspacePatches)[0] as LayoutV3;
  expect(added.tabs.map((tab) => tab.name)).toEqual(["Alpha", "Beta", "Gamma", "Tab 4"]);
  expect(added.active_tab).toBe(added.tabs[3]?.id);
  await expect(strip.getByRole("tab", { name: "Tab 4" })).toHaveAttribute("aria-selected", "true");
});

test("dragging a tab down onto the canvas folds its windows into the open one", async ({
  page,
}) => {
  const store = await mockApp(page, {
    sessions: [],
    workspaces: [workspace({ layout: TABS_WITH_A_WINDOW })],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  const beta = strip.getByRole("tab", { name: "Beta" });
  await expect(beta).toBeVisible();

  const box = await beta.boundingBox();
  const canvas = await page.locator("[data-workspace-canvas]").boundingBox();
  if (!box || !canvas) throw new Error("geometry unavailable");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height * 0.8, { steps: 10 });
  // The canvas says what the drop will do before the hand lets go.
  await expect(page.getByText("Merge Beta into Alpha")).toBeVisible();
  await page.mouse.up();

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  const merged = (store.requests.workspacePatches[0]?.body as { layout: LayoutV3 }).layout;
  expect(merged.tabs.map((tab) => tab.name)).toEqual(["Alpha"]);
  expect(merged.active_tab).toBe("tab-1");
  expect(merged.tabs[0]?.layout.tiles.map((tile) => tile.session_id)).toEqual([
    "00000000-0000-4000-8000-0000000000f1",
  ]);
  await expect(strip.getByRole("tab", { name: "Beta" })).toHaveCount(0);
});

test("a sideways tab drag never becomes a merge", async ({ page }) => {
  const store = await setupTabs(page);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  const box = await strip.getByRole("tab", { name: "Alpha" }).boundingBox();
  const beta = await strip.getByRole("tab", { name: "Beta" }).boundingBox();
  if (!box || !beta) throw new Error("tab geometry unavailable");

  // A little downward drift on the way past Beta is still a reorder: the
  // merge only takes over well clear of the strip.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(beta.x + beta.width * 0.6, box.y + box.height, { steps: 8 });
  await expect(page.getByText(/^Merge /)).toHaveCount(0);
  await page.mouse.up();

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(patchedOrder(store.requests.workspacePatches[0]?.body)).toEqual([
    "Beta",
    "Alpha",
    "Gamma",
  ]);
});

test("a tab aimed at half a window lands there, keeping its own arrangement", async ({ page }) => {
  const store = await mockApp(page, {
    sessions: [],
    workspaces: [workspace({ layout: AIMED_TABS })],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  const beta = strip.getByRole("tab", { name: "Beta" });
  await expect(beta).toBeVisible();

  const box = await beta.boundingBox();
  const canvas = await page.locator("[data-workspace-canvas]").boundingBox();
  if (!box || !canvas) throw new Error("geometry unavailable");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Hard against the right edge of the one window on the canvas: it gives up
  // its right half, and Beta's two windows share that half between them.
  await page.mouse.move(canvas.x + canvas.width * 0.95, canvas.y + canvas.height / 2, {
    steps: 10,
  });
  const outlines = page.locator("[data-merge-window]");
  await expect(outlines).toHaveCount(2);
  const first = await outlines.first().boundingBox();
  if (!first) throw new Error("outline geometry unavailable");
  // Two windows in the right half means a quarter of the canvas each, and the
  // first of them starts at the halfway line.
  expect(first.x).toBeCloseTo(canvas.x + canvas.width / 2, -1);
  expect(first.width).toBeCloseTo(canvas.width / 4, -1);

  await page.mouse.up();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  const merged = (store.requests.workspacePatches[0]?.body as { layout: LayoutV3 }).layout;
  expect(merged.tabs).toHaveLength(1);
  expect(merged.tabs[0]?.layout.tiles).toEqual([
    widgetTile("00000000-0000-4000-8000-0000000000a1", 0, 0, 12, 24),
    widgetTile("00000000-0000-4000-8000-0000000000b1", 12, 0, 6, 24),
    widgetTile("00000000-0000-4000-8000-0000000000b2", 18, 0, 6, 24),
  ]);
});
