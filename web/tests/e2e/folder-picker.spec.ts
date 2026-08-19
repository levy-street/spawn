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
};

async function openPicker(page: Page) {
  await mockApp(page, {
    workspaces: [workspace()],
    sessions: [],
    files: (_hostId, path) => listings[path ?? ""] ?? listings["/Users/tester"],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("menuitem", { name: /^Shell/ }).click();
  await page.getByRole("menuitem", { name: "Select folder…" }).click();
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

test("a breadcrumb chevron drills into that folder's subfolders", async ({ page }) => {
  const dialog = await openPicker(page);
  await dialog.getByRole("button", { name: "Browse /Users", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "tester" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "shared" }).click();
  await expect(dialog.getByRole("listbox", { name: "Folders in /Users/shared" })).toBeVisible();
});
