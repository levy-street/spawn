import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let bundleDirectory: string;
let bundlePath: string;

test.beforeAll(() => {
  bundleDirectory = mkdtempSync(path.join(tmpdir(), "spawn-browser-device-identity-"));
  bundlePath = path.join(bundleDirectory, "fixture.js");
  execFileSync(
    "bun",
    [
      "build",
      "tests/e2e/browser-device-identity.fixture.ts",
      "--target=browser",
      "--format=iife",
      "--outfile",
      bundlePath,
    ],
    { cwd: webRoot, stdio: "pipe" },
  );
});

test.afterAll(() => {
  rmSync(bundleDirectory, { force: true, recursive: true });
});

async function loadFixture(page: Page): Promise<void> {
  await page.route("**/api/auth/providers", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ providers: [] }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.goto("/login");
  await page.addScriptTag({ path: bundlePath });
}

test("persists a non-extractable identity across real browser page sessions", async ({ page }) => {
  await loadFixture(page);
  const first = await page.evaluate(async () => {
    const api = globalThis.SpawnBrowserIdentity;
    const identity = await api.loadOrCreateBrowserDeviceIdentity("browser-persistence");
    return { keys: Object.keys(identity).sort(), publicKeyWire: identity.publicKeyWire };
  });

  await page.reload();
  await page.addScriptTag({ path: bundlePath });
  const reloaded = await page.evaluate(async () => {
    const api = globalThis.SpawnBrowserIdentity;
    const identity = await api.loadOrCreateBrowserDeviceIdentity("browser-persistence");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(api.BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const transaction = database.transaction(api.BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
      const request = transaction
        .objectStore(api.BROWSER_DEVICE_IDENTITY_STORE_NAME)
        .get("browser-persistence");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const privateKey = stored.privateKey as CryptoKey;
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey("pkcs8", privateKey);
    } catch {
      exportRejected = true;
    }
    return {
      exportRejected,
      privateExtractable: privateKey.extractable,
      privateUsages: [...privateKey.usages],
      publicKeyWire: identity.publicKeyWire,
      recordKeys: Object.keys(stored).sort(),
      version: stored.version,
    };
  });

  expect(first.keys).toEqual(["publicKey", "publicKeyWire", "sign"]);
  expect(reloaded.publicKeyWire).toBe(first.publicKeyWire);
  expect(reloaded.privateExtractable).toBe(false);
  expect(reloaded.privateUsages).toEqual(["sign"]);
  expect(reloaded.exportRejected).toBe(true);
  expect(reloaded.version).toBe(1);
  expect(reloaded.recordKeys).toEqual([
    "accountId",
    "privateKey",
    "publicKey",
    "publicKeyWire",
    "version",
  ]);
});

test("two tabs converge and expected-key deletion cannot remove a different identity", async ({
  context,
  page,
}) => {
  const secondPage = await context.newPage();
  await Promise.all([loadFixture(page), loadFixture(secondPage)]);

  const [first, second] = await Promise.all([
    page.evaluate(
      async () =>
        (await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity("browser-race"))
          .publicKeyWire,
    ),
    secondPage.evaluate(
      async () =>
        (await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity("browser-race"))
          .publicKeyWire,
    ),
  ]);
  expect(second).toBe(first);

  const other = await page.evaluate(
    async () =>
      (await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity("browser-other"))
        .publicKeyWire,
  );
  expect(other).not.toBe(first);

  const mismatchCode = await page.evaluate(async (wrongKey) => {
    try {
      await globalThis.SpawnBrowserIdentity.deleteBrowserDeviceIdentity("browser-race", wrongKey);
      return "unexpected-success";
    } catch (error) {
      return error instanceof globalThis.SpawnBrowserIdentity.BrowserDeviceIdentityError
        ? error.code
        : "unexpected-error";
    }
  }, other);
  expect(mismatchCode).toBe("key_mismatch");
  expect(
    await secondPage.evaluate(
      async () =>
        (await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity("browser-race"))
          .publicKeyWire,
    ),
  ).toBe(first);

  expect(
    await page.evaluate(
      async (expectedKey) =>
        globalThis.SpawnBrowserIdentity.deleteBrowserDeviceIdentity("browser-race", expectedKey),
      first,
    ),
  ).toBe(true);
  await secondPage.close();
});

declare global {
  // Bundled by the test fixture so the real production library runs against
  // Chromium's native WebCrypto and IndexedDB without a production test route.
  var SpawnBrowserIdentity: typeof import("../../src/lib/browser-device-identity");
}
