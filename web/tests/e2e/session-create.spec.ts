import { expect, type Page, test } from "@playwright/test";
import {
  fileEntry,
  fileListing,
  HOST_ID,
  host,
  mockApp,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const OFFLINE_HOST_ID = "00000000-0000-4000-8000-00000000000c";
const ELSEWHERE_ID = "00000000-0000-4000-8000-0000000000e1";

/** The empty state's Shell lozenge: what goes in the window, so "where" is next. */
async function openEmptyWorkspace(page: Page, options: Parameters<typeof mockApp>[1] = {}) {
  const store = await mockApp(page, {
    workspaces: [workspace()],
    sessions: [],
    ...options,
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page
    .getByRole("toolbar", { name: "Add a window" })
    .getByRole("button", { name: "Shell", exact: true })
    .click();
  return store;
}

function whereMenu(page: Page) {
  return page.getByRole("menu", { name: "Where?" });
}

test("every new window asks where it runs, and the likeliest answer is first", async ({ page }) => {
  const store = await openEmptyWorkspace(page);
  const menu = whereMenu(page);
  await expect(menu).toBeVisible();
  // Nothing has run yet: the host's home folder is the likeliest place.
  const first = menu.getByRole("menuitem").first();
  await expect(first).toContainText("~");
  await expect(first).toContainText("Mac · home");
  await expect(menu.getByRole("menuitem", { name: /Choose a folder/ })).toBeVisible();

  await first.click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  // The first window of an empty tab takes the left half, full height —
  // leaving an opening the grid can offer for a second.
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "~",
    workspace_id: WORKSPACE_ID,
    tile: { x: 0, y: 0, w: 12, h: 24 },
  });
});

test("a window opens next to the one in focus unless told otherwise", async ({ page }) => {
  const elsewhere = session({
    id: ELSEWHERE_ID,
    name: "notes",
    cwd: "/Users/tester/notes",
    last_input_at: "2026-09-30T00:00:00Z",
  });
  const store = await mockApp(page, {
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
    sessions: [session(), elsewhere],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /^Shell/ }).click();

  const items = whereMenu(page).getByRole("menuitem");
  // The pane in focus first, then a place used recently somewhere else.
  await expect(items.nth(0)).toContainText("~/projects/spawn");
  await expect(items.nth(0)).toContainText("Mac · this pane");
  await expect(items.nth(1)).toContainText("~/notes");
  await expect(items.nth(1)).toContainText("Mac · recent");

  await items.nth(1).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/notes",
  });
});

test("an offline host is listed but cannot be chosen, here or when browsing", async ({ page }) => {
  await openEmptyWorkspace(page, {
    hosts: [host, { ...host, id: OFFLINE_HOST_ID, name: "Old Mac", status: "offline" }],
  });
  const menu = whereMenu(page);
  await expect(menu.getByRole("menuitem", { name: /Old Mac · offline/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem").first()).toContainText("Mac · home");

  await menu.getByRole("menuitem", { name: /Choose a folder/ }).click();
  const hosts = page.getByRole("menu", { name: "Choose a host" });
  await expect(hosts.getByRole("menuitem", { name: /Old Mac.*offline/ })).toBeDisabled();
  await hosts.getByRole("menuitem", { name: /^Mac/ }).click();
  await expect(page.getByRole("dialog", { name: "Select a folder on Mac" })).toBeVisible();
});

test("choosing a folder browses the host and opens the window there", async ({ page }) => {
  const store = await openEmptyWorkspace(page, {
    files: (_hostId, path) =>
      path === "/Users/tester/projects"
        ? fileListing({
            path,
            parent: "/Users/tester",
            entries: [
              fileEntry({
                name: "src",
                path: "/Users/tester/projects/src",
                is_dir: true,
                size: null,
              }),
            ],
          })
        : fileListing({
            path: "/Users/tester",
            entries: [
              fileEntry({
                name: "projects",
                path: "/Users/tester/projects",
                is_dir: true,
                size: null,
              }),
            ],
          }),
  });
  // One host: straight to its folders, no host list in between.
  await whereMenu(page)
    .getByRole("menuitem", { name: /Choose a folder/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
    tile: { x: 0, y: 0, w: 12, h: 24 },
  });
});

test("a blank workspace is made at once, with no host or folder of its own", async ({ page }) => {
  const store = await mockApp(page, { workspaces: [workspace()], sessions: [] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByRole("menuitem", { name: "Blank workspace" }).click();
  await expect.poll(() => store.requests.workspaces.length).toBe(1);
  expect(store.requests.workspaces[0]).toEqual({});
  await expect(page).not.toHaveURL(new RegExp(WORKSPACE_ID));
});

test("workspace_full disables the lozenges with an explanation", async ({ page }) => {
  const store = await openEmptyWorkspace(page, { workspaceFull: true });
  await whereMenu(page).getByRole("menuitem").first().click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  const row = page.getByRole("toolbar", { name: "Add a window" });
  await expect(row.getByRole("button", { name: "Shell", exact: true })).toBeDisabled();
  await expect(row).toHaveAttribute(
    "title",
    "This workspace is full. Remove a window before adding another session.",
  );
  expect(store.sessions).toHaveLength(0);
});
