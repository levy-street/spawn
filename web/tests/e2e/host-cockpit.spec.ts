import { expect, test } from "@playwright/test";
import {
  DEFAULT_HOST_CAPABILITIES,
  fileEntry,
  fileListing,
  HOST_ID,
  host,
  mockApp,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const STUDIO_ID = "00000000-0000-4000-8000-0000000000c2";
const studio = { ...host, id: STUDIO_ID, name: "Studio" };
const possessed = { ...host, created_at: "2026-09-14T12:00:00Z" };

test("a host's page is its sections, each at its own address", async ({ page }) => {
  await mockApp(page, { hosts: [possessed], sessions: [session()] });
  await page.goto(`/hosts/${HOST_ID}`);

  const sections = page.getByRole("navigation", { name: "Mac sections" });
  await expect(sections.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const machine = page.getByRole("region", { name: "Machine" });
  await expect(machine).toContainText("Possessed September 14, 2026");
  // What the machine is, then what SPAWN D on it is — the phone's order.
  const facts = await machine.locator("dt").allTextContents();
  expect(facts.indexOf("SPAWN D")).toBe(facts.length - 1);
  expect(facts[0]).toBe("System");
  const running = page.getByRole("region", { name: /^Running here/ });
  await expect(running.getByRole("link", { name: /palette/ })).toBeVisible();
  // Folders are where live windows run, and home. Each opens Files, handing
  // the folder over in memory: no link carries a host path.
  const folders = page.getByRole("region", { name: "Folders" });
  await expect(
    folders.getByRole("button", { name: "~/projects/spawn 1 window here" }),
  ).toBeVisible();
  await expect(folders.getByRole("button", { name: "~ Home" })).toBeVisible();
  await expect(folders.getByRole("link")).toHaveCount(0);

  await sections.getByRole("link", { name: "Sessions" }).click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/sessions$`));
  await expect(sections.getByRole("link", { name: "Sessions" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("region", { name: /^Not in a workspace/ })).toContainText("palette");

  await sections.getByRole("link", { name: "Access" }).click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/access$`));
  await expect(page.getByRole("region", { name: /^Approving devices/ })).toBeVisible();
  // The fingerprint is derived here from the served key, never served.
  const identity = page.getByRole("region", { name: "Identity" });
  await expect(identity).toContainText("SHA256:");
  await expect(identity.getByRole("button", { name: "Manage devices" })).toBeVisible();

  await sections.getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  // The full file browser, in its page layout: Details by default.
  await expect(page.getByRole("grid", { name: "Files" })).toBeVisible();
  // The header carried over: one host name, one set of host actions.
  await expect(page.getByRole("button", { name: "Host actions" })).toHaveCount(1);
});

test("Right now reads whole at phone width: a figure wraps, never cut short", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const GB = 1024 ** 3;
  await mockApp(page, {
    hosts: [possessed],
    capabilities: [...DEFAULT_HOST_CAPABILITIES, "host.metrics"],
    hostMetrics: () => ({
      sample: {
        cpu_percent: 12,
        memory_used_bytes: 89 * GB,
        memory_total_bytes: 125 * GB,
        load_one: 1.25,
        uptime_seconds: 3 * 86_400 + 4 * 3_600,
      },
    }),
  });
  await page.goto(`/hosts/${HOST_ID}`);

  const rightNow = page.getByRole("region", { name: "Right now" });
  const figures = rightNow.locator("dd");
  await expect(figures).toHaveText(["89 GB of 125 GB", "1.25", "3d 4h"]);
  // Nothing is cut off: a phone has no tooltip to show the rest in.
  for (const figure of await figures.all()) {
    const { cut, title } = await figure.evaluate((element) => ({
      cut: element.scrollWidth > element.clientWidth,
      title: element.getAttribute("title"),
    }));
    expect(cut).toBe(false);
    expect(title).toBeNull();
  }
  // Wrapped between its two amounts, not inside one.
  const lines = await figures.first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBeLessThanOrEqual(2);
  const text = await figures.first().evaluate((element) => element.textContent ?? "");
  expect(text).toBe("89\u00a0GB of 125\u00a0GB");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a folder on Overview opens in Files without going into the address", async ({ page }) => {
  await mockApp(page, {
    hosts: [possessed],
    sessions: [session()],
    files: (_hostId, path) =>
      path === "/Users/tester/projects/spawn"
        ? fileListing({
            path: "/Users/tester/projects/spawn",
            parent: "/Users/tester/projects",
            entries: [fileEntry({ name: "main.rs", path: "/Users/tester/projects/spawn/main.rs" })],
          })
        : fileListing(),
    // A name with no extension is a folder, as the host would say.
    fileStat: (_hostId, path) => {
      const name = path.split("/").at(-1) ?? path;
      const file = name.includes(".");
      return { path, name, kind: file ? "file" : "directory", size: file ? 2 : null };
    },
  });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(decodeURIComponent(request.url())));
  await page.goto(`/hosts/${HOST_ID}`);

  await page
    .getByRole("region", { name: "Folders" })
    .getByRole("button", { name: "~/projects/spawn 1 window here" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${HOST_ID}/files$`));
  await expect(
    page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "spawn" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("grid", { name: "Files" }).getByRole("row").filter({ hasText: "main.rs" }),
  ).toBeVisible();
  expect(requested.filter((url) => url.includes("/Users/tester/projects"))).toEqual([]);
});

test("Sessions lists a window in an archived workspace under that workspace", async ({ page }) => {
  const SHELVED_ID = "00000000-0000-4000-8000-0000000000d1";
  const SHELVED_SESSION = "00000000-0000-4000-8000-0000000000d2";
  await mockApp(page, {
    sessions: [session(), session({ id: SHELVED_SESSION, name: "shelved work" })],
    workspaces: [
      workspace({
        id: SHELVED_ID,
        name: "old project",
        archived_at: "2026-10-01T00:00:00Z",
        layout: { version: 3, tiles: [{ session_id: SHELVED_SESSION, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
  });
  await page.goto(`/hosts/${HOST_ID}/sessions`);
  const shelved = page.getByRole("region", { name: /^old project · archived/ });
  await expect(shelved.getByRole("link", { name: /shelved work/ })).toHaveAttribute(
    "href",
    new RegExp(`^/w/${SHELVED_ID}\\?tab=`, "u"),
  );
  await expect(page.getByRole("region", { name: /^Not in a workspace/ })).toContainText("palette");
});

test("switching hosts keeps the section you were in", async ({ page }) => {
  await mockApp(page, { hosts: [host, studio] });
  await page.goto(`/hosts/${HOST_ID}/sessions`);
  await page.getByRole("button", { name: "Switch host" }).click();
  await page.getByRole("menuitem", { name: "Studio Online" }).click();
  await expect(page).toHaveURL(new RegExp(`/hosts/${STUDIO_ID}/sessions$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Studio");
});

test("New window here asks what, where on this host, then which workspace", async ({ page }) => {
  const store = await mockApp(page, { hosts: [host, studio], workspaces: [workspace()] });
  await page.goto(`/hosts/${HOST_ID}`);
  await page.getByRole("button", { name: "New window here…" }).click();
  await page
    .getByRole("menu", { name: "New window on Mac" })
    .getByRole("menuitem", { name: /^Shell/ })
    .click();
  const where = page.getByRole("menu", { name: "Where on Mac?" });
  // Only this host's places: Studio's home is not offered.
  await expect(where.getByRole("menuitem", { name: /Studio/ })).toHaveCount(0);
  await where.getByRole("menuitem", { name: /Mac · home/ }).click();
  await page
    .getByRole("menu", { name: "Open in which workspace?" })
    .getByRole("menuitem", { name: /^New workspace/ })
    .click();

  await expect.poll(() => store.requests.workspaces.length).toBe(1);
  expect(store.requests.workspaces[0]).toEqual({ first_session: { host_id: HOST_ID, cwd: "~" } });
  await expect(page).toHaveURL(/\/w\/[^?]+\?tab=[^&]+&focus=/u);
});

test("a folder chosen by browsing still asks which workspace", async ({ page }) => {
  const store = await mockApp(page, {
    workspaces: [workspace()],
    files: () =>
      fileListing({
        path: "/Users/tester",
        entries: [
          fileEntry({ name: "projects", path: "/Users/tester/projects", is_dir: true, size: null }),
        ],
      }),
  });
  await page.goto(`/hosts/${HOST_ID}`);
  await page.getByRole("button", { name: "New window here…" }).click();
  await page
    .getByRole("menu", { name: "New window on Mac" })
    .getByRole("menuitem", { name: /^Shell/ })
    .click();
  await page
    .getByRole("menu", { name: "Where on Mac?" })
    .getByRole("menuitem", { name: /Choose a folder/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await expect(
    dialog.getByRole("listbox", { name: "Folders in /Users/tester/projects" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  // The cascade closed for the browser and opens again at the question left.
  await page
    .getByRole("menu", { name: "Open in which workspace?" })
    .getByRole("menuitem", { name: /^daily drive/ })
    .click();

  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
    tile: { x: 0, y: 0, w: 24, h: 24 },
  });
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}\\?tab=[^&]+&focus=`, "u"));
});

test("a folder opens a window right there, in the workspace you pick", async ({ page }) => {
  const store = await mockApp(page, {
    sessions: [session()],
    workspaces: [workspace()],
  });
  await page.goto(`/hosts/${HOST_ID}`);
  await page.getByRole("button", { name: "Open a window in ~/projects/spawn" }).click();
  await page.getByRole("menuitem", { name: /^Open a shell here/ }).click();
  await page
    .getByRole("menu", { name: "Open in which workspace?" })
    .getByRole("menuitem", { name: /^daily drive/ })
    .click();

  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toEqual({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects/spawn",
    workspace_id: WORKSPACE_ID,
    // The only window of an empty tab has the whole canvas.
    tile: { x: 0, y: 0, w: 24, h: 24 },
  });
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}\\?tab=[^&]+&focus=`, "u"));
});

test("an offline host's page says so and opens no windows", async ({ page }) => {
  await mockApp(page, {
    hosts: [{ ...host, status: "offline", last_seen_at: null }],
  });
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByText("Offline · never connected")).toBeVisible();
  const open = page.getByRole("button", { name: "New window here…" });
  await expect(open).toBeDisabled();
  await expect(open).toHaveAccessibleDescription("Mac is offline.");
  await expect(page.getByTestId("host-health-panel")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Mac sections" })
    .getByRole("link", { name: "Files" })
    .click();
  await expect(page.getByText("Mac is offline", { exact: true })).toBeVisible();
  await expect(
    page.getByText("File browsing needs a live, direct connection to this host."),
  ).toBeVisible();
});

test("Update SPAWN D… is always listed, and only does something when there is an update to act on", async ({
  page,
}) => {
  await mockApp(page, { hosts: [{ ...host, update: { ...host.update, state: "unknown" } }] });
  await page.goto(`/hosts/${HOST_ID}`);
  await page.getByRole("button", { name: "Host actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Update SPAWN D…" })).toBeDisabled();
});
