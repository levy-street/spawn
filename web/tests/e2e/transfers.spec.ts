import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type AppMockOptions,
  fileEntry,
  fileListing,
  HOST_ID,
  host,
  mockApp,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const OTHER_HOST_ID = "00000000-0000-4000-8000-000000000009";
const otherHost = { ...host, id: OTHER_HOST_ID, name: "Linux box", home_dir: "/home/tester" };

/** Home has projects/ + notes.txt; projects/ has spawn/ + readme.md; spawn/ has main.rs. */
function treeFiles(_hostId: string, path: string | null) {
  if (path === "/Users/tester/projects") {
    return fileListing({
      path,
      parent: "/Users/tester",
      entries: [
        fileEntry({
          name: "spawn",
          path: "/Users/tester/projects/spawn",
          is_dir: true,
          size: null,
        }),
        fileEntry({ name: "readme.md", path: "/Users/tester/projects/readme.md", size: 5 }),
      ],
    });
  }
  if (path === "/Users/tester/projects/spawn") {
    return fileListing({
      path,
      parent: "/Users/tester/projects",
      entries: [
        fileEntry({ name: "main.rs", path: "/Users/tester/projects/spawn/main.rs", size: 7 }),
      ],
    });
  }
  return fileListing();
}

function item(page: Page, name: string) {
  return page
    .getByRole("grid", { name: "Files" })
    .getByRole("row")
    .filter({ hasText: name })
    .first();
}

function tray(page: Page) {
  return page.getByRole("region", { name: "Transfers" });
}

/** The entry names in a zip's central directory. */
function zipNames(bytes: Buffer): string[] {
  const names: string[] = [];
  for (let at = 0; at + 46 <= bytes.length; at += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + 46, at + 46 + length).toString("utf8"));
  }
  return names;
}

test("a folder uploads whole into the folder on screen, its folders made first", async ({
  page,
}, testInfo) => {
  const made: string[] = [];
  const written: Array<{ dir: unknown; name: unknown }> = [];
  await mockApp(page, {
    files: treeFiles,
    fileMkdir: async (_hostId, body, route) => {
      made.push(String((body as { path: string }).path));
      await route.fulfill({ json: { path: (body as { path: string }).path } });
    },
    fileUpload: async (_hostId, route) => {
      const declaration = (await route.request().postDataJSON()) as Record<string, unknown>;
      written.push({ dir: declaration.dir, name: declaration.name });
      await route.fulfill({ json: { path: `${declaration.dir}/${declaration.name}` } });
    },
  });
  const site = testInfo.outputPath("site");
  mkdirSync(join(site, "css"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(site, "css", "a.css"), "body{}");

  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "notes.txt")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Upload folder…" }).click();
  await (await chooser).setFiles(site);

  await expect(
    tray(page).getByRole("listitem", { name: "Uploaded “site” to Home on Mac" }),
  ).toBeVisible();
  await expect(tray(page).getByText("2 items · 17 B")).toBeVisible();
  expect(made).toEqual(["/Users/tester/site", "/Users/tester/site/css"]);
  expect(written).toEqual(
    expect.arrayContaining([
      { dir: "/Users/tester/site", name: "index.html" },
      { dir: "/Users/tester/site/css", name: "a.css" },
    ]),
  );
});

test("a folder downloads as one zip of everything in it", async ({ page }) => {
  await mockApp(page, {
    files: treeFiles,
    fileRead: (_hostId, path) => (path.endsWith("main.rs") ? "fn main" : "hello"),
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "projects").click({ button: "right" });
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as zip" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("projects.zip");
  const bytes = readFileSync((await download.path()) as string);
  expect(zipNames(bytes)).toEqual([
    "projects/",
    "projects/readme.md",
    "projects/spawn/",
    "projects/spawn/main.rs",
  ]);
  await expect(
    tray(page).getByRole("listitem", { name: "Downloaded “projects.zip” from Mac" }),
  ).toBeVisible();
});

test("a name already at the destination is asked about in the tray", async ({ page }) => {
  const written: Array<{ host: string; dir: unknown; name: unknown }> = [];
  await mockApp(page, {
    hosts: [host, otherHost],
    files: (hostId, path) =>
      hostId === OTHER_HOST_ID
        ? fileListing({
            path: "/home/tester",
            home_dir: "/home/tester",
            parent: "/home",
            entries: [fileEntry({ name: "notes.txt", path: "/home/tester/notes.txt" })],
          })
        : treeFiles(hostId, path),
    fileUpload: async (hostId, route) => {
      const declaration = (await route.request().postDataJSON()) as Record<string, unknown>;
      written.push({ host: hostId, dir: declaration.dir, name: declaration.name });
      await route.fulfill({ json: { path: `${declaration.dir}/${declaration.name}` } });
    },
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "notes.txt").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Send to another host…" }).click();
  await page.getByRole("menuitem", { name: /^Linux box/ }).click();
  await page
    .getByRole("dialog", { name: "Where on Linux box?" })
    .getByRole("button", { name: "Select this folder" })
    .click();
  const confirm = page.getByRole("dialog", { name: "Send “notes.txt” to Linux box" });
  await expect(confirm.getByText("Into Home on Linux box")).toBeVisible();
  // "Ask each time" is where it starts.
  await expect(confirm.getByRole("tab", { name: "Ask each time" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await confirm.getByRole("button", { name: "Send “notes.txt” to Linux box" }).click();

  const card = tray(page).getByRole("listitem", {
    name: /“notes.txt” from Mac to Home on Linux box/,
  });
  await expect(card.getByText("“notes.txt” already exists in Home on Linux box.")).toBeVisible();
  await card.getByRole("button", { name: "Keep both" }).click();
  await expect(
    tray(page).getByRole("listitem", { name: "Sent “notes.txt” from Mac to Home on Linux box" }),
  ).toBeVisible();
  expect(written).toEqual([{ host: OTHER_HOST_ID, dir: "/home/tester", name: "notes (2).txt" }]);
});

/** Fails unless `inner` lies inside `outer` from its left edge to its right. */
async function expectWithin(inner: Locator, outer: Locator) {
  const [box, frame] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!box || !frame) throw new Error("not laid out");
  expect(box.x).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
}

test("a long name never pushes Cancel out of the send dialog", async ({ page }) => {
  await mockApp(page, {
    hosts: [host, { ...otherHost, name: "build-server", home_dir: "/home/builder" }],
    files: (hostId, path) =>
      hostId === OTHER_HOST_ID
        ? fileListing({ path: "/home/builder", home_dir: "/home/builder", parent: "/home" })
        : path === "/Users/tester" || path === "~"
          ? fileListing({
              entries: [
                fileEntry({
                  name: "staging-2026-10-03.db",
                  path: "/Users/tester/staging-2026-10-03.db",
                }),
              ],
            })
          : treeFiles(hostId, path),
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "staging-2026-10-03.db").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Send to another host…" }).click();
  await page.getByRole("menuitem", { name: /^build-server/ }).click();
  await page
    .getByRole("dialog", { name: "Where on build-server?" })
    .getByRole("button", { name: "Select this folder" })
    .click();

  const label = "Send “staging-2026-10-03.db” to build-server";
  const confirm = page.getByRole("dialog", { name: label });
  const cancel = confirm.getByRole("button", { name: "Cancel" });
  // Cut short to fit, the button still answers to the whole sentence.
  const sendButton = confirm.getByRole("button", { name: label, exact: true });
  await expect(cancel).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expectWithin(cancel, confirm);
    await expectWithin(sendButton, confirm);
  }
  await cancel.click();
  await expect(confirm).toBeHidden();
  // Cancelled: nothing was sent.
  await expect(tray(page)).toHaveCount(0);
});

test("a link has nothing of its own to download or send", async ({ page }) => {
  await mockApp(page, {
    hosts: [host, otherHost],
    files: (hostId, path) =>
      path === "/Users/tester" || path === "~"
        ? fileListing({
            entries: [
              fileEntry(),
              fileEntry({
                name: "latest",
                path: "/Users/tester/latest",
                kind: "symlink",
                size: null,
              }),
            ],
          })
        : treeFiles(hostId, path),
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "latest").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Send to another host…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A file beside it still offers both.
  await item(page, "notes.txt").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Send to another host…" })).toBeVisible();
});

test("a relayed transfer over 100 MB asks first, and is honest about what this browser can hold", async ({
  page,
}) => {
  const reads: string[] = [];
  await mockApp(page, {
    files: (_hostId, path) =>
      path === "/Users/tester" || path === "~"
        ? fileListing({
            entries: [
              fileEntry({
                name: "movie.mov",
                path: "/Users/tester/movie.mov",
                size: 200 * 1024 ** 2,
              }),
            ],
          })
        : fileListing(),
    fileRead: (_hostId, path) => {
      reads.push(path);
      return "x";
    },
  });
  // This device reaches the host only through the TURN relay.
  await page.addInitScript(() => {
    const Peer = globalThis.RTCPeerConnection;
    Peer.prototype.getStats = async () =>
      new Map<string, unknown>([
        [
          "pair",
          {
            type: "candidate-pair",
            state: "succeeded",
            nominated: true,
            localCandidateId: "local",
            remoteCandidateId: "remote",
            currentRoundTripTime: 0.08,
          },
        ],
        ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
        ["remote", { type: "remote-candidate", candidateType: "host" }],
      ]) as unknown as RTCStatsReport;
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(page.getByText("Online · relayed")).toBeVisible({ timeout: 15_000 });

  await item(page, "movie.mov").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const card = tray(page).getByRole("listitem", { name: "Downloading “movie.mov” from Mac" });
  await expect(
    card.getByText(
      /^This transfer goes through the SPAWN D relay because Mac and this device can't reach each other directly\. 200 MB may take a while\. It will take about \d+ minutes\.$/,
    ),
  ).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("Cancelled")).toBeVisible();

  await item(page, "movie.mov").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const again = tray(page)
    .getByRole("listitem", { name: "Downloading “movie.mov” from Mac" })
    .last();
  await again.getByRole("button", { name: "Download anyway" }).click();
  // No save picker and no streaming worker here: memory is all there is, and it says so.
  await expect(
    again.getByText(
      "This browser can only save up to 32 MB at a time from SPAWN D. Reload the page and try again, or use Chrome or Edge.",
    ),
  ).toBeVisible();
  expect(reads).toEqual([]);
});

test("a folder opens a terminal or an agent right there, in the workspace you pick", async ({
  page,
}) => {
  const store = await mockApp(page, { files: treeFiles, workspaces: [workspace()] });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await item(page, "projects").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open terminal here" }).click();
  await page
    .getByRole("menu", { name: "Open in which workspace?" })
    .getByRole("menuitem", { name: /^daily drive/ })
    .click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
  });
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}\\?tab=[^&]+&focus=`, "u"));

  // The folder on screen offers the same from its own ground.
  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "notes.txt")).toBeVisible();
  await page
    .getByRole("grid", { name: "Files" })
    .click({ button: "right", position: { x: 300, y: 200 } });
  await page.getByRole("menuitem", { name: "Start agent here…" }).click();
  await page
    .getByRole("menu", { name: "Which agent?" })
    .getByRole("menuitem", { name: /^Codex/ })
    .click();
  await page
    .getByRole("menu", { name: "Open in which workspace?" })
    .getByRole("menuitem", { name: /^daily drive/ })
    .click();
  await expect.poll(() => store.requests.sessions.length).toBe(2);
  expect(store.requests.sessions[1]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester",
    workspace_id: WORKSPACE_ID,
  });
});

test("from a workspace's files pane, a terminal opens in that workspace without asking", async ({
  page,
}) => {
  const store = await mockApp(page, {
    files: treeFiles,
    workspaces: [
      workspace({
        layout: {
          version: 3,
          tiles: [
            {
              session_id: "00000000-0000-4000-8000-0000000000f1",
              x: 0,
              y: 0,
              w: 24,
              h: 24,
              widget: { kind: "files", host_id: HOST_ID, path: "/Users/tester" },
            },
          ],
        },
      }),
    ],
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const pane = page.getByRole("region", { name: /^Files — / });
  await pane.getByRole("treeitem").filter({ hasText: "projects" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open terminal here" }).click();
  await expect.poll(() => store.requests.sessions.length).toBe(1);
  expect(store.requests.sessions[0]).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/projects",
    workspace_id: WORKSPACE_ID,
  });
  await expect(page.getByRole("menu", { name: "Open in which workspace?" })).toHaveCount(0);
});

test("a transfer started in another tab runs in the tab holding the connection, and one cut short when that tab closes resumes", async ({
  context,
}) => {
  const written: string[] = [];
  let holdRead: (() => void) | null = null;
  const options: AppMockOptions = {
    files: (hostId, path) =>
      path === "/Users/tester" || path === "~"
        ? fileListing({
            entries: [
              fileEntry(),
              fileEntry({ name: "slow.bin", path: "/Users/tester/slow.bin", size: 9 }),
            ],
          })
        : treeFiles(hostId, path),
    fileRead: async (_hostId, path) => {
      if (path.endsWith("slow.bin") && holdRead === null) {
        // The first read waits; the owner tab closes meanwhile.
        await new Promise<void>((resolve) => {
          holdRead = resolve;
        });
      }
      return path.endsWith("slow.bin") ? "slow file" : "hi";
    },
    fileUpload: async (_hostId, route) => {
      const declaration = (await route.request().postDataJSON()) as Record<string, unknown>;
      written.push(String(declaration.name));
      await route.fulfill({ json: { path: `${declaration.dir}/${declaration.name}` } });
    },
  };
  const owner = await context.newPage();
  await mockApp(owner, options);
  await owner.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(owner, "notes.txt")).toBeVisible();
  const follower = await context.newPage();
  await mockApp(follower, options);
  await follower.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(follower, "notes.txt")).toBeVisible();

  // An upload asked for here runs in the tab that holds the connection, and
  // this tab follows it.
  const chooser = follower.waitForEvent("filechooser");
  await follower.getByRole("button", { name: "New", exact: true }).click();
  await follower.getByRole("menuitem", { name: "Upload files…" }).click();
  await (await chooser).setFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(
    tray(follower).getByRole("listitem", { name: "Uploaded “report.txt” to Home on Mac" }),
  ).toBeVisible();
  await expect(
    tray(owner).getByRole("listitem", { name: "Uploaded “report.txt” to Home on Mac" }),
  ).toBeVisible();
  expect(written).toEqual(["report.txt"]);

  // A download stays in the tab that saves it; the tab holding the
  // connection closes under it.
  await item(follower, "slow.bin").click({ button: "right" });
  const downloading = follower.waitForEvent("download");
  await follower.getByRole("menuitem", { name: "Download", exact: true }).click();
  await expect.poll(() => holdRead !== null).toBe(true);
  await owner.close({ runBeforeUnload: false });
  const card = tray(follower).getByRole("listitem", { name: "Downloading “slow.bin” from Mac" });
  await expect(
    card.getByText("Interrupted because another SPAWN D tab closed or went to sleep."),
  ).toBeVisible();
  (holdRead as (() => void) | null)?.();
  await card.getByRole("button", { name: "Resume" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("slow.bin");
  expect(readFileSync((await download.path()) as string, "utf8")).toBe("slow file");
});

test("with a service worker in control, a zip streams through it to the browser's download", async ({
  page,
}) => {
  await mockApp(page, {
    files: treeFiles,
    fileRead: (_hostId, path) => (path.endsWith("main.rs") ? "fn main" : "hello"),
  });
  await page.goto(`/hosts/${HOST_ID}/files`);
  await expect(item(page, "projects").first()).toBeVisible();
  // Production registers it on load; the dev server does not, so the test does.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  const streamed: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/__spawn/stream/"))
      streamed.push(request.url());
  });

  await item(page, "projects").click({ button: "right" });
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as zip" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("projects.zip");
  expect(zipNames(readFileSync((await download.path()) as string))).toEqual([
    "projects/",
    "projects/readme.md",
    "projects/spawn/",
    "projects/spawn/main.rs",
  ]);
  // It went through the worker's route, which names nothing but its token.
  expect(streamed).toHaveLength(1);
  expect(new URL(streamed[0] as string).pathname).toMatch(
    /^\/__spawn\/stream\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  // And the worker cached nothing of it.
  const cached = await page.evaluate(async () => {
    const keys: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) keys.push(request.url);
    }
    return keys.filter((url) => url.includes("__spawn"));
  });
  expect(cached).toEqual([]);
});
