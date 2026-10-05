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

// These are about previews, not views: the hosts page opens in its Tree view,
// where a single click on a file opens it, as it always has.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("spawn.files.view.page", "tree"));
});

/** The card can lie over the right of the list, under the row it is about,
 *  so another row is hovered by its left edge — the part the card never covers. */
const LEFT_EDGE = { position: { x: 40, y: 14 } };

test("hovering a vector file previews the rendered image", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "logo.svg").hover(LEFT_EDGE);
  const card = page.locator("#file-preview-card");
  await expect(card).toBeVisible();
  // A blob URL, not the raw markup: an inline <svg> from an untrusted file
  // would execute any script it carries.
  await expect(card.locator("img")).toHaveAttribute("src", /^blob:/);

  // A folder has nothing to show, so resting on one takes the card away
  // rather than carrying it along.
  await row(page, "assets").hover(LEFT_EDGE);
  await expect(card).toBeHidden();

  // So does the panel's own ground, below the last row.
  await row(page, "logo.svg").hover(LEFT_EDGE);
  await expect(card).toBeVisible();
  const tree = await page.getByRole("tree", { name: "Files" }).boundingBox();
  if (!tree) throw new Error("no tree");
  await page.mouse.move(tree.x + 12, tree.y + tree.height - 8);
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

  // Folders sort first, so the first file sits under "assets" — which the
  // viewer must step over rather than into.
  await row(page, "huge.txt").click();
  const dialog = page.getByRole("dialog");
  // The viewer names the file twice — title bar and footer path — so pin the
  // heading rather than any text match.
  await expect(dialog.getByRole("heading", { name: "huge.txt" })).toBeVisible();
  // First file: there is nothing before it, though a folder is.
  await expect(dialog.getByRole("button", { name: "Previous file" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Next file" }).click();
  await expect(dialog.getByRole("heading", { name: "logo.svg" })).toBeVisible();
  await dialog.getByRole("button", { name: "Next file" }).click();
  await expect(dialog.getByRole("heading", { name: "notes.txt" })).toBeVisible();
  await dialog.getByRole("button", { name: "Previous file" }).click();
  await expect(dialog.getByRole("heading", { name: "logo.svg" })).toBeVisible();
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

test("no card lands on a dialog, and a card that does open sits below every dialog", async ({
  page,
}) => {
  // The pointer comes to rest on a file row as Delete opens its confirm.
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  // Select a file (a click opens it in the tree; Escape closes the viewer
  // and leaves it selected), then rest on another file and press Delete
  // before that one's card is due.
  await row(page, "report.docx").click(LEFT_EDGE);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  const notes = await row(page, "notes.txt").boundingBox();
  if (!notes) throw new Error("no notes.txt row");
  await page.mouse.move(notes.x + LEFT_EDGE.position.x, notes.y + LEFT_EDGE.position.y);
  await page.getByRole("tree", { name: "Files" }).press("Delete");

  const dialog = page.getByRole("dialog", { name: "Delete “report.docx” permanently?" });
  await expect(dialog).toBeVisible();
  // Well past the hover delay.
  await page.waitForTimeout(800);
  const card = page.locator("#file-preview-card");
  await expect(card).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click({ timeout: 2_000 });
  await expect(dialog).toBeHidden();

  // A card that does open sits below the dialog layer (z-50), so a dialog
  // opened later — even one that never announces itself — covers it.
  await row(page, "notes.txt").hover(LEFT_EDGE);
  await expect(card).toBeVisible();
  const z = await card.evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(z).toBeLessThan(50);
});

test("a card due while any dialog is up stays shut, even one that leaves the pointer alone", async ({
  page,
}) => {
  // The live bug: a menu item clicked over a row closes the menu and opens a
  // surface that does not take the pointer (the Send flow's folder picker),
  // so the row under the pointer starts its card and nothing cancels it; the
  // card used to land over that surface and the dialog after it. Stood in for
  // here by a bare `role="dialog"` that neither announces itself nor covers
  // the list, opened as the pointer comes to rest.
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  const notes = await row(page, "notes.txt").boundingBox();
  if (!notes) throw new Error("no notes.txt row");
  const at = { x: notes.x + LEFT_EDGE.position.x, y: notes.y + LEFT_EDGE.position.y };
  await page.mouse.move(at.x, at.y);
  await page.evaluate(() => {
    const surface = document.createElement("div");
    surface.id = "stand-in-surface";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", "Another surface");
    document.body.append(surface);
  });
  // Resting, then a nudge within the row: whichever came first, the card
  // opening or the surface, the card is not left up under it.
  await page.waitForTimeout(800);
  await page.mouse.move(at.x + 2, at.y);
  await page.waitForTimeout(400);
  const card = page.locator("#file-preview-card");
  await expect(card).toHaveCount(0);

  // With it gone, the same row previews as usual.
  await page.evaluate(() => document.getElementById("stand-in-surface")?.remove());
  await row(page, "readme.md").hover(LEFT_EDGE);
  await row(page, "notes.txt").hover(LEFT_EDGE);
  await expect(card).toBeVisible();
});

test("no card opens while a menu is open", async ({ page }) => {
  await mockApp(page, { files: previewFiles, fileRead: fileBytes });
  await page.goto(`/hosts/${HOST_ID}/files`);

  await row(page, "logo.svg").hover(LEFT_EDGE);
  await row(page, "logo.svg").getByRole("button", { name: "logo.svg actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  // Wandering onto another file while the menu is up previews nothing.
  await row(page, "readme.md").hover(LEFT_EDGE);
  await page.waitForTimeout(800);
  await expect(page.locator("#file-preview-card")).toHaveCount(0);
  await expect(menu).toBeVisible();

  // With the menu gone, the same row previews as usual.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await row(page, "notes.txt").hover(LEFT_EDGE);
  await row(page, "readme.md").hover(LEFT_EDGE);
  await expect(page.locator("#file-preview-card")).toBeVisible();
});
