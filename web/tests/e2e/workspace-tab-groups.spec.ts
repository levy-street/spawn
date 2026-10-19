import { expect, type Locator, type Page, test } from "@playwright/test";
import { hexToHsv, hsvToHex } from "../../src/lib/color";
import type { LayoutV3, TabGroup } from "../../src/lib/tabs";
import {
  type AppMockStore,
  mockApp,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const empty = { version: 3 as const, tiles: [] };

/** Alpha, then Beta and Gamma in "Agents", then Delta — or without a group. */
function strip(
  groups: TabGroup[] = [],
  options: { active?: string; betaTiles?: LayoutV3["tabs"][number]["layout"]["tiles"] } = {},
): LayoutV3 {
  return {
    version: 3,
    active_tab: options.active ?? "tab-1",
    tabs: [
      { id: "tab-1", name: "Alpha", layout: empty },
      { id: "tab-2", name: "Beta", layout: { version: 3, tiles: options.betaTiles ?? [] } },
      { id: "tab-3", name: "Gamma", layout: empty },
      { id: "tab-4", name: "Delta", layout: empty },
    ],
    groups,
  };
}

function agents(extra: Partial<TabGroup> = {}): TabGroup {
  return {
    id: "group-1",
    name: "Agents",
    color: "blue",
    collapsed: false,
    tab_ids: ["tab-2", "tab-3"],
    ...extra,
  };
}

async function setup(page: Page, layout: LayoutV3, sessions: unknown[] = []) {
  const store = await mockApp(page, { sessions, workspaces: [workspace({ layout })] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible();
  return store;
}

function tabStrip(page: Page) {
  return page.getByRole("tablist", { name: "Workspace tabs" });
}

function label(page: Page, name: string) {
  return tabStrip(page).getByRole("button", { name, exact: true });
}

/** The layout the last workspace PATCH carried. */
function lastLayout(store: AppMockStore): LayoutV3 | undefined {
  return [...store.requests.workspacePatches]
    .reverse()
    .map((patch) => (patch.body as { layout?: LayoutV3 }).layout)
    .find((layout): layout is LayoutV3 => layout !== undefined);
}

const lastGroups = (store: AppMockStore) => lastLayout(store)?.groups;
const lastOrder = (store: AppMockStore) => lastLayout(store)?.tabs.map((tab) => tab.name);

/** Left to right, what the strip is painting: tabs by name, labels as [name]. */
async function painted(page: Page) {
  const items = await tabStrip(page)
    .locator("[data-workspace-tab], [data-workspace-tab-group]")
    .all();
  const boxes = await Promise.all(
    items.map(async (item) => {
      const group = await item.getAttribute("data-workspace-tab-group");
      const name = group
        ? `[${await item.getAttribute("aria-label")}]`
        : ((await item.textContent())?.trim() ?? "");
      return { name, x: (await item.boundingBox())?.x ?? 0 };
    }),
  );
  return boxes.sort((a, b) => a.x - b.x).map((box) => box.name);
}

async function rightClick(locator: Locator) {
  await locator.click({ button: "right" });
}

/** Press the tab and carry it so its left edge lands at `left`. */
async function dragTabTo(page: Page, tab: Locator, left: number) {
  const box = await tab.boundingBox();
  if (!box) throw new Error("tab geometry unavailable");
  const y = box.y + box.height / 2;
  const grab = box.x + box.width / 2;
  await page.mouse.move(grab, y);
  await page.mouse.down();
  await page.mouse.move(grab + (left - box.x), y, { steps: 10 });
  await page.mouse.up();
}

test("a tab put in a new group is named and coloured from the panel", async ({ page }) => {
  const store = await setup(page, strip());
  await rightClick(page.getByRole("tab", { name: "Beta" }));
  await page.getByRole("menuitem", { name: "Add tab to new group" }).click();

  const panel = page.getByRole("group", { name: "Create tab group" });
  await expect(panel).toBeVisible();
  const name = panel.getByRole("textbox", { name: "Group name" });
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("placeholder", "Name");
  // A new group takes the first preset nobody wears, and says so.
  await expect(panel.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await expect(label(page, "Unnamed group")).toBeVisible();
  // It hangs from the new label, not wherever there happened to be room.
  const labelBox = await label(page, "Unnamed group").boundingBox();
  const panelBox = await panel.boundingBox();
  expect(Math.abs((panelBox?.x ?? 0) - (labelBox?.x ?? -100))).toBeLessThan(2);
  expect(panelBox?.y ?? 0).toBeGreaterThan(labelBox?.y ?? 0);

  await name.fill("Agents");
  // Applied as typed: the label renames before anything is confirmed.
  await expect(label(page, "Agents")).toBeVisible();
  await panel.getByRole("radio", { name: "Orange" }).click();
  await expect(panel.getByRole("radio", { name: "Orange" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await name.press("Enter");
  await expect(panel).toBeHidden();
  await expect(label(page, "Agents")).toBeFocused();

  await expect
    .poll(() => lastGroups(store))
    .toEqual([
      {
        id: expect.any(String),
        name: "Agents",
        color: "orange",
        collapsed: false,
        tab_ids: ["tab-2"],
      },
    ]);
  expect(lastOrder(store)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  await expect(label(page, "Agents")).toHaveAttribute("aria-expanded", "true");
  await expect(label(page, "Agents")).toHaveAttribute("title", /Agents — 1 tab/);
  expect(await painted(page)).toEqual(["Alpha", "[Agents]", "Beta", "Gamma", "Delta"]);
  // The line rides over Beta alone.
  await expect(tabStrip(page).locator("[data-tab-group-line]")).toHaveCount(1);
});

test("Cancel and Escape take a group just made away again", async ({ page }) => {
  const store = await setup(page, strip());
  await rightClick(page.getByRole("tab", { name: "Gamma" }));
  await page.getByRole("menuitem", { name: "Add tab to new group" }).click();
  const panel = page.getByRole("group", { name: "Create tab group" });
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toBeHidden();
  await expect(tabStrip(page).locator("[data-workspace-tab-group]")).toHaveCount(0);
  await expect.poll(() => lastGroups(store)).toEqual([]);
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeFocused();

  await rightClick(page.getByRole("tab", { name: "Gamma" }));
  await page.getByRole("menuitem", { name: "Add tab to new group" }).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(tabStrip(page).locator("[data-workspace-tab-group]")).toHaveCount(0);
  await expect.poll(() => lastGroups(store)).toEqual([]);
});

test("a custom colour comes from a drag, the keyboard, or a hex", async ({ page }) => {
  const store = await setup(page, strip([agents()]));
  await rightClick(label(page, "Agents"));
  const panel = page.getByRole("group", { name: "Manage tab group" });
  await expect(panel).toBeVisible();
  await panel.getByRole("radio", { name: "Custom" }).click();
  await expect(panel.getByRole("radio", { name: "Custom" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // Custom starts from the blue the group was wearing, as a hex.
  await expect.poll(() => lastGroups(store)?.[0]?.color).toMatch(/^#[0-9a-f]{6}$/);

  // Dragged to the square's top-right corner: full saturation, full
  // brightness, and the hue it already had.
  const square = panel.getByRole("slider", { name: "Custom colour saturation and brightness" });
  const box = await square.boundingBox();
  if (!box) throw new Error("square geometry unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Carried past the corner: pointer capture keeps the drag, and the thumb
  // stops at the edge.
  await page.mouse.move(box.x + box.width + 30, box.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect(square).toHaveAttribute("aria-valuenow", "100");
  await expect(square).toHaveAttribute("aria-valuetext", "Saturation 100%, brightness 100%");
  const hue = panel.getByRole("slider", { name: "Custom colour hue" });
  await expect
    .poll(() => {
      const dragged = hexToHsv(lastGroups(store)?.[0]?.color ?? "");
      return dragged && [dragged.s, dragged.v, Math.abs(dragged.h - 220) < 3];
    })
    .toEqual([1, 1, true]);

  // The keyboard: End is the far end of the hue strip, Shift steps ten.
  await hue.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(hue).toHaveAttribute("aria-valuenow", "350");
  await square.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(square).toHaveAttribute("aria-valuetext", "Saturation 100%, brightness 89%");
  const keyed = hsvToHex({ h: 350, s: 1, v: 0.89 });
  await expect.poll(() => lastGroups(store)?.[0]?.color).toBe(keyed);
  // The panel's arrows are its own: the strip did not reorder, and the label
  // wears the colour.
  expect(lastOrder(store)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

  // And typed, in the short form.
  const hex = panel.getByRole("textbox", { name: "Custom colour hex" });
  await expect(hex).toHaveValue(keyed);
  await hex.fill("#0AF");
  await expect.poll(() => lastGroups(store)?.[0]?.color).toBe("#00aaff");
  await expect(label(page, "Agents")).toHaveCSS("background-color", "rgb(0, 170, 255)");
  await expect(hue).toHaveAttribute("aria-valuenow", "200");

  // Back to a preset closes the picker.
  await panel.getByRole("radio", { name: "Green" }).click();
  await expect(square).toBeHidden();
  await expect.poll(() => lastGroups(store)?.[0]?.color).toBe("green");
});

test("Add tab to group… moves the tab to the group's end", async ({ page }) => {
  const store = await setup(
    page,
    strip([
      agents(),
      { id: "group-2", name: "", color: "red", collapsed: false, tab_ids: ["tab-4"] },
    ]),
  );
  await rightClick(page.getByRole("tab", { name: "Alpha" }));
  await expect(page.getByRole("menuitem", { name: "Remove from group" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Add tab to group…" }).click();
  // The list opens where the menu was: a new group first, then every group.
  const list = page.getByRole("menu");
  await expect(list.getByRole("menuitem")).toHaveText(["New group", "Agents", "Unnamed group"]);
  await list.getByRole("menuitem", { name: "Agents" }).click();

  await expect.poll(() => lastOrder(store)).toEqual(["Beta", "Gamma", "Alpha", "Delta"]);
  expect(lastGroups(store)).toEqual([
    agents({ tab_ids: ["tab-2", "tab-3", "tab-1"] }),
    { id: "group-2", name: "", color: "red", collapsed: false, tab_ids: ["tab-4"] },
  ]);
  await expect
    .poll(() => painted(page))
    .toEqual(["[Agents]", "Beta", "Gamma", "Alpha", "[Unnamed group]", "Delta"]);

  // From inside a group the wording says it moves, and the list leaves out
  // the group it is already in.
  await rightClick(page.getByRole("tab", { name: "Gamma" }));
  await expect(page.getByRole("menuitem", { name: "Move tab to new group" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Move tab to group…" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "New group",
    "Unnamed group",
  ]);
  await page.keyboard.press("Escape");

  // Removing a tab from the middle steps it past the group's end.
  await rightClick(page.getByRole("tab", { name: "Gamma" }));
  await page.getByRole("menuitem", { name: "Remove from group" }).click();
  await expect.poll(() => lastOrder(store)).toEqual(["Beta", "Alpha", "Gamma", "Delta"]);
  expect(lastGroups(store)?.[0]?.tab_ids).toEqual(["tab-2", "tab-1"]);
});

test("a folded group hides its tabs behind a count and a dot", async ({ page }) => {
  const exited = session({ id: SESSION_ID, status: "exited", exit_code: 1 });
  const store = await setup(
    page,
    strip([agents({ tab_ids: ["tab-2", "tab-3", "tab-4"] })], {
      betaTiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }],
    }),
    [exited],
  );
  const agentsLabel = label(page, "Agents");
  await expect(agentsLabel).toHaveAttribute("title", "Agents — 3 tabs");
  await agentsLabel.click();

  await expect(agentsLabel).toHaveAttribute("aria-expanded", "false");
  for (const name of ["Beta", "Gamma", "Delta"]) {
    await expect(page.getByRole("tab", { name })).toHaveCount(0);
  }
  await expect(agentsLabel.locator("[data-group-hidden-count]")).toHaveText("+3");
  // Beta's window has stopped, and with Beta folded away the label says so.
  await expect(tabStrip(page).locator('[data-group-attention="dead"]')).toBeVisible();
  await expect(agentsLabel).toHaveAttribute("title", /hidden tab has a window that stopped/);
  await expect.poll(() => lastGroups(store)?.[0]?.collapsed).toBe(true);

  await agentsLabel.click();
  await expect(agentsLabel).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tab", { name: "Delta" })).toBeVisible();
  await expect(tabStrip(page).locator("[data-group-attention]")).toHaveCount(0);
  await expect.poll(() => lastGroups(store)?.[0]?.collapsed).toBe(false);
});

test("a folded group still shows the open tab", async ({ page }) => {
  await setup(page, strip([agents({ collapsed: true })], { active: "tab-3" }));
  await expect(page.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Beta" })).toHaveCount(0);
  await expect(label(page, "Agents").locator("[data-group-hidden-count]")).toHaveText("+1");
  expect(await painted(page)).toEqual(["Alpha", "[Agents]", "Gamma", "Delta"]);
});

test("a tab dragged into the middle of a group joins it, and out again leaves", async ({
  page,
}) => {
  const store = await setup(page, strip([agents()]));
  const gamma = await page.getByRole("tab", { name: "Gamma" }).boundingBox();
  if (!gamma) throw new Error("tab geometry unavailable");
  // Delta's leading edge a little past Gamma's start: Gamma's slot, so
  // between Beta and Gamma.
  await dragTabTo(page, page.getByRole("tab", { name: "Delta" }), gamma.x + gamma.width * 0.2);
  await expect.poll(() => lastOrder(store)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
  expect(lastGroups(store)).toEqual([agents({ tab_ids: ["tab-2", "tab-4", "tab-3"] })]);
  await expect.poll(() => painted(page)).toEqual(["Alpha", "[Agents]", "Beta", "Delta", "Gamma"]);

  // Carried out to the head of the strip, it is no longer touching the group.
  const alpha = await page.getByRole("tab", { name: "Alpha" }).boundingBox();
  if (!alpha) throw new Error("tab geometry unavailable");
  await dragTabTo(page, page.getByRole("tab", { name: "Delta" }), alpha.x);
  await expect.poll(() => lastOrder(store)).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
  expect(lastGroups(store)).toEqual([agents()]);
});

test("a drag passes a folded group whole", async ({ page }) => {
  const store = await setup(page, strip([agents({ collapsed: true })]));
  const delta = await page.getByRole("tab", { name: "Delta" }).boundingBox();
  if (!delta) throw new Error("tab geometry unavailable");
  // Alpha carried past Delta: the hidden Beta and Gamma stay together, and
  // Alpha lands after Delta rather than among tabs nobody can see.
  await dragTabTo(page, page.getByRole("tab", { name: "Alpha" }), delta.x + delta.width * 0.6);
  await expect.poll(() => lastOrder(store)).toEqual(["Beta", "Gamma", "Delta", "Alpha"]);
  expect(lastGroups(store)).toEqual([agents({ collapsed: true })]);
  await expect.poll(() => painted(page)).toEqual(["[Agents]", "Delta", "Alpha"]);
});

test("Alt+Shift+Arrow walks a tab into a group and out the other side", async ({ page }) => {
  const store = await setup(page, strip([agents()]));
  await page.getByRole("tab", { name: "Delta" }).focus();

  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(() => lastOrder(store)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
  expect(lastGroups(store)?.[0]?.tab_ids).toEqual(["tab-2", "tab-4", "tab-3"]);

  // Still touching the group at its head: it stays in.
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(() => lastOrder(store)).toEqual(["Alpha", "Delta", "Beta", "Gamma"]);
  expect(lastGroups(store)?.[0]?.tab_ids).toEqual(["tab-4", "tab-2", "tab-3"]);

  // Past Alpha, it has left.
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(() => lastOrder(store)).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
  expect(lastGroups(store)?.[0]?.tab_ids).toEqual(["tab-2", "tab-3"]);
});

test("Alt+Shift+Arrow steps over a folded group in one go", async ({ page }) => {
  const store = await setup(page, strip([agents({ collapsed: true })]));
  await page.getByRole("tab", { name: "Delta" }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(() => lastOrder(store)).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
  expect(lastGroups(store)).toEqual([agents({ collapsed: true })]);
});

test("the manage panel opens from the keyboard, folds, and ungroups", async ({ page }) => {
  const store = await setup(page, strip([agents()]));
  const agentsLabel = label(page, "Agents");
  await agentsLabel.focus();
  await page.keyboard.press("Shift+F10");
  const panel = page.getByRole("group", { name: "Manage tab group" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Group name" })).toBeFocused();
  // Escape closes and hands the focus back.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(agentsLabel).toBeFocused();
  expect(lastGroups(store)).toBeUndefined();

  await rightClick(agentsLabel);
  await panel.getByRole("button", { name: "Collapse group" }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => lastGroups(store)?.[0]?.collapsed).toBe(true);

  await rightClick(agentsLabel);
  await expect(panel.getByRole("button", { name: "Expand group" })).toBeVisible();
  await panel.getByRole("button", { name: "Ungroup tabs" }).click();
  await expect(agentsLabel).toHaveCount(0);
  await expect.poll(() => lastGroups(store)).toEqual([]);
  expect(lastOrder(store)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  await expect(page.getByRole("tab", { name: "Gamma" })).toBeVisible();
});

test("New tab in group makes the tab at the group's end", async ({ page }) => {
  const store = await setup(page, strip([agents()]));
  await rightClick(label(page, "Agents"));
  await page
    .getByRole("group", { name: "Manage tab group" })
    .getByRole("button", { name: "New tab in group" })
    .click();
  await page.getByRole("menuitem", { name: /A plain login shell/ }).click();
  await page.getByRole("menu", { name: "Where?" }).getByRole("menuitem").first().click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  const added = lastLayout(store);
  expect(added?.tabs.map((tab) => tab.name)).toEqual(["Alpha", "Beta", "Gamma", "Tab 5", "Delta"]);
  expect(added?.groups?.[0]?.tab_ids).toEqual(["tab-2", "tab-3", added?.tabs[3]?.id]);
  await expect(page.getByRole("tab", { name: "Tab 5" })).toHaveAttribute("aria-selected", "true");
});

test.describe("on a phone-width window", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the strip with a group still folds, unfolds and opens its panel", async ({ page }) => {
    const store = await setup(page, strip([agents()]));
    const agentsLabel = label(page, "Agents");
    await expect(agentsLabel).toBeVisible();
    await agentsLabel.click();
    await expect(agentsLabel).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("tab", { name: "Gamma" })).toHaveCount(0);
    await expect.poll(() => lastGroups(store)?.[0]?.collapsed).toBe(true);

    await rightClick(agentsLabel);
    const panel = page.getByRole("group", { name: "Manage tab group" });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    if (!box) throw new Error("panel geometry unavailable");
    // The panel stays inside the window.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await panel.getByRole("button", { name: "Expand group" }).click();
    await expect(page.getByRole("tab", { name: "Gamma" })).toBeVisible();
    await expect.poll(() => lastGroups(store)?.[0]?.collapsed).toBe(false);
  });
});
