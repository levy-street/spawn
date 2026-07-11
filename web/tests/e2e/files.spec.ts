import { expect, test } from "@playwright/test";
import { agent, fileEntry, fileListing, HOST_ID, host, mockAuthenticatedApi } from "./app-mocks";

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

function row(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("treeitem").filter({ hasText: name }).first();
}

test("file tree lazily expands directories in place", async ({ page }) => {
  await mockAuthenticatedApi(page, { files: treeFiles });

  await page.goto(`/hosts/${HOST_ID}/files`);
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

test("?path deep link expands ancestors and selects the target", async ({ page }) => {
  await mockAuthenticatedApi(page, { files: treeFiles });

  await page.goto(
    `/hosts/${HOST_ID}/files?path=${encodeURIComponent("/Users/tester/projects/spawn/main.rs")}`,
  );

  const target = page.getByRole("treeitem").filter({ hasText: "main.rs" });
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "projects")).toHaveAttribute("aria-expanded", "true");
});

test("header upload posts multipart into the tree root", async ({ page }) => {
  let uploadedDir: string | null = null;
  await mockAuthenticatedApi(page, {
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
  await expect(row(page, "notes.txt")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload files" }).click();
  await (await chooser).setFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });

  await expect.poll(() => uploadedDir).toBe("/Users/tester");
  await expect(page.getByText("Uploaded /Users/tester/report.txt")).toBeVisible();
});

test("inline new folder, rename, and delete round-trip", async ({ page }) => {
  const mkdirs: unknown[] = [];
  const renames: unknown[] = [];
  const deletes: unknown[] = [];
  await mockAuthenticatedApi(page, {
    files: treeFiles,
    fileMkdir: async (_h, body, route) => {
      mkdirs.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: (body as { path: string }).path },
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
  await expect(row(page, "notes.txt")).toBeVisible();

  // New folder: inline input at the root.
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("scratch");
  await page.getByLabel("Folder name").press("Enter");
  await expect.poll(() => mkdirs.at(-1)).toMatchObject({ path: "/Users/tester/scratch" });

  // Rename via the row menu → inline input.
  const notes = row(page, "notes.txt");
  await notes.hover();
  await notes.getByRole("button", { name: "notes.txt actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameInput = page.getByLabel("Rename entry");
  await renameInput.fill("renamed.txt");
  await renameInput.press("Enter");
  await expect
    .poll(() => renames.at(-1))
    .toMatchObject({ path: "/Users/tester/notes.txt", name: "renamed.txt" });

  // Delete with confirm.
  page.on("dialog", (d) => d.accept());
  const readme = row(page, "projects");
  await readme.click(); // expand
  const target = row(page, "readme.md");
  await target.hover();
  await target.getByRole("button", { name: "readme.md actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect
    .poll(() => deletes.at(-1))
    .toMatchObject({ path: "/Users/tester/projects/readme.md", recursive: false });
});

test("right-click opens a context menu with download and send to host", async ({ page }) => {
  const transfers: unknown[] = [];
  await mockAuthenticatedApi(page, {
    hosts: [host, otherHost],
    files: treeFiles,
    fileTransfer: async (_h, body, route) => {
      transfers.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/home/tester/notes.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  const notes = row(page, "notes.txt");
  await notes.click({ button: "right" });

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("notes.txt");

  await notes.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Linux box" }).click();
  await expect
    .poll(() => transfers.at(-1))
    .toMatchObject({
      path: "/Users/tester/notes.txt",
      dest_host_id: OTHER_HOST_ID,
      dest_dir: "/home/tester",
    });
});

test("keyboard navigation: arrows move selection, F2 renames", async ({ page }) => {
  const renames: unknown[] = [];
  await mockAuthenticatedApi(page, {
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
  await row(page, "projects").click(); // select + expand
  await expect(page.getByRole("treeitem").filter({ hasText: "readme.md" })).toBeVisible();
  const tree = page.getByRole("tree", { name: "Files" });
  await tree.focus();

  await page.keyboard.press("ArrowDown"); // spawn
  await page.keyboard.press("ArrowDown"); // readme.md
  await expect(page.getByRole("treeitem").filter({ hasText: "readme.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("F2");
  const renameInput = page.getByLabel("Rename entry");
  await renameInput.fill("kb.txt");
  await renameInput.press("Enter");
  await expect
    .poll(() => renames.at(-1))
    .toMatchObject({ path: "/Users/tester/projects/readme.md", name: "kb.txt" });
});

test("agent menu links to the host file explorer at the agent cwd", async ({ page }) => {
  await mockAuthenticatedApi(page, { agents: [agent()] });

  await page.goto(`/agents/${agent().id}`);
  await page.getByRole("button", { name: "Agent actions" }).click();

  const item = page.getByRole("menuitem", { name: "Browse files" });
  await expect(item).toHaveAttribute(
    "href",
    `/hosts/${HOST_ID}/files?path=${encodeURIComponent("/Users/tester/projects/spawn")}`,
  );
});

test("agent page toggles an inline files panel rooted at the cwd", async ({ page }) => {
  let requestedPath: string | null = null;
  await mockAuthenticatedApi(page, {
    agents: [agent()],
    files: (_hostId, path) => {
      requestedPath = path;
      return fileListing({
        path: "/Users/tester/projects/spawn",
        parent: "/Users/tester/projects",
        entries: [fileEntry({ name: "main.rs", path: "/Users/tester/projects/spawn/main.rs" })],
      });
    },
  });

  await page.goto(`/agents/${agent().id}`);
  await page.getByRole("button", { name: "Toggle files panel" }).click();

  const panel = page.getByRole("complementary", { name: "Files panel" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("treeitem").filter({ hasText: "main.rs" })).toBeVisible();
  await expect.poll(() => requestedPath).toBe("/Users/tester/projects/spawn");

  await page.getByRole("button", { name: "Toggle files panel" }).click();
  await expect(panel).toHaveCount(0);
});

test("screens page files panel follows the focused pane's agent", async ({ page }) => {
  const requested: Array<string | null> = [];
  const { AGENT_B_ID, SCREEN_ID, screen } = await import("./app-mocks");
  await mockAuthenticatedApi(page, {
    agents: [agent(), agent({ id: AGENT_B_ID, name: "beta", cwd: "/Users/tester/beta" })],
    screens: [screen()],
    files: (_hostId, path) => {
      requested.push(path);
      return fileListing({ path: path ?? "/Users/tester", entries: [fileEntry()] });
    },
  });

  await page.goto(`/screens/${SCREEN_ID}`);
  await page.getByRole("button", { name: "Toggle files panel" }).click();

  const panel = page.getByRole("complementary", { name: "Files panel" });
  await expect(panel).toBeVisible();
  await expect.poll(() => requested.at(0)).toBe("/Users/tester/projects/spawn");

  // Focusing the second pane re-roots the panel at that agent's cwd.
  await page.locator("section[aria-label='beta']").click();
  await expect.poll(() => requested.at(-1)).toBe("/Users/tester/beta");
});
