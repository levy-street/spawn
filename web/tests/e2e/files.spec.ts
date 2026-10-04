import { expect, type Page, test } from "@playwright/test";
import { fileEntry, fileListing, HOST_ID, host, mockApp, session, windowsHost } from "./app-mocks";

const OTHER_HOST_ID = "00000000-0000-4000-8000-000000000009";
const otherHost = {
  ...host,
  id: OTHER_HOST_ID,
  name: "Linux box",
  home_dir: "/home/tester",
};

/** Home has projects/ + notes.txt; projects/ has spawn/ + readme.md. */
function treeFiles(_hostId: string, path: string | null) {
  if (path === "/Users/tester/projects") {
    return fileListing({
      path: "/Users/tester/projects",
      parent: "/Users/tester",
      entries: [
        fileEntry({
          name: "spawn",
          path: "/Users/tester/projects/spawn",
          is_dir: true,
          size: null,
        }),
        fileEntry({ name: "readme.md", path: "/Users/tester/projects/readme.md", size: 512 }),
      ],
    });
  }
  if (path === "/Users/tester/projects/spawn") {
    return fileListing({
      path: "/Users/tester/projects/spawn",
      parent: "/Users/tester/projects",
      entries: [fileEntry({ name: "main.rs", path: "/Users/tester/projects/spawn/main.rs" })],
    });
  }
  return fileListing();
}

/** What the host says a path in `treeFiles` is: a file has an extension. */
function treeStat(_hostId: string, path: string) {
  const name = path.split("/").at(-1) ?? path;
  const file = name.includes(".");
  return { path, name, kind: file ? "file" : "directory", size: file ? 2 : null };
}

function home(entries: Array<Record<string, unknown>>) {
  return fileListing({
    entries: entries.map((entry) =>
      fileEntry({ path: `/Users/tester/${String(entry.name)}`, ...entry }),
    ),
  });
}

/** A Details row by its name. */
function item(page: Page, name: string) {
  return page
    .getByRole("grid", { name: "Files" })
    .getByRole("row")
    .filter({ hasText: name })
    .first();
}

/** A tree item by its name. */
function row(page: Page, name: string) {
  return page.getByRole("treeitem").filter({ hasText: name }).first();
}

/** The names in the Details view, top to bottom (header excluded). */
async function names(page: Page) {
  return page
    .getByRole("grid", { name: "Files" })
    .locator("[role='row'][data-path]")
    .evaluateAll((rows) =>
      rows
        .sort(
          (a, b) =>
            Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex")),
        )
        .map((row) => row.querySelector("[role='gridcell'] span")?.textContent ?? ""),
    );
}

/** A Details column header, by the label on its sort button. */
function header(page: Page, label: string) {
  return page
    .getByRole("columnheader")
    .filter({ has: page.getByRole("button", { name: label, exact: true }) });
}

async function openNewMenu(page: Page, item: "New folder" | "New file" | "Upload files…") {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("a host's files open in Details: folders first, natural order, hidden files hidden", async ({
  page,
}) => {
  await mockApp(page, {
    files: () =>
      home([
        { name: "file10.txt", size: 300, modified_at: 1_700_000_300 },
        { name: "src", is_dir: true, size: null },
        { name: "file2.txt", size: 100, modified_at: 1_700_000_500 },
        { name: "Docs", is_dir: true, size: null },
        { name: ".env", size: 10 },
      ]),
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "file10.txt")).toBeVisible();
  await expect.poll(() => names(page)).toEqual(["Docs", "src", "file2.txt", "file10.txt"]);
  // What is shown, and what the hidden toggle keeps back — as the phone counts.
  await expect(page.getByRole("status").filter({ hasText: "4 items · 1 hidden" })).toBeVisible();

  // A column header sorts, and says so; sizes lead with the largest.
  await header(page, "Size").getByRole("button").click();
  await expect(header(page, "Size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => names(page)).toEqual(["Docs", "src", "file10.txt", "file2.txt"]);

  // Name again, twice: reversed, folders still on top.
  await header(page, "Name").getByRole("button").click();
  await header(page, "Name").getByRole("button").click();
  await expect(header(page, "Name")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => names(page)).toEqual(["src", "Docs", "file10.txt", "file2.txt"]);

  // Hidden files show on request, and the choice outlives a reload.
  await page.getByRole("button", { name: "Show hidden files" }).click();
  await expect(item(page, ".env")).toBeVisible();
  await page.reload();
  await expect(item(page, ".env")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide hidden files" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Tree view lazily expands directories in place", async ({ page }) => {
  await mockApp(page, { files: treeFiles });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await page.getByRole("button", { name: "Tree view" }).click();
  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree.getByRole("treeitem")).toHaveCount(2);

  // Single click expands a folder in place (VS Code style) — children render
  // indented under it, no navigation.
  await row(page, "projects").click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  await expect(row(page, "projects")).toHaveAttribute("aria-expanded", "true");

  await row(page, "spawn").click();
  await expect(tree.getByRole("treeitem")).toHaveCount(5);
  await expect(tree.getByRole("treeitem").filter({ hasText: "main.rs" })).toBeVisible();

  // Collapse all folds everything back to the root listing.
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(tree.getByRole("treeitem")).toHaveCount(2);
});

test("?path deep link to a file opens its folder with it selected", async ({ page }) => {
  await mockApp(page, { files: treeFiles, fileStat: treeStat });

  await page.goto(
    `/hosts/${HOST_ID}/files?path=${encodeURIComponent("/Users/tester/projects/spawn/main.rs")}`,
  );

  await expect(item(page, "main.rs")).toHaveAttribute("aria-selected", "true");
  const crumbs = page.getByRole("navigation", { name: "Folder path" });
  await expect(crumbs.getByRole("button", { name: "spawn" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(crumbs.getByRole("button", { name: "projects" })).toBeVisible();

  // The link is read once and dropped from the address; the tab keeps the
  // folder, so a reload still comes back to it.
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  await page.reload();
  await expect(crumbs.getByRole("button", { name: "spawn" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(item(page, "main.rs")).toBeVisible();
});

test("the folder on screen never goes into the address or a request", async ({ page }) => {
  await mockApp(page, { files: treeFiles, fileStat: treeStat });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(decodeURIComponent(request.url())));

  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "projects").dblclick();
  await expect(item(page, "readme.md")).toBeVisible();
  await item(page, "spawn").dblclick();
  await expect(item(page, "main.rs")).toBeVisible();

  // A host path is protected content: not in the URL, so not in a server log,
  // an RSC request, a prefetch, the browser's history or a Referer.
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  expect(requested.filter((url) => url.includes("/Users/tester"))).toEqual([]);
  expect(await page.evaluate(() => window.location.hash)).toBe("");

  // Kept with the tab instead: a reload, or Back to the page, returns to it.
  await page.reload();
  await expect(item(page, "main.rs")).toBeVisible();
  // Even when the router has since rewritten the entry's state without it
  // (it does on some of its own updates), as a dev refresh would.
  await page.evaluate(() => {
    const { __NA, __PRIVATE_NEXTJS_INTERNALS_TREE } = window.history.state ?? {};
    window.history.replaceState({ __NA, __PRIVATE_NEXTJS_INTERNALS_TREE }, "");
  });
  await page.goto(`/hosts/${HOST_ID}`);
  await page.goBack();
  await expect(item(page, "main.rs")).toBeVisible();
  expect(requested.filter((url) => url.includes("/Users/tester"))).toEqual([]);
});

test("upload goes into the folder on screen", async ({ page }) => {
  let uploadedDir: string | null = null;
  await mockApp(page, {
    files: treeFiles,
    fileUpload: async (_hostId, route) => {
      uploadedDir =
        /name="dir"\r\n\r\n([^\r]+)/.exec(route.request().postData() ?? "")?.[1] ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/Users/tester/report.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "notes.txt")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await openNewMenu(page, "Upload files…");
  await (await chooser).setFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });

  await expect.poll(() => uploadedDir).toBe("/Users/tester");
  await expect(page.getByText("Uploaded /Users/tester/report.txt")).toBeVisible();
});

test("new folder, new file, rename and delete round-trip", async ({ page }) => {
  const mkdirs: unknown[] = [];
  const writes: unknown[] = [];
  const renames: unknown[] = [];
  const deletes: unknown[] = [];
  await mockApp(page, {
    files: treeFiles,
    fileMkdir: async (_h, body, route) => {
      mkdirs.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: (body as { path: string }).path },
      });
    },
    fileUpload: async (_h, route) => {
      const declaration = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(declaration);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: `${String(declaration.dir)}/${String(declaration.name)}` },
      });
    },
    fileRename: async (_h, body, route) => {
      renames.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/Users/tester/renamed.txt" },
      });
    },
    fileDelete: async (_h, body, route) => {
      deletes.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: (body as { path: string }).path },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "notes.txt")).toBeVisible();

  // New folder: an inline name field in the folder on screen.
  await openNewMenu(page, "New folder");
  await page.getByLabel("Folder name").fill("scratch");
  await page.getByLabel("Folder name").press("Enter");
  await expect.poll(() => mkdirs.at(-1)).toMatchObject({ path: "/Users/tester/scratch" });

  // New file: an empty write that refuses to replace anything.
  await openNewMenu(page, "New file");
  await page.getByLabel("File name").fill("todo.md");
  await page.getByLabel("File name").press("Enter");
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({ dir: "/Users/tester", name: "todo.md", length: 0, overwrite: false });

  // Rename from the row's menu, inline.
  const notes = item(page, "notes.txt");
  await notes.hover();
  await notes.getByRole("button", { name: "notes.txt actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameInput = page.getByLabel("Rename entry");
  await renameInput.fill("renamed.txt");
  await renameInput.press("Enter");
  await expect
    .poll(() => renames.at(-1))
    .toMatchObject({ path: "/Users/tester/notes.txt", name: "renamed.txt" });

  // Delete asks first, naming what goes and that it is permanent.
  await item(page, "projects").dblclick();
  const target = item(page, "readme.md");
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete permanently…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete “readme.md” permanently?" });
  await expect(dialog).toContainText("It won't go to the Trash on Mac. This can't be undone.");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect
    .poll(() => deletes.at(-1))
    .toMatchObject({ path: "/Users/tester/projects/readme.md", recursive: false });
  await expect(
    page.getByRole("status").filter({ hasText: "Deleted “readme.md” on Mac" }),
  ).toBeVisible();
});

test("several rows are picked with the platform's keys and deleted together", async ({ page }) => {
  const deletes: string[] = [];
  await mockApp(page, {
    files: () => home([{ name: "a.txt" }, { name: "b.txt" }, { name: "c.txt" }, { name: "d.txt" }]),
    fileDelete: async (_h, body, route) => {
      deletes.push((body as { path: string }).path);
      await route.fulfill({ status: 200, json: { path: (body as { path: string }).path } });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "a.txt").click();
  await item(page, "c.txt").click({ modifiers: ["Shift"] });
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await expect(item(page, name)).toHaveAttribute("aria-selected", "true");
  }
  // Ctrl-click (this is not a Mac) toggles one out and another in.
  await item(page, "b.txt").click({ modifiers: ["Control"] });
  await item(page, "d.txt").click({ modifiers: ["Control"] });
  await expect(item(page, "b.txt")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("status").filter({ hasText: "3 selected" })).toBeVisible();

  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete 3 items permanently?" });
  await expect(dialog).toContainText("They won't go to the Trash on Mac.");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect
    .poll(() => [...deletes].sort())
    .toEqual(["/Users/tester/a.txt", "/Users/tester/c.txt", "/Users/tester/d.txt"]);
});

test("in the tree, deleting a folder with things inside it picked asks for the folder alone", async ({
  page,
}) => {
  const deletes: string[] = [];
  await mockApp(page, {
    files: treeFiles,
    fileDelete: async (_h, body, route) => {
      deletes.push((body as { path: string }).path);
      await route.fulfill({ status: 200, json: { path: (body as { path: string }).path } });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await page.getByRole("button", { name: "Tree view" }).click();
  await row(page, "projects").click();
  await expect(row(page, "readme.md")).toBeVisible();
  await row(page, "readme.md").click({ modifiers: ["Control"] });
  await row(page, "notes.txt").click({ modifiers: ["Control"] });
  await expect(page.getByRole("status").filter({ hasText: "3 selected" })).toBeVisible();

  await page.keyboard.press("Delete");
  // readme.md goes with projects: two things are removed, not three.
  const dialog = page.getByRole("dialog", { name: "Delete 2 items permanently?" });
  await expect(dialog).toContainText(
    "They won't go to the Trash on Mac. Folders go with everything inside them. This can't be undone.",
  );
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Deleted 2 items on Mac" }),
  ).toBeVisible();
  expect([...deletes].sort()).toEqual(["/Users/tester/notes.txt", "/Users/tester/projects"]);
});

test("Windows file operations preserve native drive paths", async ({ page }) => {
  const listed: Array<string | null> = [];
  const mkdirs: unknown[] = [];
  const renames: unknown[] = [];
  const deletes: unknown[] = [];
  await mockApp(page, {
    hosts: [windowsHost],
    files: (_hostId, path) => {
      listed.push(path);
      if (path === "C:\\Users\\tester\\Work") {
        return fileListing({
          path,
          home_dir: "C:\\Users\\tester",
          parent: "C:\\Users\\tester",
          entries: [fileEntry({ name: "readme.md", path: `${path}\\readme.md`, size: 512 })],
        });
      }
      return fileListing({
        path: "C:\\Users\\tester",
        home_dir: "C:\\Users\\tester",
        parent: "C:\\Users",
        entries: [
          fileEntry({
            name: "Work",
            path: "C:\\Users\\tester\\Work",
            is_dir: true,
            size: null,
          }),
          fileEntry({ name: "notes.txt", path: "C:\\Users\\tester\\notes.txt" }),
        ],
      });
    },
    fileMkdir: async (_hostId, body, route) => {
      mkdirs.push(body);
      await route.fulfill({ status: 200, json: body });
    },
    fileRename: async (_hostId, body, route) => {
      renames.push(body);
      await route.fulfill({ status: 200, json: body });
    },
    fileDelete: async (_hostId, body, route) => {
      deletes.push(body);
      await route.fulfill({ status: 200, json: body });
    },
  });

  const deepPath = "C:\\Users\\tester\\Work\\readme.md";
  await page.goto(`/hosts/${HOST_ID}/files?path=${encodeURIComponent(deepPath)}`);
  await expect(item(page, "readme.md")).toHaveAttribute("aria-selected", "true");

  await openNewMenu(page, "New folder");
  await page.getByLabel("Folder name").fill("scratch");
  await page.getByLabel("Folder name").press("Enter");
  await expect
    .poll(() => mkdirs.at(-1))
    .toMatchObject({ path: "C:\\Users\\tester\\Work\\scratch" });

  await item(page, "readme.md").click();
  await page.keyboard.press("Delete");
  await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => deletes.at(-1)).toMatchObject({ path: deepPath, recursive: false });

  // Up lands in home with the folder it came out of selected.
  await page.getByRole("button", { name: "Enclosing folder" }).click();
  await expect(item(page, "Work")).toHaveAttribute("aria-selected", "true");
  await item(page, "notes.txt").click();
  await page.keyboard.press("F2");
  await page.getByLabel("Rename entry").fill("renamed.txt");
  await page.getByLabel("Rename entry").press("Enter");
  await expect
    .poll(() => renames.at(-1))
    .toMatchObject({ path: "C:\\Users\\tester\\notes.txt", name: "renamed.txt" });

  expect(listed).toContain("C:\\Users\\tester\\Work");
  expect(listed.some((path) => path?.startsWith("/C:"))).toBe(false);
});

test("right-click opens a context menu with download and send to host", async ({ page }) => {
  const reads: Array<{ hostId: string; path: string }> = [];
  const uploads: Array<{ hostId: string; dir: string | null }> = [];
  await mockApp(page, {
    hosts: [host, otherHost],
    files: treeFiles,
    fileRead: (hostId, path) => {
      reads.push({ hostId, path });
      return "hi";
    },
    fileUpload: async (hostId, route) => {
      const dir = route
        .request()
        .postData()
        ?.match(/name="dir"\r\n\r\n([^\r]*)/)?.[1];
      uploads.push({ hostId, dir: dir ?? null });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/home/tester/notes.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  const notes = item(page, "notes.txt");
  await notes.click({ button: "right" });

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("notes.txt");
  await expect
    .poll(() => reads.at(-1))
    .toEqual({ hostId: HOST_ID, path: "/Users/tester/notes.txt" });

  await notes.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Linux box" }).click();
  await expect
    .poll(() => reads.at(-1))
    .toEqual({ hostId: HOST_ID, path: "/Users/tester/notes.txt" });
  await expect.poll(() => uploads.at(-1)).toEqual({ hostId: OTHER_HOST_ID, dir: "/home/tester" });
});

test("keyboard: arrows move, Enter opens, Backspace goes back up, F2 renames", async ({ page }) => {
  const renames: unknown[] = [];
  await mockApp(page, {
    files: treeFiles,
    fileRename: async (_h, body, route) => {
      renames.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/Users/tester/kb.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "projects").click();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "notes.txt")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");

  // Enter opens the folder (this is not a Mac); the address stays the page's.
  await page.keyboard.press("Enter");
  await expect(item(page, "readme.md")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  await page.keyboard.press("Backspace");
  await expect(item(page, "projects")).toHaveAttribute("aria-selected", "true");

  // Back and Forward walk the trail.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(item(page, "readme.md")).toBeVisible();
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(item(page, "notes.txt")).toBeVisible();

  // Type-ahead jumps to a name; F2 renames it.
  await item(page, "projects").click();
  await page.keyboard.type("no");
  await expect(item(page, "notes.txt")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("F2");
  const renameInput = page.getByLabel("Rename entry");
  await renameInput.fill("kb.txt");
  await renameInput.press("Enter");
  await expect
    .poll(() => renames.at(-1))
    .toMatchObject({ path: "/Users/tester/notes.txt", name: "kb.txt" });
});

test("filter as you type narrows the folder and Escape clears it", async ({ page }) => {
  await mockApp(page, {
    files: () =>
      home([
        { name: "README.md" },
        { name: "notes-readme.txt" },
        { name: "src", is_dir: true },
        { name: ".readme-old" },
        { name: ".zshrc" },
      ]),
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(page.getByRole("status").filter({ hasText: "3 items · 2 hidden" })).toBeVisible();
  const filter = page.getByRole("searchbox", { name: "Filter this folder" });
  await filter.fill("readme");
  await expect.poll(() => names(page)).toEqual(["notes-readme.txt", "README.md"]);
  // The count is of the matches, and of the hidden files that match.
  await expect(page.getByRole("status").filter({ hasText: "2 items · 1 hidden" })).toBeVisible();
  await filter.fill("nothing-like-it");
  await expect(page.getByText("Nothing in this folder matches “nothing-like-it”.")).toBeVisible();
  await filter.fill("zsh");
  await expect(
    page.getByText("Nothing in this folder matches “zsh”. 1 hidden file matches."),
  ).toBeVisible();
  await filter.press("Escape");
  await expect(item(page, "src")).toBeVisible();
});

test("a folder of only hidden files says so, with the way to show them", async ({ page }) => {
  await mockApp(page, { files: () => home([{ name: ".env" }, { name: ".git", is_dir: true }]) });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(page.getByText("This folder has only hidden files (2).")).toBeVisible();
  await page.getByRole("button", { name: "Show hidden files" }).first().click();
  await expect(item(page, ".env")).toBeVisible();
});

test("Go to folder takes ~ paths and says why it cannot go somewhere", async ({ page }) => {
  await mockApp(page, {
    files: (_hostId, path) => {
      if (path === "/Users/tester/missing") throw new Error("host_error:not_found");
      return treeFiles(_hostId, path);
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "notes.txt")).toBeVisible();

  await page.getByRole("button", { name: "Go to folder" }).click();
  const field = page.getByRole("textbox", { name: "Go to folder" });
  await expect(field).toHaveValue("~");
  await field.fill("~/projects");
  await field.press("Enter");
  await expect(item(page, "readme.md")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));

  // A relative path is from the folder on screen, as in a shell.
  await page.getByRole("button", { name: "Go to folder" }).click();
  await field.fill("spawn");
  await field.press("Enter");
  await expect(item(page, "main.rs")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(item(page, "readme.md")).toBeVisible();

  await page.getByRole("button", { name: "Go to folder" }).click();
  await field.fill("/etc");
  await field.press("Enter");
  await expect(field).toHaveAccessibleDescription(
    "SPAWN D only opens folders inside your home folder on Mac.",
  );
  await field.fill("~/missing");
  await field.press("Enter");
  await expect(field).toHaveAccessibleDescription("There's no folder at that path on Mac.");
  await field.press("Escape");
  await expect(item(page, "readme.md")).toBeVisible();
});

test("a folder past the host's 1,024 cap is drained, virtualized, and honest about it", async ({
  page,
}) => {
  const cursors: number[] = [];
  const all = Array.from({ length: 1_500 }, (_, i) =>
    fileEntry({ name: `f${String(i).padStart(4, "0")}.txt`, path: `/Users/tester/big/f${i}` }),
  );
  await mockApp(page, {
    fileStat: (_hostId, path) => ({ path, name: "big", kind: "directory", size: null }),
    files: (_hostId, path, cursor) => {
      if (path !== "/Users/tester/big") {
        return home([{ name: "big", is_dir: true, size: null }]);
      }
      cursors.push(cursor);
      const end = Math.min(cursor + 96, 1_024);
      return fileListing({
        path,
        entries: all.slice(cursor, end),
        next_cursor: end < 1_024 ? end : null,
        truncated: end === 1_024,
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files?path=${encodeURIComponent("/Users/tester/big")}`);
  await expect(page.getByRole("note")).toHaveText(
    "This folder has more than 1,024 items. SPAWN D on Mac can only list the first 1,024 it finds, so sorting and filtering cover just those.",
  );
  expect(cursors.slice(0, 11)).toEqual([0, 96, 192, 288, 384, 480, 576, 672, 768, 864, 960]);
  await expect(page.getByRole("status").filter({ hasText: "1,024 items" })).toBeVisible();

  // Only the rows near the viewport are in the page.
  const grid = page.getByRole("grid", { name: "Files" });
  const rendered = await grid.locator("[role='row'][data-path]").count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(120);

  // End jumps to the last row, which scrolls into view.
  await item(page, "f0000.txt").click();
  await page.keyboard.press("End");
  await expect(item(page, "f1023.txt")).toBeVisible();
  await expect(item(page, "f1023.txt")).toHaveAttribute("aria-selected", "true");
});

/** A 300-entry home, served a page at a time the way a v1 host does. */
function bigHome(all: Array<Record<string, unknown>>) {
  return (_hostId: string, path: string | null, cursor: number) => {
    if (path !== "/Users/tester") return fileListing({ path, entries: [] });
    const end = Math.min(cursor + 96, all.length);
    return fileListing({
      entries: all.slice(cursor, end),
      next_cursor: end < all.length ? end : null,
    });
  };
}

test("New folder far down a long folder opens in view, and a refused name is said there", async ({
  page,
}) => {
  const mkdirs: string[] = [];
  const all = Array.from({ length: 300 }, (_, i) =>
    fileEntry({ name: `f${String(i).padStart(3, "0")}.txt`, path: `/Users/tester/f${i}.txt` }),
  );
  await mockApp(page, {
    files: bigHome(all),
    fileMkdir: async (_h, body, route) => {
      const path = (body as { path: string }).path;
      mkdirs.push(path);
      if (path.endsWith("/taken")) throw new Error("host_error:already_exists");
      await route.fulfill({ status: 200, json: { path } });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "f000.txt").click();
  await page.keyboard.press("End");
  await expect(item(page, "f299.txt")).toBeVisible();
  await expect(item(page, "f000.txt")).toHaveCount(0);

  await openNewMenu(page, "New folder");
  const field = page.getByLabel("Folder name");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();

  // The host refuses: the reason is right under the name, which stays to fix.
  await field.fill("taken");
  await field.press("Enter");
  await expect(field).toHaveAccessibleDescription("There's already an item named “taken” here.");
  await expect(field).toBeFocused();
  await field.fill("scratch");
  await expect(page.getByRole("alert").filter({ hasText: "already an item" })).toHaveCount(0);
  await field.press("Enter");
  await expect.poll(() => mkdirs).toEqual(["/Users/tester/taken", "/Users/tester/scratch"]);
  await expect(field).toHaveCount(0);

  // The list still answers the keyboard.
  await page.keyboard.press("Home");
  await expect(item(page, "f000.txt")).toBeVisible();
});

test("another folder opens at its top, not where the last one was scrolled", async ({ page }) => {
  const homeFiles = [
    fileEntry({ name: "sub", path: "/Users/tester/sub", is_dir: true, size: null }),
    ...Array.from({ length: 300 }, (_, i) =>
      fileEntry({ name: `f${String(i).padStart(3, "0")}.txt`, path: `/Users/tester/f${i}.txt` }),
    ),
  ];
  const subFiles = Array.from({ length: 300 }, (_, i) =>
    fileEntry({ name: `g${String(i).padStart(3, "0")}.txt`, path: `/Users/tester/sub/g${i}.txt` }),
  );
  await mockApp(page, {
    files: (_hostId, path, cursor) => {
      const sub = path === "/Users/tester/sub";
      const all = sub ? subFiles : homeFiles;
      const end = Math.min(cursor + 96, all.length);
      return fileListing({
        path: sub ? path : "/Users/tester",
        entries: all.slice(cursor, end),
        next_cursor: end < all.length ? end : null,
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "sub").click();
  await page.keyboard.press("End");
  await expect(item(page, "f299.txt")).toBeVisible();

  await page.getByRole("button", { name: "Go to folder" }).click();
  await page.getByRole("textbox", { name: "Go to folder" }).fill("sub");
  await page.getByRole("textbox", { name: "Go to folder" }).press("Enter");
  await expect(item(page, "g000.txt")).toBeInViewport();
});

test("a folder bigger than a page that changed on the host says so instead of keeping ghosts", async ({
  page,
}) => {
  const all = Array.from({ length: 200 }, (_, i) =>
    fileEntry({ name: `f${String(i).padStart(3, "0")}.txt`, path: `/Users/tester/f${i}.txt` }),
  );
  await page.clock.install();
  await mockApp(page, { files: bigHome(all) });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "f000.txt")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "200 items" })).toBeVisible();
  // Not kept current on a timer, so it does not claim to be.
  await expect(page.getByText("Refreshes every few seconds")).toHaveCount(0);

  // f000 is deleted on the host; the next look at page one notices.
  all.splice(0, 1);
  await page.clock.fastForward(11_000);
  const notice = page.getByRole("status").filter({ hasText: "This folder changed on Mac." });
  await expect(notice).toBeVisible();

  await notice.getByRole("button", { name: "Refresh" }).click();
  await expect(notice).toHaveCount(0);
  await expect(item(page, "f000.txt")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "199 items" })).toBeVisible();
});

test("a folder that fits on one page is kept current, and says so", async ({ page }) => {
  const entries = [{ name: "a.txt" }, { name: "b.txt" }];
  await page.clock.install();
  await mockApp(page, { files: () => home(entries) });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "b.txt")).toBeVisible();
  await expect(page.getByText("Refreshes every few seconds")).toBeVisible();
  entries.splice(1, 1);
  await page.clock.fastForward(11_000);
  await expect(item(page, "b.txt")).toHaveCount(0);
  await expect(page.getByText("This folder changed on Mac.")).toHaveCount(0);
});

test("session page toggles an inline files panel rooted at the cwd", async ({ page }) => {
  let requestedPath: string | null = null;
  await mockApp(page, {
    sessions: [session()],
    fileStat: treeStat,
    files: (_hostId, path) => {
      requestedPath = path;
      return fileListing({
        path: "/Users/tester/projects/spawn",
        parent: "/Users/tester/projects",
        entries: [fileEntry({ name: "main.rs", path: "/Users/tester/projects/spawn/main.rs" })],
      });
    },
  });

  await page.goto(`/sessions/${session().id}`);
  await page.getByRole("button", { name: "Toggle files", exact: true }).click();

  const panel = page.getByRole("complementary", { name: "Files for palette" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("treeitem").filter({ hasText: "main.rs" })).toBeVisible();
  await expect.poll(() => requestedPath).toBe("/Users/tester/projects/spawn");

  await page.getByRole("button", { name: "Toggle files", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle files", exact: true }).click();
  await expect(panel).toBeVisible();

  // Its menu reaches the full browser at the same folder — handed over in
  // memory, so the folder is in no link, prefetch or address.
  await panel.getByRole("button", { name: "File actions" }).click();
  const open = page.getByRole("menuitem", { name: "Open in full browser" });
  await expect(open).not.toHaveAttribute("href", /.*/);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  await expect(
    page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "spawn" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(item(page, "main.rs")).toBeVisible();
});

test("a file explorer is added to the workspace as its own pane", async ({ page }) => {
  const requested: Array<string | null> = [];
  const { SESSION_B_ID, WORKSPACE_ID, workspace } = await import("./app-mocks");
  await mockApp(page, {
    sessions: [session(), session({ id: SESSION_B_ID, name: "beta", cwd: "/Users/tester/beta" })],
    workspaces: [
      workspace({
        layout: {
          version: 3,
          tiles: [
            { session_id: session().id, x: 0, y: 0, w: 12, h: 24 },
            { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
          ],
        },
      }),
    ],
    files: (_hostId, path) => {
      requested.push(path);
      return fileListing({ path: path ?? "/Users/tester", entries: [fileEntry()] });
    },
  });

  await page.goto(`/w/${WORKSPACE_ID}`);
  // A file explorer is a pane like any other, added from the floating
  // launcher — and like any other, it asks where, the focused pane's folder first.
  await page.getByRole("button", { name: "Add a window" }).hover();
  await page.getByRole("button", { name: "New file explorer window" }).click();
  const first = page.getByRole("menu", { name: "Where?" }).getByRole("menuitem").first();
  await expect(first).toContainText("~/projects/spawn");
  await first.click();

  const pane = page.getByRole("region", { name: /^Files — / });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("tree", { name: "Files" })).toBeVisible();
  await expect.poll(() => requested.length).toBeGreaterThan(0);

  // Its own ground offers what the pane's header does not.
  await pane
    .getByRole("tree", { name: "Files" })
    .click({ button: "right", position: { x: 40, y: 200 } });
  await expect(page.getByRole("menuitemcheckbox", { name: "Show hidden files" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New file" })).toBeVisible();
});

/** Enough shapes that a rendered view is unmistakably not the source. */
const README = `# SPAWN D

A **bold** claim and some _emphasis_.

- one thing
- another thing

## Getting started

Run \`spawnd login\` and follow the prompts.
`;

/** A file explorer pane filling the window, holding a README to hover. */
async function openWideExplorer(page: Page) {
  const { WORKSPACE_ID, workspace } = await import("./app-mocks");
  await page.setViewportSize({ width: 1160, height: 900 });
  await mockApp(page, {
    // A window that ran in the folder: the likeliest place for the explorer.
    sessions: [session({ cwd: "/Users/tester/spawn" })],
    workspaces: [workspace()],
    files: (_hostId, path) =>
      fileListing({
        path: path ?? "/Users/tester/spawn",
        entries: [
          fileEntry({ name: "infra", path: "/Users/tester/spawn/infra", is_dir: true, size: null }),
          fileEntry({ name: "README.md", path: "/Users/tester/spawn/README.md", size: 240 }),
        ],
      }),
    fileRead: () => README,
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "Add a window" }).hover();
  await page.getByRole("button", { name: "New file explorer window" }).click();
  await page.getByRole("menu", { name: "Where?" }).getByRole("menuitem").first().click();
  const pane = page.getByRole("region", { name: /^Files — / });
  await expect(pane.getByRole("tree", { name: "Files" })).toBeVisible();
  await pane.getByRole("treeitem").filter({ hasText: "README.md" }).hover();
  await expect(page.locator("#file-preview-card")).toBeVisible();
  return pane;
}

test("a full-width explorer keeps its hover preview over itself, clear of the tree", async ({
  page,
}) => {
  const pane = await openWideExplorer(page);
  const card = page.locator("#file-preview-card");

  const paneBox = (await pane.boundingBox()) ?? null;
  const cardBox = (await card.boundingBox()) ?? null;
  if (!paneBox || !cardBox) throw new Error("no boxes");

  // Over its own panel, not flipped across the window onto the sidebar.
  expect(cardBox.x).toBeGreaterThan(paneBox.x);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  // And far enough in that the rows it is about are still readable beside it.
  expect(cardBox.x - paneBox.x).toBeGreaterThanOrEqual(200);
  await expect(pane.getByRole("treeitem").filter({ hasText: "infra" })).toBeVisible();
});

test("the hover preview renders markdown, the way the viewer does", async ({ page }) => {
  await openWideExplorer(page);
  const card = page.locator("#file-preview-card");
  // Rendered, not shown as source: headings, a list and inline code.
  await expect(card.getByRole("heading", { name: "SPAWN D" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Getting started" })).toBeVisible();
  await expect(card.locator("li")).toHaveCount(2);
  await expect(card.locator("code")).toHaveText("spawnd login");
  await expect(card.locator("strong")).toHaveText("bold");
});
