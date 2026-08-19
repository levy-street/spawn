import { expect, type Page, test } from "@playwright/test";
import { move, remove, resize, type Tile } from "../../src/lib/grid";
import {
  type AppMockOptions,
  envelope,
  mockApp,
  SESSION_B_ID,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock, sendPty } from "./session-rtc-mock";

const THIRD_SESSION_ID = "00000000-0000-4000-8000-00000000000a";
const SECOND_WORKSPACE_ID = "00000000-0000-4000-8000-00000000000b";

async function setupGrid(
  page: Page,
  tiles: Tile[],
  options: Omit<AppMockOptions, "sessions" | "workspaces"> & {
    sessionFixtures?: ReturnType<typeof session>[];
    extraWorkspaces?: ReturnType<typeof workspace>[];
  } = {},
) {
  const connections: string[] = [];
  await installSessionRtcMock(page, [], {
    history: "ready\r\n$ ",
    autoSnapshot: true,
  });
  const fixtures = options.sessionFixtures ?? [
    session(),
    session({ id: SESSION_B_ID, name: "beta" }),
    session({ id: THIRD_SESSION_ID, name: "gamma" }),
  ];
  const store = await mockApp(page, {
    ...options,
    sessions: fixtures,
    workspaces: [workspace({ layout: { version: 2, tiles } }), ...(options.extraWorkspaces ?? [])],
  });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    connections.push(new URL(ws.url()).searchParams.get("session_id") ?? "missing");
    ws.onMessage((message) => handleSessionRtcSignal(ws, message));
    ws.send(
      JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        binding_nonce_required: true,
      }),
    );
    ws.send(JSON.stringify({ type: "session.status", status: "running" }));
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  return { store, connections };
}

/** Press the title bar itself — the whole bar is the drag surface. */
async function dragTile(
  page: Page,
  sessionId: string,
  targetX: number,
  targetY: number,
  beforeDrop?: () => Promise<void>,
) {
  const element = page.locator(`[data-grid-tile="${sessionId}"]`);
  const area = element.locator("..");
  const tileBox = await element.boundingBox();
  const areaBox = await area.boundingBox();
  const barBox = await element.getByRole("toolbar").boundingBox();
  if (!tileBox || !areaBox || !barBox) throw new Error("grid geometry unavailable");
  const startX = barBox.x + barBox.width * 0.4;
  const startY = barBox.y + barBox.height / 2;
  const pointerOffsetX = startX - tileBox.x;
  const pointerOffsetY = startY - tileBox.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(
    areaBox.x + (targetX / 12) * areaBox.width + pointerOffsetX,
    areaBox.y + (targetY / 12) * areaBox.height + pointerOffsetY,
    { steps: 4 },
  );
  await beforeDrop?.();
  await page.mouse.up();
}

test("renders layout v2 and persists drag output from grid.move", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 6 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 6 },
  ];
  const { store } = await setupGrid(page, initial);
  const first = await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox();
  const second = await page.locator(`[data-grid-tile="${SESSION_B_ID}"]`).boundingBox();
  expect(first && second && first.x < second.x).toBe(true);

  await dragTile(page, SESSION_ID, 0, 6);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]).toEqual({
    id: WORKSPACE_ID,
    body: { layout: envelope({ version: 2, tiles: move(initial, SESSION_ID, 0, 6) }) },
  });
});

test("dropping a pane onto another docks it against the hovered edge", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  // The drag ends with the pointer in the second pane's top zone: the first
  // pane's vacated column is absorbed, the target splits horizontally, and
  // the dragged pane takes the top half (iTerm-style dock).
  await dragTile(page, SESSION_ID, 6, 0);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({
      version: 2,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 6 },
        { session_id: SESSION_B_ID, x: 0, y: 6, w: 12, h: 6 },
      ],
    }),
  });
});

test("the southeast resize handle persists grid.resize output", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 6 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });
  const handle = page.getByRole("button", { name: "Resize palette (bottom-right corner)" });
  const tileBox = await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox();
  const handleBox = await handle.boundingBox();
  if (!tileBox || !handleBox) throw new Error("resize geometry unavailable");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tileBox.x + tileBox.width * 1.5, tileBox.y + tileBox.height * 1.5);
  await page.mouse.up();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({ version: 2, tiles: resize(initial, SESSION_ID, 9, 9) }),
  });
});

test("dragging the seam between two panes trades width between them", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  const seam = page.locator("[data-grid-divider='vertical-6-0']");
  const seamBox = await seam.boundingBox();
  const areaBox = await page
    .locator(`[data-grid-tile="${SESSION_ID}"]`)
    .locator("..")
    .boundingBox();
  if (!seamBox || !areaBox) throw new Error("seam geometry unavailable");

  await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + seamBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(areaBox.x + (8 / 12) * areaBox.width, seamBox.y + seamBox.height / 2, {
    steps: 4,
  });
  await page.mouse.up();

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({
      version: 2,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 8, h: 12 },
        { session_id: SESSION_B_ID, x: 8, y: 0, w: 4, h: 12 },
      ],
    }),
  });
});

test("clicking the title bar without moving is not a drag", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  const tile = page.locator(`[data-grid-tile="${SESSION_ID}"]`);
  const before = await tile.boundingBox();
  await page.getByRole("toolbar", { name: "palette pane controls" }).click();
  // Long enough for the debounced layout save to have fired, had one been queued.
  await page.waitForTimeout(700);
  expect((await tile.boundingBox())?.x).toBeCloseTo(before?.x ?? -1, 0);
  expect(store.requests.workspacePatches).toHaveLength(0);
});

test("shrinking a pane leaves empty canvas you can drop a pane into", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });
  const handle = page.getByRole("button", { name: "Resize palette (bottom-right corner)" });
  const areaBox = await page
    .locator(`[data-grid-tile="${SESSION_ID}"]`)
    .locator("..")
    .boundingBox();
  const handleBox = await handle.boundingBox();
  if (!areaBox || !handleBox) throw new Error("resize geometry unavailable");

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({ version: 2, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 }] }),
  });
  // The freed half is offered as a drop target rather than being repacked.
  await expect(page.locator("[data-grid-opening='6,0,6,12']")).toBeVisible();
});

test("removing a tile re-packs and expands the survivor", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  await page.getByRole("button", { name: "palette options" }).click();
  await page.getByRole("menuitem", { name: "Close session" }).click();
  await page
    .getByRole("dialog", { name: /^Close / })
    .getByRole("button", { name: "Close session" })
    .click();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({ version: 2, tiles: remove(initial, SESSION_ID) }),
  });
});

test("zoom hides siblings without remounting or losing the terminal buffer", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { connections } = await setupGrid(page, initial);
  await expect.poll(() => connections.length).toBe(2);
  await sendPty(page, "KEEP-ALIVE", 0);
  const firstPane = page.getByRole("region", { name: "palette" });
  await expect(firstPane.locator(".xterm-rows")).toContainText("KEEP-ALIVE");
  await firstPane.getByRole("toolbar", { name: "palette pane controls" }).dblclick();
  await expect(page.locator(`[data-grid-tile="${SESSION_B_ID}"]`)).toBeHidden();
  await firstPane.getByRole("toolbar", { name: "palette pane controls" }).dblclick();
  await expect(page.locator(`[data-grid-tile="${SESSION_B_ID}"]`)).toBeVisible();
  await expect(firstPane.locator(".xterm-rows")).toContainText("KEEP-ALIVE");
  expect(connections).toHaveLength(2);
});

test("Alt+arrows follow reading order and Alt+digits switch workspace position", async ({
  page,
}) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  await setupGrid(page, initial, {
    extraWorkspaces: [workspace({ id: SECOND_WORKSPACE_ID, name: "second", position: 1 })],
  });
  const firstInput = page
    .getByRole("region", { name: "palette" })
    .locator(".xterm-helper-textarea");
  const secondInput = page.getByRole("region", { name: "beta" }).locator(".xterm-helper-textarea");
  await firstInput.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(secondInput).toBeFocused();
  await page.keyboard.press("Alt+Digit2");
  await page.waitForURL(`/w/${SECOND_WORKSPACE_ID}`);
});

test("empty workspaces offer session creation", async ({ page }) => {
  await setupGrid(page, [], { sessionFixtures: [] });
  await expect(page.getByRole("heading", { name: "Start with a shell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
});

test("a session needing attention says so on its icon badge", async ({ page }) => {
  await setupGrid(page, [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }], {
    sessionFixtures: [session({ activity_state: "waiting", activity_label: "Needs input" })],
  });
  await expect(
    page.getByRole("region", { name: "palette" }).getByRole("img", { name: "Needs input" }),
  ).toBeVisible();
});

test("a failed layout PATCH rolls the optimistic drag back", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 6 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 6 },
  ];
  const { store } = await setupGrid(page, initial);
  const tile = page.locator(`[data-grid-tile="${SESSION_ID}"]`);
  const area = tile.locator("..");
  store.failNextWorkspacePatch(503, "layout unavailable");
  await dragTile(page, SESSION_ID, 0, 6);
  await expect(page.locator("p[role='alert']")).toContainText("layout unavailable");
  // Measured against the grid area: the error banner shifts the whole page.
  await expect
    .poll(async () => {
      const tileBox = await tile.boundingBox();
      const areaBox = await area.boundingBox();
      return tileBox && areaBox ? Math.round(tileBox.y - areaBox.y) : null;
    })
    .toBe(0);
  expect(
    (store.workspaces[0]?.layout as { tabs: Array<{ layout: { tiles: Tile[] } }> }).tabs[0]?.layout
      .tiles,
  ).toEqual(initial);
});
