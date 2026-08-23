import { expect, test } from "@playwright/test";
import { fileEntry, fileListing, HOST_ID, LEGACY_HOST_CAPABILITIES, mockApp } from "./app-mocks";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';
const MARKDOWN = "# Release notes\n\nA paragraph with **bold** text.\n";
const CODE = "const answer = 42; // the answer\n";

/** Home holds one of everything the viewer has to cope with. */
function previewFiles(_hostId: string, path: string | null) {
  // mockApp normalises an absent path to "~" (app-mocks: `payload.path ?? "~"`),
  // so home arrives either as that, as the absolute home dir, or as nothing.
  if (path && path !== "~" && path !== "/Users/tester") return fileListing();
  return fileListing({
    entries: [
      fileEntry({ name: "logo.svg", path: "/Users/tester/logo.svg", size: SVG.length }),
      fileEntry({ name: "notes.txt", path: "/Users/tester/notes.txt", size: CODE.length }),
      fileEntry({ name: "readme.md", path: "/Users/tester/readme.md", size: MARKDOWN.length }),
      fileEntry({ name: "report.docx", path: "/Users/tester/report.docx", size: 4096 }),
      fileEntry({ name: "huge.txt", path: "/Users/tester/huge.txt", size: 40 * 1024 * 1024 }),
      fileEntry({ name: "assets", path: "/Users/tester/assets", is_dir: true, size: null }),
    ],
  });
}

function fileBytes(_hostId: string, path: string) {
  if (path.endsWith("logo.svg")) return SVG;
  if (path.endsWith("readme.md")) return MARKDOWN;
  return CODE;
}

function row(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("treeitem").filter({ hasText: name }).first();
}

test("hovering a vector file previews the rendered image", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "logo.svg").hover();
  const card = page.locator("#file-preview-card");
  await expect(card).toBeVisible();
  // A blob URL, not the raw markup: an inline <svg> from an untrusted file
  // would execute any script it carries.
  await expect(card.locator("img")).toHaveAttribute("src", /^blob:/);

  // Closing is geometric: another row is still inside the live region, so the
  // card only goes once the pointer leaves the panel and the card behind.
  await row(page, "assets").hover();
  await expect(card).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(card).toBeHidden();
});

test("space pins a preview for the selected row and escape closes it", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "notes.txt").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#file-preview-card")).toBeHidden();

  await page.getByRole("tree", { name: "Files" }).press(" ");
  await expect(page.locator("#file-preview-card")).toBeVisible();
  await page.getByRole("tree", { name: "Files" }).press("Escape");
  await expect(page.locator("#file-preview-card")).toBeHidden();
});

test("clicking a file opens the viewer with its contents", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "notes.txt").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("const answer")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("markdown is rendered, not shown as source", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "readme.md").click();
  const dialog = page.getByRole("dialog");
  // A heading element only exists if the markdown was actually parsed.
  await expect(dialog.getByRole("heading", { name: "Release notes" })).toBeVisible();
});

test("next and previous step between files and skip folders", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "logo.svg").click();
  const dialog = page.getByRole("dialog");
  // The viewer names the file twice — title bar and footer path — so pin the
  // heading rather than any text match.
  await expect(dialog.getByRole("heading", { name: "logo.svg" })).toBeVisible();

  await dialog.getByRole("button", { name: "Next file" }).click();
  await expect(dialog.getByRole("heading", { name: "notes.txt" })).toBeVisible();
  await dialog.getByRole("button", { name: "Previous file" }).click();
  await expect(dialog.getByRole("heading", { name: "logo.svg" })).toBeVisible();
  // First file: there is nothing before it.
  await expect(dialog.getByRole("button", { name: "Previous file" })).toBeDisabled();
});

test("a capable host offers reveal and open, and calls them with the right path", async ({
  page,
}) => {
  const revealed: string[] = [];
  const opened: string[] = [];
  await mockApp(page, {
    files: previewFiles,
    fileRead: fileBytes,
    fileReveal: (_hostId, path) => revealed.push(path),
    fileOpen: (_hostId, path) => opened.push(path),
  });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "notes.txt").click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Reveal in Finder" }).click();
  await expect.poll(() => revealed).toEqual(["/Users/tester/notes.txt"]);

  await row(page, "notes.txt").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Open in default program" }).click();
  await expect.poll(() => opened).toEqual(["/Users/tester/notes.txt"]);
});

test("an older daemon simply does not offer the desktop actions", async ({ page }) => {
  // Absent rather than disabled: the gate is the capability list the host
  // advertised, and a greyed-out row invites a question with no good answer.
  await mockApp(page, {
    files: previewFiles,
    fileRead: fileBytes,
    capabilities: LEGACY_HOST_CAPABILITIES,
  });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "notes.txt").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Reveal in Finder" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Open in default program" })).toHaveCount(0);
});

test("a host-rendered document falls back to a metadata card without a renderer", async ({
  page,
}) => {
  await mockApp(page, {
    files: previewFiles,
    fileRead: fileBytes,
    capabilities: LEGACY_HOST_CAPABILITIES,
  });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "report.docx").click();
  const dialog = page.getByRole("dialog");
  // The kind is named in the title bar too; the fallback card's own line is
  // the one that proves the metadata card rendered.
  await expect(dialog.getByRole("paragraph").filter({ hasText: "Word document" })).toBeVisible();
  // The toolbar carries an icon-only Download too; the card's own button is
  // the one with visible text, and it is what the fallback has to offer.
  await expect(dialog.locator("button").filter({ hasText: "Download" })).toBeVisible();
});

test("a file over the budget waits to be asked before streaming", async ({ page }) => {
  let reads = 0;
  await mockApp(page, {
    files: previewFiles,
    fileRead: (hostId, path) => {
      reads += 1;
      return fileBytes(hostId, path);
    },
  });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "huge.txt").click();
  const dialog = page.getByRole("dialog");
  const load = dialog.getByRole("button", { name: "Load preview" });
  await expect(load).toBeVisible();
  // Nothing was pulled just because the file was opened.
  expect(reads).toBe(0);
});
