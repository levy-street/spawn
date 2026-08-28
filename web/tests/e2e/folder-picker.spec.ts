import { expect, type Page, test } from "@playwright/test";
import { fileEntry, fileListing, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

const listings: Record<string, ReturnType<typeof fileListing>> = {
  "/Users": fileListing({
    path: "/Users",
    parent: "/",
    entries: [
      fileEntry({ name: "shared", path: "/Users/shared", is_dir: true, size: null }),
      fileEntry({ name: "tester", path: "/Users/tester", is_dir: true, size: null }),
    ],
  }),
  "/Users/tester": fileListing({
    path: "/Users/tester",
    parent: "/Users",
    entries: [
      fileEntry({ name: ".config", path: "/Users/tester/.config", is_dir: true, size: null }),
      fileEntry({ name: "projects", path: "/Users/tester/projects", is_dir: true, size: null }),
      fileEntry({ name: "notes.txt", path: "/Users/tester/notes.txt" }),
    ],
  }),
  "/Users/shared": fileListing({ path: "/Users/shared", parent: "/Users", entries: [] }),
  "/Users/tester/projects": fileListing({
    path: "/Users/tester/projects",
    parent: "/Users/tester",
    entries: [
      fileEntry({ name: "spawn", path: "/Users/tester/projects/spawn", is_dir: true, size: null }),
    ],
  }),
  "/Users/tester/projects/spawn": fileListing({
    path: "/Users/tester/projects/spawn",
    parent: "/Users/tester/projects",
    entries: [],
  }),
};

async function openPicker(page: Page) {
  await mockApp(page, {
    workspaces: [workspace()],
    sessions: [],
    files: (_hostId, path) => listings[path ?? ""] ?? listings["/Users/tester"],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  // Desktop entry to the picker. The mobile chrome's session menu is
  // `@md/shell:hidden`, so on this viewport the tab-home chip is the
  // affordance that opens the same folder-picker dialog.
  await page.getByRole("button", { name: /Choose this tab.s folder/ }).click();
  return page.getByRole("dialog", { name: "Select a folder on Mac" });
}

test("dot-folders stay hidden until the options menu turns them on", async ({ page }) => {
  const dialog = await openPicker(page);
  await expect(dialog.getByRole("option", { name: "projects" })).toBeVisible();
  await expect(dialog.getByRole("option", { name: ".config" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Folder list options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show hidden folders" }).click();
  await expect(dialog.getByRole("option", { name: ".config" })).toBeVisible();

  await dialog.getByRole("button", { name: "Folder list options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show hidden folders" }).click();
  await expect(dialog.getByRole("option", { name: ".config" })).toHaveCount(0);
});

test("clicking a folder opens it", async ({ page }) => {
  const dialog = await openPicker(page);
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
});

test("drilling in scrolls the strip so the new column is in frame", async ({ page }) => {
  const dialog = await openPicker(page);
  // The panel frames two columns. The first drill fills the second slot; the
  // second overflows the strip, which must scroll itself — not wait for a
  // drag — to reveal the column that just opened.
  await dialog.getByRole("option", { name: "projects" }).click();
  await dialog.getByRole("option", { name: "spawn" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects/spawn" }),
  ).toBeInViewport({ ratio: 0.9 });
  // The column it came from stays beside it — the trail, not just the leaf.
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects", exact: true }),
  ).toBeInViewport({ ratio: 0.9 });
});

test("arrow keys walk the folders without a click first", async ({ page }) => {
  const dialog = await openPicker(page);
  // The trailing column is focused on open, so the keyboard works straight
  // away: ArrowDown selects the first sibling, opening its column.
  await expect(dialog.getByRole("listbox", { name: "Folders in /Users/tester" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: "projects", selected: true })).toBeVisible();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
});

test("a breadcrumb chevron drills into that folder's subfolders", async ({ page }) => {
  const dialog = await openPicker(page);
  await dialog.getByRole("button", { name: "Browse /Users/tester", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "projects" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
});

test("home is the ceiling: no way up and no crumbs above it", async ({ page }) => {
  const dialog = await openPicker(page);
  // The host is rooted at the home directory, so /Users is not reachable —
  // offering a ".." row or a "Users" crumb here only walks into an error.
  await expect(dialog.getByRole("button", { name: "Parent folder" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Home", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Users", exact: true })).toHaveCount(0);
});

test("a crumb steps back up, and there is none above home", async ({ page }) => {
  const dialog = await openPicker(page);
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();

  // The columns layout replaced the ".." row deliberately (folder-picker.tsx:
  // "stepping back is a glance left rather than a '..' round trip"), so the
  // way back up is the crumb to the left — and home has nothing to its left.
  await dialog.getByRole("button", { name: "Home", exact: true }).click();
  await expect(dialog.getByRole("listbox", { name: "Folders in /Users/tester" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Users", exact: true })).toHaveCount(0);
});
