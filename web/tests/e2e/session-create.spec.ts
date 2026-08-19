import { expect, type Page, test } from "@playwright/test";
import {
  fileEntry,
  fileListing,
  HOST_ID,
  host,
  mockApp,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const OFFLINE_HOST_ID = "00000000-0000-4000-8000-00000000000c";
const SECOND_HOST_ID = "00000000-0000-4000-8000-00000000000e";

async function openEmptyWorkspace(page: Page, options: Parameters<typeof mockApp>[1] = {}) {
  const store = await mockApp(page, {
    workspaces: [workspace()],
    sessions: [],
    ...options,
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "New session" }).click();
  return store;
}

test("one host skips host choice and Home creates in ~", async ({ page }) => {
  const store = await openEmptyWorkspace(page);
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Choose a location");
  await expect(menu.getByRole("menuitem", { name: /Mac/ })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: /Home/ }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "~",
    workspace_id: WORKSPACE_ID,
  });
});

test("multiple hosts are shown and offline hosts are disabled", async ({ page }) => {
  await openEmptyWorkspace(page, {
    hosts: [host, { ...host, id: OFFLINE_HOST_ID, name: "Old Mac", status: "offline" }],
  });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Choose a host");
  await expect(menu.getByRole("menuitem", { name: /Old Mac.*offline/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: /^Mac/ }).click();
  await expect(menu.getByRole("menuitem", { name: /Home/ })).toBeVisible();
});

test("a recent directory creates the session in that exact path", async ({ page }) => {
  const store = await openEmptyWorkspace(page, {
    recentDirs: {
      [HOST_ID]: [{ path: "/Users/tester/projects/spawn", last_used_at: "2026-08-19T01:00:00Z" }],
    },
  });
  await page.getByRole("menuitem", { name: /spawn.*\/Users\/tester\/projects\/spawn/ }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects/spawn",
    workspace_id: WORKSPACE_ID,
  });
});

test("folder picker browses the host control channel and selects the open folder", async ({
  page,
}) => {
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
  await page.getByRole("menuitem", { name: "Select folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
  });
});

test("a new workspace is named after the folder it opens in", async ({ page }) => {
  // Two hosts: "Select folder" hops through a host list before the modal.
  const store = await mockApp(page, {
    hosts: [host, { ...host, id: SECOND_HOST_ID, name: "Linux box" }],
    workspaces: [workspace()],
    sessions: [],
    recentDirs: {
      [HOST_ID]: [
        { path: "/Users/tester/projects/singingcoach", last_used_at: "2026-08-19T01:00:00Z" },
      ],
    },
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByRole("menuitem", { name: "Select folder" }).click();
  // Two hosts: one hop picks the host, then the folder modal opens directly.
  await page.getByRole("menuitem", { name: /^Mac/ }).click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await expect.poll(() => store.workspaces.at(-1)?.name).toBe("tester");
});

test("workspace_full disables the plus with an explanation", async ({ page }) => {
  const store = await openEmptyWorkspace(page, { workspaceFull: true });
  await page.getByRole("menuitem", { name: /Home/ }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  const trigger = page.getByRole("button", { name: "New session" });
  await expect(trigger).toHaveAttribute("aria-disabled", "true");
  await expect(trigger.locator("..")).toHaveAttribute(
    "title",
    "This workspace is full. Remove a pane before adding another session.",
  );
  expect(store.sessions).toHaveLength(0);
});
