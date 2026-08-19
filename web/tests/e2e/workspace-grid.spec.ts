import { expect, type Page, test } from "@playwright/test";
import { move, remove, resize, type Tile } from "../../src/lib/grid";
import {
  type AppMockOptions,
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
  const gripBox = await element.getByRole("button", { name: /^Move / }).boundingBox();
  if (!tileBox || !areaBox || !gripBox) throw new Error("grid geometry unavailable");
  const startX = gripBox.x + gripBox.width / 2;
  const startY = gripBox.y + gripBox.height / 2;
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
    body: { layout: { version: 2, tiles: move(initial, SESSION_ID, 0, 6) } },
  });
});

test("a blocked full-height drag swaps columns and exposes the exchange highlight", async ({
  page,
}) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  await dragTile(page, SESSION_ID, 6, 0, async () => {
    await expect(
      page.locator(`[data-grid-tile="${SESSION_B_ID}"][data-swap-target]`),
    ).toBeVisible();
    await expect(page.locator("[data-swap]")).toBeVisible();
  });
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: { version: 2, tiles: move(initial, SESSION_ID, 6, 0) },
  });
});

test("the southeast resize handle persists grid.resize output", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 6 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });
  const handle = page.getByRole("button", { name: "Resize palette" });
  const tileBox = await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox();
  const handleBox = await handle.boundingBox();
  if (!tileBox || !handleBox) throw new Error("resize geometry unavailable");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tileBox.x + tileBox.width * 1.5, tileBox.y + tileBox.height * 1.5);
  await page.mouse.up();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: { version: 2, tiles: resize(initial, SESSION_ID, 9, 9) },
  });
});

test("removing a tile re-packs and expands the survivor", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  await page.getByRole("button", { name: "palette options" }).click();
  await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: { version: 2, tiles: remove(initial, SESSION_ID) },
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

test("a session needing attention gets a warning hairline", async ({ page }) => {
  await setupGrid(page, [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }], {
    sessionFixtures: [session({ activity_state: "waiting", activity_label: "Needs input" })],
  });
  await expect(
    page.getByRole("region", { name: "palette" }).locator("span.bg-warning"),
  ).toHaveCount(1);
});

test("a failed layout PATCH rolls the optimistic drag back", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 6 },
    { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 6 },
  ];
  const { store } = await setupGrid(page, initial);
  const before = await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox();
  store.failNextWorkspacePatch(503, "layout unavailable");
  await dragTile(page, SESSION_ID, 0, 6);
  await expect(page.getByRole("alert")).toContainText("layout unavailable");
  await expect
    .poll(async () => (await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox())?.y)
    .toBeCloseTo(before?.y ?? 0, 0);
  expect((store.workspaces[0]?.layout as { tiles: Tile[] }).tiles).toEqual(initial);
});
