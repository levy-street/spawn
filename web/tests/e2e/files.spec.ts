import { expect, test } from "@playwright/test";
import { agent, fileEntry, fileListing, HOST_ID, host, mockAuthenticatedApi } from "./app-mocks";

const OTHER_HOST_ID = "00000000-0000-4000-8000-000000000009";
const otherHost = {
  ...host,
  id: OTHER_HOST_ID,
  name: "Linux box",
  home_dir: "/home/tester",
};

test("host files page lists directories first with metadata and breadcrumbs", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    files: (_hostId, path) =>
      path === "/Users/tester/projects"
        ? fileListing({
            path: "/Users/tester/projects",
            parent: "/Users/tester",
            entries: [fileEntry({ name: "spawn.md", path: "/Users/tester/projects/spawn.md" })],
          })
        : fileListing(),
  });

  await page.goto(`/hosts/${HOST_ID}/files`);

  await expect(page.getByRole("heading", { name: "Files · Mac" })).toBeVisible();
  const rows = page.locator("section[aria-label='Files'] li");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("projects");
  await expect(rows.nth(1)).toContainText("notes.txt");
  await expect(rows.nth(1)).toContainText("2.0 KB");

  // Directory rows navigate and update the ?path= deep link + breadcrumbs.
  await page.getByRole("button", { name: "projects", exact: true }).click();
  await expect(page).toHaveURL(/path=%2FUsers%2Ftester%2Fprojects/);
  await expect(rows.first()).toContainText("spawn.md");
  const crumbs = page.getByRole("navigation", { name: "Path" });
  await expect(crumbs.getByRole("button", { name: "~" })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "projects" })).toBeVisible();

  // Up button walks to the parent.
  await page.getByRole("button", { name: "Up one level" }).click();
  await expect(rows.nth(1)).toContainText("notes.txt");
});

test("uploads post multipart form data into the current directory", async ({ page }) => {
  let uploadedDir: string | null = null;
  let uploadedName: string | null = null;
  await mockAuthenticatedApi(page, {
    fileUpload: async (_hostId, route) => {
      const body = route.request().postData() ?? "";
      uploadedDir = /name="dir"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? null;
      uploadedName = /filename="([^"]+)"/.exec(body)?.[1] ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/Users/tester/report.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(page.locator("section[aria-label='Files'] li").first()).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload" }).click();
  await (await chooser).setFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });

  await expect.poll(() => uploadedDir).toBe("/Users/tester");
  expect(uploadedName).toBe("report.txt");
  await expect(page.getByText("Uploaded /Users/tester/report.txt")).toBeVisible();
});

test("new folder, download, and delete actions round-trip", async ({ page }) => {
  const mkdirs: unknown[] = [];
  const deletes: unknown[] = [];
  await mockAuthenticatedApi(page, {
    fileMkdir: async (_hostId, body, route) => {
      mkdirs.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: (body as { path: string }).path },
      });
    },
    fileDelete: async (_hostId, body, route) => {
      deletes.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: (body as { path: string }).path },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("scratch");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => mkdirs.at(-1)).toMatchObject({ path: "/Users/tester/scratch" });

  const fileRow = page.locator("section[aria-label='Files'] li", { hasText: "notes.txt" });
  await fileRow.hover();
  await fileRow.getByRole("button", { name: "notes.txt actions" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("notes.txt");

  page.on("dialog", (dialog) => dialog.accept());
  await fileRow.hover();
  await fileRow.getByRole("button", { name: "notes.txt actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect
    .poll(() => deletes.at(-1))
    .toMatchObject({ path: "/Users/tester/notes.txt", recursive: false });
});

test("send to host transfers a file to the other host's home dir", async ({ page }) => {
  const transfers: unknown[] = [];
  await mockAuthenticatedApi(page, {
    hosts: [host, otherHost],
    fileTransfer: async (_hostId, body, route) => {
      transfers.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { path: "/home/tester/notes.txt" },
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}/files`);

  const fileRow = page.locator("section[aria-label='Files'] li", { hasText: "notes.txt" });
  await fileRow.hover();
  await fileRow.getByRole("button", { name: "notes.txt actions" }).click();
  await page.getByRole("menuitem", { name: "Linux box" }).click();

  await expect
    .poll(() => transfers.at(-1))
    .toMatchObject({
      path: "/Users/tester/notes.txt",
      dest_host_id: OTHER_HOST_ID,
      dest_dir: "/home/tester",
    });
  await expect(page.getByText("Sent to /home/tester/notes.txt")).toBeVisible();
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
