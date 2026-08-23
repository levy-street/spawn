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
  // The empty state spells the choices out as lozenges; a shell on a workspace
  // with no home of its own still has to answer "where".
  await page
    .getByRole("toolbar", { name: "Add a window" })
    .getByRole("button", { name: "Shell", exact: true })
    .click();
  return store;
}

test("one host skips the host list and browses folders straight away", async ({ page }) => {
  await openEmptyWorkspace(page);
  // A workspace with no home of its own still has to answer "where" — and the
  // folder browser is the only thing that answers it now.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Select a folder on Mac" })).toBeVisible();
});

test("multiple hosts are shown and offline hosts are disabled", async ({ page }) => {
  await openEmptyWorkspace(page, {
    hosts: [host, { ...host, id: OFFLINE_HOST_ID, name: "Old Mac", status: "offline" }],
  });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("Choose a host");
  await expect(menu.getByRole("menuitem", { name: /Old Mac.*offline/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: /^Mac/ }).click();
  await expect(page.getByRole("dialog", { name: "Select a folder on Mac" })).toBeVisible();
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
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  // The first window of an empty tab takes the left half, full height —
  // leaving an opening the grid can offer for a second.
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
    tile: { x: 0, y: 0, w: 12, h: 24 },
  });
});

test("the empty state re-points the tab's folder, and windows follow it", async ({ page }) => {
  const store = await mockApp(page, {
    // A workspace with a home of its own: the tab inherits it until it is
    // given one, and the chip says so either way.
    workspaces: [workspace({ host_id: HOST_ID, cwd: "/Users/tester" })],
    sessions: [],
    files: (_hostId, path) =>
      fileListing({
        path: path === "/Users/tester/projects" ? path : "/Users/tester",
        parent: path === "/Users/tester/projects" ? "/Users/tester" : undefined,
        entries:
          path === "/Users/tester/projects"
            ? []
            : [
                fileEntry({
                  name: "projects",
                  path: "/Users/tester/projects",
                  is_dir: true,
                  size: null,
                }),
              ],
      }),
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  // Inherited from the workspace, shown as the folder windows would open in.
  const chip = page.getByRole("button", { name: /tester/ });
  await expect(chip).toBeVisible();

  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await dialog.getByRole("button", { name: "Select this folder" }).click();

  // The tab now carries its own pair; the workspace's home is left alone.
  await expect
    .poll(() => store.requests.workspacePatches.at(-1)?.body)
    .toMatchObject({
      layout: {
        tabs: [{ id: "tab-1", host_id: HOST_ID, cwd: "/Users/tester/projects" }],
      },
    });

  // And that is where the next window opens.
  await page
    .getByRole("toolbar", { name: "Add a window" })
    .getByRole("button", { name: "Shell", exact: true })
    .click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({ cwd: "/Users/tester/projects" });
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

test("workspace_full disables the lozenges with an explanation", async ({ page }) => {
  // A workspace with a home: one click is the whole flow, so the refusal comes
  // straight back from the create rather than after a folder is picked.
  const store = await openEmptyWorkspace(page, {
    workspaceFull: true,
    workspaces: [workspace({ host_id: HOST_ID, cwd: "~" })],
  });
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  const row = page.getByRole("toolbar", { name: "Add a window" });
  await expect(row.getByRole("button", { name: "Shell", exact: true })).toBeDisabled();
  await expect(row).toHaveAttribute(
    "title",
    "This workspace is full. Remove a window before adding another session.",
  );
  expect(store.sessions).toHaveLength(0);
});
