import { expect, type Page, test } from "@playwright/test";
import { GRID_SIZE, move, remove, resize, type Tile } from "../../src/lib/grid";
import {
  type AppMockOptions,
  envelope,
  HOST_ID,
  mockApp,
  SESSION_B_ID,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

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
    workspaces: [workspace({ layout: { version: 3, tiles } }), ...(options.extraWorkspaces ?? [])],
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
    areaBox.x + (targetX / GRID_SIZE) * areaBox.width + pointerOffsetX,
    areaBox.y + (targetY / GRID_SIZE) * areaBox.height + pointerOffsetY,
    { steps: 4 },
  );
  await beforeDrop?.();
  await page.mouse.up();
}

test("renders layout v2 and persists drag output from grid.move", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  const first = await page.locator(`[data-grid-tile="${SESSION_ID}"]`).boundingBox();
  const second = await page.locator(`[data-grid-tile="${SESSION_B_ID}"]`).boundingBox();
  expect(first && second && first.x < second.x).toBe(true);

  await dragTile(page, SESSION_ID, 0, 12);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]).toEqual({
    id: WORKSPACE_ID,
    body: { layout: envelope({ version: 3, tiles: move(initial, SESSION_ID, 0, 12) }) },
  });
});

test("dropping a pane onto another docks it against the hovered edge", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
  ];
  const { store } = await setupGrid(page, initial);
  // The drag ends with the pointer in the second pane's top zone: the first
  // pane's vacated column is absorbed, the target splits horizontally, and
  // the dragged pane takes the top half (iTerm-style dock).
  await dragTile(page, SESSION_ID, 12, 0);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({
      version: 3,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 12 },
        { session_id: SESSION_B_ID, x: 0, y: 12, w: 24, h: 12 },
      ],
    }),
  });
});

test("the southeast resize handle persists grid.resize output", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }];
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
    layout: envelope({ version: 3, tiles: resize(initial, SESSION_ID, 18, 18) }),
  });
});

test("dragging the seam between two panes trades width between them", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
  ];
  const { store } = await setupGrid(page, initial);
  const seam = page.locator("[data-grid-divider='vertical-12-0']");
  const seamBox = await seam.boundingBox();
  const areaBox = await page
    .locator(`[data-grid-tile="${SESSION_ID}"]`)
    .locator("..")
    .boundingBox();
  if (!seamBox || !areaBox) throw new Error("seam geometry unavailable");

  await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + seamBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    areaBox.x + (16 / GRID_SIZE) * areaBox.width,
    seamBox.y + seamBox.height / 2,
    {
      steps: 4,
    },
  );
  await page.mouse.up();

  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({
      version: 3,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 16, h: 24 },
        { session_id: SESSION_B_ID, x: 16, y: 0, w: 8, h: 24 },
      ],
    }),
  });
});

test("clicking the title bar without moving is not a drag", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
  ];
  const { store } = await setupGrid(page, initial);
  const tile = page.locator(`[data-grid-tile="${SESSION_ID}"]`);
  const before = await tile.boundingBox();
  await page.getByRole("toolbar", { name: "palette window controls" }).click();
  // Long enough for the debounced layout save to have fired, had one been queued.
  await page.waitForTimeout(700);
  expect((await tile.boundingBox())?.x).toBeCloseTo(before?.x ?? -1, 0);
  expect(store.requests.workspacePatches).toHaveLength(0);
});

test("shrinking a pane leaves empty canvas you can drop a pane into", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }];
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
    layout: envelope({ version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 }] }),
  });
  // The freed half is offered as a drop target rather than being repacked.
  await expect(page.locator("[data-grid-opening='12,0,12,24']")).toBeVisible();
});

test("double-clicking a header expands only that window into empty space", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 8, h: 12 },
    { session_id: SESSION_B_ID, x: 0, y: 12, w: 8, h: 12 },
    { session_id: THIRD_SESSION_ID, x: 16, y: 0, w: 8, h: 24 },
  ];
  const { store } = await setupGrid(page, initial);
  await page.getByRole("toolbar", { name: "palette window controls" }).dblclick();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({
      version: 3,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 16, h: 12 },
        { session_id: THIRD_SESSION_ID, x: 16, y: 0, w: 8, h: 24 },
        { session_id: SESSION_B_ID, x: 0, y: 12, w: 8, h: 12 },
      ],
    }),
  });
});

test("removing a tile re-packs and expands the survivor", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
  ];
  const { store } = await setupGrid(page, initial);
  await page.getByRole("button", { name: "Close palette" }).click();
  const confirm = page.getByRole("dialog", { name: /^Close / });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Close session" }).click();
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.workspacePatches[0]?.body).toEqual({
    layout: envelope({ version: 3, tiles: remove(initial, SESSION_ID) }),
  });
});

test("Alt+arrows follow reading order and Alt+digits switch workspace position", async ({
  page,
}) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
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
  await expect(page.getByRole("heading", { name: "Open your first window" })).toBeVisible();
  // One lozenge per thing a window can run, straight from the cascade.
  const row = page.getByRole("toolbar", { name: "Add a window" });
  await expect(row.getByRole("button", { name: "Shell", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "File explorer" })).toBeVisible();
});

test("the empty state's first window takes the left half, not the whole canvas", async ({
  page,
}) => {
  // A workspace with a home of its own: picking a lozenge is the whole flow.
  const store = await mockApp(page, {
    workspaces: [workspace({ host_id: HOST_ID, cwd: "/Users/tester" })],
    sessions: [],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page
    .getByRole("toolbar", { name: "Add a window" })
    .getByRole("button", { name: "Shell", exact: true })
    .click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({ tile: { x: 0, y: 0, w: 12, h: 24 } });
  // The half it did not take invites the next window without a hover.
  const opening = page.locator("[data-grid-opening='12,0,12,24']");
  await expect(opening.getByText("Add a window")).toHaveCSS("opacity", "1");
});

test("a lone window advertises the canvas beside it", async ({ page }) => {
  // What the empty state leaves behind: one window on the left half, and an
  // opening that says so without being hovered first.
  await setupGrid(page, [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 }], {
    sessionFixtures: [session()],
  });
  const opening = page.locator("[data-grid-opening='12,0,12,24']");
  await expect(opening.getByText("Add a window")).toHaveCSS("opacity", "1");
});

test("openings go quiet once a second window is on the canvas", async ({ page }) => {
  await setupGrid(page, [
    { session_id: SESSION_ID, x: 0, y: 0, w: 8, h: 24 },
    { session_id: SESSION_B_ID, x: 8, y: 0, w: 8, h: 24 },
  ]);
  const opening = page.locator("[data-grid-opening='16,0,8,24']");
  await expect(opening.getByText("Add a window")).toHaveCSS("opacity", "0");
});

test("a session needing attention says so on its icon badge", async ({ page }) => {
  await setupGrid(page, [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }], {
    sessionFixtures: [session({ activity_state: "waiting", activity_label: "Needs input" })],
  });
  await expect(
    page.getByRole("region", { name: "palette" }).getByRole("img", { name: "Needs input" }),
  ).toBeVisible();
});

test("a failed layout PATCH rolls the optimistic drag back", async ({ page }) => {
  const initial: Tile[] = [
    { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 },
    { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 12 },
  ];
  const { store } = await setupGrid(page, initial);
  const tile = page.locator(`[data-grid-tile="${SESSION_ID}"]`);
  const area = tile.locator("..");
  store.failNextWorkspacePatch(503, "layout unavailable");
  await dragTile(page, SESSION_ID, 0, 12);
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

test("⌘ turns a drag into a duplicate: the source stays put and a copy is created", async ({
  page,
}) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 }];
  const { store } = await setupGrid(page, initial, {
    sessionFixtures: [session({ foreground_command: "codex" })],
  });

  await dragTile(page, SESSION_ID, 12, 0, async () => {
    await page.keyboard.down("Meta");
    // The ghost says what the drop will do; the source pane has gone home.
    await expect(page.locator("[data-grid-ghost][data-clone]")).toBeVisible();
  });
  await page.keyboard.up("Meta");

  // Same host, same folder — a second pane pointed at the same work.
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: session().host_id,
    cwd: session().cwd,
  });

  // The source keeps its own tile; the copy takes the half it was dropped on.
  await expect.poll(() => store.requests.workspacePatches.length).toBeGreaterThan(0);
  const tiles = (
    store.requests.workspacePatches.at(-1)?.body as {
      layout: { tabs: Array<{ layout: { tiles: Tile[] } }> };
    }
  ).layout.tabs[0]?.layout.tiles;
  expect(tiles?.length).toBe(2);
  expect(tiles?.some((tile) => tile.session_id === SESSION_ID)).toBe(true);
  expect(tiles?.some((tile) => tile.session_id !== SESSION_ID)).toBe(true);
});

test("⌥ duplicates too", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });

  await dragTile(page, SESSION_ID, 12, 0, async () => {
    await page.keyboard.down("Alt");
    await expect(page.locator("[data-grid-ghost][data-clone]")).toBeVisible();
  });
  await page.keyboard.up("Alt");

  await expect.poll(() => store.requests.sessions.length).toBe(1);
});

test("a plain drag still moves — a modifier is what copies", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });

  await dragTile(page, SESSION_ID, 12, 12);
  await expect.poll(() => store.requests.workspacePatches.length).toBe(1);
  expect(store.requests.sessions).toEqual([]);
});

test("the pane menu duplicates too, and names the ⌘ drag shortcut", async ({ page }) => {
  const initial: Tile[] = [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }];
  const { store } = await setupGrid(page, initial, { sessionFixtures: [session()] });

  await page
    .getByRole("button", { name: /options$/ })
    .first()
    .click();
  const item = page.getByRole("menuitem", { name: /Duplicate/ });
  await expect(item).toContainText("⌘/⌥ drag");
  await item.click();

  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: session().host_id,
    cwd: session().cwd,
  });
});
