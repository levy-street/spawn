import { expect, type Page, test } from "@playwright/test";
import { fileEntry, fileListing, HOST_ID, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

/**
 * Where the folder picker's column strip parks itself.
 *
 * The panel is two columns wide, so a trail deeper than that scrolls. Which
 * end it scrolls to is the whole question: opening at a folder you already
 * chose should show that folder *in context* — highlighted in the column it
 * sits in — while drilling into one should reveal what is inside it.
 */

const TREE: Record<string, string[]> = {
  "/Users/tester": ["Desktop", "dev", "Documents"],
  "/Users/tester/Desktop": ["spawn-keys-backup"],
  "/Users/tester/Desktop/spawn-keys-backup": ["inner"],
  "/Users/tester/Desktop/spawn-keys-backup/inner": [],
};

const files = (_hostId: string, path: string | null) => {
  const at = path && TREE[path] ? path : "/Users/tester";
  return fileListing({
    path: at,
    entries: (TREE[at] ?? []).map((name) =>
      fileEntry({ name, path: `${at}/${name}`, is_dir: true, size: null }),
    ),
  });
};

/** How far the strip is scrolled, and how far it could be. */
async function strip(page: Page) {
  return page
    .getByRole("dialog", { name: "Select a folder on Mac" })
    .locator(".overflow-x-auto")
    .last()
    .evaluate((el) => ({ left: el.scrollLeft, max: el.scrollWidth - el.clientWidth }));
}

/**
 * Where the strip comes to rest. The reveal is a smooth scroll started from a
 * `requestAnimationFrame`, so a single "has it changed since last time" read
 * can catch it in the gap before it has begun — hence a run of identical
 * reads, long enough to outlast the animation itself, rather than one.
 */
async function settledStrip(page: Page) {
  let previous = { left: -1, max: -1 };
  let stable = 0;
  await expect
    .poll(
      async () => {
        const next = await strip(page);
        stable = next.left === previous.left && next.max === previous.max ? stable + 1 : 0;
        previous = next;
        return stable;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(5);
  return previous;
}

test("drilling in reveals what is inside the folder", async ({ page }) => {
  await mockApp(page, { workspaces: [workspace()], sessions: [], files });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page
    .getByRole("toolbar", { name: "Add a window" })
    .getByRole("button", { name: "Shell", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await expect(dialog.getByRole("listbox", { name: "Folders in /Users/tester" })).toBeVisible();

  // Two columns fit, so the second one needs no scrolling to be seen.
  await dialog.getByRole("option", { name: "Desktop" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/Desktop" }),
  ).toBeVisible();

  // The third does. Its column is the point of the click, so the strip runs
  // to the end rather than leaving it off the right edge.
  await dialog.getByRole("option", { name: "spawn-keys-backup" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/Desktop/spawn-keys-backup" }),
  ).toBeVisible();
  const deep = await settledStrip(page);
  expect(deep.max).toBeGreaterThan(0);
  expect(deep.left).toBe(deep.max);
});

test("opened at a folder shows it in context, and pressing it reveals", async ({ page }) => {
  await mockApp(page, {
    // A workspace already pointed somewhere three columns deep.
    workspaces: [workspace({ host_id: HOST_ID, cwd: "/Users/tester/Desktop/spawn-keys-backup" })],
    sessions: [],
    files,
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page
    .getByRole("button", { name: /spawn-keys-backup/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/Desktop/spawn-keys-backup" }),
  ).toBeVisible();

  // Where you already are, seen in its own surroundings: the trail is not run
  // to the end, so the folder is on screen highlighted rather than off it.
  const opened = await settledStrip(page);
  expect(opened.max).toBeGreaterThan(0);
  expect(opened.left).toBeLessThan(opened.max);
  await expect(dialog.getByRole("option", { name: "spawn-keys-backup" })).toBeVisible();

  // Pressing it is how you ask to see inside, and it lands nowhere new — so
  // the reveal cannot be driven by the path having changed.
  await dialog.getByRole("option", { name: "spawn-keys-backup" }).click();
  const revealed = await settledStrip(page);
  expect(revealed.left).toBe(revealed.max);
});
