import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { mockApp } from "./app-mocks";

const OLD_BUILD = "old-web-build";
const NEW_BUILD = "new-server-build";

let oldWeb: ChildProcess | null = null;
let oldWebUrl = "";
let oldWebScratch = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("could not allocate old-web test port"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForOldWeb(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "no response";
  while (Date.now() < deadline) {
    if (oldWeb?.exitCode !== null) {
      throw new Error(`old web bundle exited during startup (${oldWeb?.exitCode})`);
    }
    try {
      const response = await fetch(`${url}/login`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`old web bundle did not become ready: ${last}`);
}

test.beforeAll(async () => {
  const port = await freePort();
  oldWebUrl = `http://127.0.0.1:${port}`;
  oldWebScratch = mkdtempSync(join(tmpdir(), "spawn-old-web-"));
  // An fd, not a WriteStream: spawn() needs an already-open descriptor for stdio.
  const log = openSync(join(oldWebScratch, "next.log"), "a");
  oldWeb = spawn(
    process.execPath,
    [resolve("node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: resolve("."),
      detached: true,
      env: {
        ...process.env,
        SPAWN_API_PROXY_TARGET: "http://127.0.0.1:9",
        SPAWN_BUILD_ID: OLD_BUILD,
      },
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  await waitForOldWeb(oldWebUrl);
});

test.afterAll(async () => {
  if (oldWeb?.pid) {
    try {
      process.kill(-oldWeb.pid, "SIGTERM");
    } catch {
      // It already exited; afterAll still removes the exact mkdtemp directory.
    }
  }
  oldWeb = null;
  if (oldWebScratch) rmSync(oldWebScratch, { recursive: true, force: true });
});

async function mockNewServerRelease(page: Parameters<typeof mockApp>[0]) {
  await page.route("**/api/release", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: {
        server: { commit: "f".repeat(40), dirty: false },
        web: { build_id: NEW_BUILD },
        daemon: null,
        mobile: { tree: null, runtime_version: null },
        protocols: { daemon: "spawn.control.v3", browser: "spawn.v3", alerts: "spawn.alerts.v1" },
      },
    }),
  );
}

// FIXME(T2): the routeWebSocket mock for /ws/alerts is not reached through the
// separately spawned old-web dev server (its proxy answers ECONNREFUSED first), so
// the socket never "connects" and the 4003 close cannot be injected. The hard
// 4003 dialog is pinned by the release-watcher unit tests; this cell needs the
// old bundle to be served with the mock route active before it is honest here.
test.fixme("old web + new server 4003 shows the hard countdown and never reconnects", async ({
  page,
}) => {
  await mockApp(page);
  await mockNewServerRelease(page);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/alerts/, (socket) => {
    sockets.push(socket);
  });

  await page.goto(`${oldWebUrl}/`);
  await expect.poll(() => sockets.length, { message: "alerts socket never connected" }).toBe(1);
  sockets[0]?.close({ code: 4003, reason: "required protocol not offered" });

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "SPAWN D has been updated" })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(/Reloading in 10 s/);
  await expect(dialog.getByRole("button", { name: "Later" })).toHaveCount(0);
  await expect(page.getByText(/Reconnecting/i)).toHaveCount(0);

  await page.waitForTimeout(1_500);
  expect(sockets).toHaveLength(1);
  await expect(dialog.getByRole("status")).toHaveText(/Reloading in [89] s/);
});

test("a soft old-web/new-server mismatch can be snoozed", async ({ page }) => {
  await mockApp(page);
  await mockNewServerRelease(page);
  await page.routeWebSocket(/\/ws\/alerts/, () => {
    // The soft path does not depend on a signalling close.
  });

  await page.goto(`${oldWebUrl}/`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "SPAWN D has been updated" })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toHaveCount(0);
  const snoozedUntil = await page.evaluate(() =>
    Number(window.sessionStorage.getItem("spawn.release.snoozedUntil")),
  );
  expect(snoozedUntil).toBeGreaterThan(Date.now());
});
