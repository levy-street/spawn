import { expect, type Locator, type Page, test } from "@playwright/test";
import type { LayoutV3 } from "../../src/lib/tabs";
import { mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

const THREE_TABS: LayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  tabs: [
    { id: "tab-1", name: "Alpha", layout: { version: 2, tiles: [] } },
    { id: "tab-2", name: "Beta", layout: { version: 2, tiles: [] } },
    { id: "tab-3", name: "Gamma", layout: { version: 2, tiles: [] } },
  ],
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
