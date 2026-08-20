import { expect, type Page, test } from "@playwright/test";
import { allTiles, type LayoutV3 } from "../../src/lib/tabs";
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
      version: 3,
      tiles: [
        { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
        { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
      ],
    },
  });
  const alpha = workspace({
    id: ALPHA_WORKSPACE_ID,
    name: "Alpha desk",
    position: 0,
    layout: { version: 3, tiles: [] },
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

test("the sidebar lists workspaces only, ordered by position", async ({ page }) => {
  await setupSidebar(page);
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  const alpha = nav.getByRole("link", { name: /Alpha desk/ });
  const zeta = nav.getByRole("link", { name: /Zeta desk/ });
  expect((await alpha.boundingBox())?.y).toBeLessThan((await zeta.boundingBox())?.y ?? 0);

  // Sessions live in the workspace view now, not the sidebar tree.
  await expect(nav.getByRole("link", { name: /palette/ })).toHaveCount(0);
  // Scoped to the tree: workspace rows have no expanders of their own. (The
  // sidebar's own collapse control lives outside the nav.)
  await expect(nav.getByRole("button", { name: /^(Collapse|Expand) / })).toHaveCount(0);

  await alpha.click();
  await expect(page).toHaveURL(`/w/${ALPHA_WORKSPACE_ID}`);
});

test("attention rolls up onto the workspace row", async ({ page }) => {
  await setupSidebar(page, true);
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  await expect(nav.getByRole("listitem").filter({ hasText: "Zeta desk" })).toContainText("1");
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

  // Reordering is drag-driven now (no Move up/down menu items).
  await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveCount(0);

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

test("archiving a busy workspace warns first, then moves it into the drawer", async ({ page }) => {
  const store = await setupSidebar(page);
  // Nothing is archived yet, so the drawer must not take up a row at all.
  await expect(page.getByRole("button", { name: /^Archived/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Zeta desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  const warning = page.getByRole("dialog", { name: "Archive Zeta desk?" });
  await expect(warning).toContainText("2 running sessions will be stopped");
  await expect(warning).toContainText("The layout is kept");
  await warning.getByRole("button", { name: "Archive workspace" }).click();

  await expect
    .poll(() => store.workspaces.find((item) => item.id === WORKSPACE_ID)?.archived_at)
    .not.toBe(null);
  // The windows stop where they are: same rows, same tiles, nothing running.
  expect(store.sessions.map((item) => item.status)).toEqual(["killed", "killed"]);
  const archived = store.workspaces.find((item) => item.id === WORKSPACE_ID);
  expect(allTiles(archived?.layout as LayoutV3)).toHaveLength(2);
  await expect
    .poll(() => store.workspaces.find((item) => item.id === ALPHA_WORKSPACE_ID)?.position)
    .toBe(0);

  // Said out loud, and the view moves to the workspace that took its slot
  // rather than sitting in the one that just stopped.
  await expect(page.getByText("Archived Zeta desk")).toBeVisible();
  await expect(page).toHaveURL(`/w/${ALPHA_WORKSPACE_ID}`);

  // Out of the tree, into the drawer — which is collapsed until asked.
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  await expect(nav.getByRole("link", { name: /Zeta desk/ })).toHaveCount(0);
  const disclosure = page.getByRole("button", { name: /^Archived/ });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Zeta desk archived actions" })).toHaveCount(0);
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Zeta desk", { exact: true })).toBeVisible();
});

test("archiving an idle workspace does not stop to ask", async ({ page }) => {
  const store = await setupSidebar(page);
  // Alpha desk has no panes, so there is nothing running to warn about.
  await page.getByRole("button", { name: "Alpha desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect
    .poll(() => store.workspaces.find((item) => item.id === ALPHA_WORKSPACE_ID)?.archived_at)
    .not.toBe(null);
  await expect(page.getByRole("dialog", { name: /Archive/ })).toHaveCount(0);
});

test("the archived drawer restores and deletes forever", async ({ page }) => {
  const store = await setupSidebar(page);
  await page.getByRole("button", { name: "Alpha desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("button", { name: /^Archived/ })).toBeVisible();
  await page.getByRole("button", { name: /^Archived/ }).click();

  await page.getByRole("button", { name: "Alpha desk archived actions" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect
    .poll(() => store.requests.workspaceArchives.at(-1))
    .toEqual({ id: ALPHA_WORKSPACE_ID, restoring: true });
  await expect(page).toHaveURL(`/w/${ALPHA_WORKSPACE_ID}`);
  // Restored rows rejoin the tree and the drawer disappears again.
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  await expect(nav.getByRole("link", { name: /Alpha desk/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Archived/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Alpha desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  // The disclosure remembers it was opened, so the row is there already.
  await expect(page.getByRole("button", { name: /^Archived/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.getByRole("button", { name: "Alpha desk archived actions" }).click();
  await page.getByRole("menuitem", { name: "Delete forever" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Alpha desk forever?" });
  await expect(confirm).toContainText("cannot be undone");
  await confirm.getByRole("button", { name: "Delete forever" }).click();
  await expect
    .poll(() => store.workspaces.some((item) => item.id === ALPHA_WORKSPACE_ID))
    .toBe(false);
});

test("an archived workspace opens as itself, stopped, and restores in place", async ({ page }) => {
  const store = await setupSidebar(page);
  await page.getByRole("button", { name: "Zeta desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page
    .getByRole("dialog", { name: "Archive Zeta desk?" })
    .getByRole("button", {
      name: "Archive workspace",
    })
    .click();
  await page.getByRole("button", { name: /^Archived/ }).click();

  // The row is a link like any other: it shows the workspace as it was put
  // away, and nothing is restored on the way in.
  await page.getByRole("link", { name: /Zeta desk/ }).click();
  await expect(page).toHaveURL(`/w/${WORKSPACE_ID}`);
  // The real canvas, not a stand-in: the same windows in the same tiles.
  await expect(page.getByText(/Every window in here is stopped/)).toBeVisible();
  await expect(page.getByRole("region", { name: "palette" })).toBeVisible();
  await expect(page.getByRole("region", { name: "beta" })).toBeVisible();
  expect(store.requests.workspaceArchives.filter((item) => item.restoring)).toHaveLength(0);
  await expect
    .poll(() => store.workspaces.find((item) => item.id === WORKSPACE_ID)?.archived_at)
    .not.toBe(null);

  // Restoring is the button on the page, and only then does it come back.
  await page.getByRole("button", { name: "Restore" }).click();
  await expect
    .poll(() => store.requests.workspaceArchives.at(-1))
    .toEqual({ id: WORKSPACE_ID, restoring: true });
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  await expect(nav.getByRole("link", { name: /Zeta desk/ })).toBeVisible();
  // Restored in place: the same sessions, started again under the same ids.
  expect(store.sessions.map((item) => item.status)).toEqual(["starting", "starting"]);
});

test("the drawer keeps five and View all carries the rest, with the search", async ({ page }) => {
  // Seven put away, so the drawer has to draw a line somewhere.
  const put = Array.from({ length: 7 }, (_, index) =>
    workspace({
      id: `00000000-0000-4000-8000-00000000010${index}`,
      name: `Desk ${index}`,
      position: 0,
      layout: { version: 3, tiles: [] },
      // Desk 6 is the most recently archived, Desk 0 the least.
      archived_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    }),
  );
  const live = workspace({ name: "Zeta desk", position: 0, layout: { version: 3, tiles: [] } });
  await mockApp(page, { sessions: [], workspaces: [live, ...put] });
  await page.goto(`/w/${WORKSPACE_ID}`);

  await page.getByRole("button", { name: /^Archived/ }).click();
  const drawer = page.getByRole("navigation", { name: "Workspaces" }).locator("..");
  const viewAll = page.getByRole("button", { name: "View all (7)" });
  await expect(viewAll).toBeVisible();
  // The five most recently archived, newest first — Desk 0 did not make it.
  for (const index of [6, 5, 4, 3, 2]) {
    await expect(drawer.getByRole("link", { name: `Desk ${index}` })).toBeVisible();
  }
  await expect(drawer.getByRole("link", { name: "Desk 0" })).toHaveCount(0);

  await viewAll.click();
  const dialog = page.getByRole("dialog", { name: "Archived" });
  await expect(dialog.getByRole("link")).toHaveCount(7);
  await dialog.getByLabel("Search archived workspaces").fill("desk 0");
  await expect(dialog.getByRole("link")).toHaveCount(1);

  // Opening one the drawer had cut promotes it: it is where you left it.
  await dialog.getByRole("link", { name: "Desk 0" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/w/00000000-0000-4000-8000-000000000100");
  const rows = drawer.getByRole("listitem").filter({ hasText: /Desk \d/ });
  await expect(rows.first()).toContainText("Desk 0");
  await expect(rows).toHaveCount(5);

  // A row the drawer already had stays where it is when it is opened.
  await drawer.getByRole("link", { name: "Desk 5" }).click();
  await expect(page).toHaveURL("/w/00000000-0000-4000-8000-000000000105");
  await expect(rows.first()).toContainText("Desk 6");
});

test("the collapsed rail opens the archive as a dialog", async ({ page }) => {
  await setupSidebar(page);
  await page.getByRole("button", { name: "Alpha desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();

  // No room for a list on the rail, so the row opens the full one instead.
  await page.getByRole("button", { name: /^Archived/ }).click();
  const dialog = page.getByRole("dialog", { name: "Archived" });
  await expect(dialog.getByRole("link", { name: /Alpha desk/ })).toBeVisible();
});

test("the archived drawer sits directly above Settings", async ({ page }) => {
  await setupSidebar(page);
  await page.getByRole("button", { name: "Alpha desk actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  const disclosure = page.getByRole("button", { name: /^Archived/ });
  await expect(disclosure).toBeVisible();
  // Exact: the workspace tab strip carries a "<name> settings" button too.
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  const drawerY = (await disclosure.boundingBox())?.y ?? 0;
  expect(drawerY).toBeGreaterThan((await nav.boundingBox())?.y ?? 0);
  expect(drawerY).toBeLessThan((await settings.boundingBox())?.y ?? 0);
});
