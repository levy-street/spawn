import { expect, type Page, test } from "@playwright/test";
import { mockApp, SESSION_B_ID, SESSION_ID, session, WORKSPACE_ID, workspace } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

const ALPHA_WORKSPACE_ID = "00000000-0000-4000-8000-00000000000d";

async function setupSidebar(page: Page, attention = false) {
  await installSessionRtcMock(page, [], { history: "$ ", autoSnapshot: true });
  const sessions = [
    session({
      activity_state: attention ? "waiting" : "quiet",
      activity_label: attention ? "Needs input" : "Quiet",
    }),
    session({ id: SESSION_B_ID, name: "beta" }),
  ];
  const primary = workspace({
    name: "Zeta desk",
    position: 1,
    layout: {
      version: 2,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 6, h: 12 },
        { session_id: SESSION_B_ID, x: 6, y: 0, w: 6, h: 12 },
      ],
    },
  });
  const alpha = workspace({
    id: ALPHA_WORKSPACE_ID,
    name: "Alpha desk",
    position: 0,
    layout: { version: 2, tiles: [] },
  });
  const store = await mockApp(page, { sessions, workspaces: [primary, alpha] });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
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
  return store;
}

test("workspace tree follows position and expansion persists across reload", async ({ page }) => {
  await setupSidebar(page);
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  const alpha = nav.getByRole("link", { name: /Alpha desk/ });
  const zeta = nav.getByRole("link", { name: /Zeta desk/ });
  expect((await alpha.boundingBox())?.y).toBeLessThan((await zeta.boundingBox())?.y ?? 0);
  await expect(nav.getByRole("link", { name: /palette/ })).toBeVisible();

  await page.getByRole("button", { name: "Collapse Zeta desk" }).click();
  await expect(nav.getByRole("link", { name: /palette/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand Zeta desk" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /palette/ })).toHaveCount(0);
});

test("clicking a session navigates with focus and focuses its pane", async ({ page }) => {
  await setupSidebar(page);
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("link", { name: /beta/ })
    .click();
  await expect(page).toHaveURL(`/w/${WORKSPACE_ID}?focus=${SESSION_B_ID}`);
  await expect(
    page.getByRole("region", { name: "beta" }).locator(".xterm-helper-textarea"),
  ).toBeFocused();
});

test("attention rolls up and hover highlighting works in both directions", async ({ page }) => {
  await setupSidebar(page, true);
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  const workspaceLink = nav.getByRole("link", { name: /Zeta desk/ });
  await expect(workspaceLink).toContainText("1");

  const row = nav.getByRole("link", { name: /palette/ });
  const pane = page.getByRole("region", { name: "palette" });
  await row.hover();
  await expect(pane).toHaveClass(/ring-2/);
  await pane.hover();
  await expect(row).toHaveClass(/bg-accent/);
});

test("workspace rename, reorder, and delete round-trip through the store", async ({ page }) => {
  const store = await setupSidebar(page);
  await page.getByRole("button", { name: "Zeta desk actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByLabel("Rename Zeta desk");
  await rename.fill("Build desk");
  await rename.press("Enter");
  await expect
    .poll(() => String(store.workspaces.find((item) => item.id === WORKSPACE_ID)?.name))
    .toBe("Build desk");

  await page.getByRole("button", { name: "Build desk actions" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect
    .poll(() => Number(store.workspaces.find((item) => item.id === WORKSPACE_ID)?.position))
    .toBe(0);

  await page.getByRole("button", { name: "Build desk actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Build desk?" });
  await expect(confirm).toContainText("Every session in this workspace will be closed");
  await confirm.getByRole("button", { name: "Delete workspace" }).click();
  await expect.poll(() => store.workspaces.some((item) => item.id === WORKSPACE_ID)).toBe(false);
  expect(store.sessions).toHaveLength(0);
});

test("collapsed sidebar rail shows workspace initials", async ({ page }) => {
  await setupSidebar(page);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("link", { name: "AD" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ZD" })).toBeVisible();
});

test.describe("mobile drawer", () => {
  test.use({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });

  test("hamburger opens the workspace drawer and navigation closes it", async ({ page }) => {
    await setupSidebar(page);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Primary navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /Alpha desk/ }).click();
    await expect(page).toHaveURL(`/w/${ALPHA_WORKSPACE_ID}`);
    await expect(drawer).toBeHidden();
  });
});
