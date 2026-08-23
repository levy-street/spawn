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
    "npx",
    [
      "--package=bun",
      "bunx",
      "bun",
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
  await page.route("**/api/auth/config", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        providers: [],
        email_verification_required: false,
        invite_only: false,
      }),
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
    const identity = await api.loadOrCreateBrowserDeviceIdentity(
      "00000000-0000-0000-0000-000000000201",
    );
    return {
      keys: Object.keys(identity).sort(),
      publicKeyWire: identity.publicKeyWire,
    };
  });

  await page.reload();
  await page.addScriptTag({ path: bundlePath });
  const reloaded = await page.evaluate(async () => {
    const api = globalThis.SpawnBrowserIdentity;
    const identity = await api.loadOrCreateBrowserDeviceIdentity(
      "00000000-0000-0000-0000-000000000201",
    );
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(api.BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const transaction = database.transaction(api.BROWSER_DEVICE_IDENTITY_STORE_NAME, "readonly");
      const request = transaction
        .objectStore(api.BROWSER_DEVICE_IDENTITY_STORE_NAME)
        .get("00000000-0000-0000-0000-000000000201");
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

test("native browser ingress rejects every noncanonical account UUID spelling", async ({
  page,
}) => {
  await loadFixture(page);
  const codes = await page.evaluate(async () => {
    const invalid = [
      "account-arbitrary",
      "00000000000000000000000000000001",
      "{00000000-0000-0000-0000-000000000001}",
      "00000000-0000-0000-0000-000000000001 ",
      "00000000-0000-0000-0000-00000000000A",
    ];
    return Promise.all(
      invalid.map(async (accountId) => {
        try {
          await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity(accountId);
          return "unexpected-success";
        } catch (error) {
          return error instanceof globalThis.SpawnBrowserIdentity.BrowserDeviceIdentityError
            ? error.code
            : "unexpected-error";
        }
      }),
    );
  });
  expect(codes).toEqual(Array.from({ length: 5 }, () => "invalid_account"));
});

test("rejects corrupt version-1 store schemas repeatedly without rotating", async ({ page }) => {
  await loadFixture(page);
  const results = await page.evaluate(async () => {
    const api = globalThis.SpawnBrowserIdentity;
    const deleteDatabase = () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(api.BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("database deletion blocked"));
      });
    const createInvalidDatabase = (schema: {
      autoIncrement: boolean;
      keyPath: string | string[] | null;
      seedKey?: IDBValidKey;
      seedRecord: Record<string, unknown>;
    }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(
          api.BROWSER_DEVICE_IDENTITY_DATABASE_NAME,
          api.BROWSER_DEVICE_IDENTITY_STORAGE_VERSION,
        );
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(api.BROWSER_DEVICE_IDENTITY_STORE_NAME, {
            autoIncrement: schema.autoIncrement,
            keyPath: schema.keyPath,
          });
          if (schema.seedKey === undefined) {
            store.add(schema.seedRecord);
          } else {
            store.add(schema.seedRecord, schema.seedKey);
          }
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    const inspectDatabase = () =>
      new Promise<{
        autoIncrement: boolean;
        keyPath: IDBObjectStore["keyPath"];
        keys: IDBValidKey[];
        records: unknown[];
      }>((resolve, reject) => {
        const request = indexedDB.open(api.BROWSER_DEVICE_IDENTITY_DATABASE_NAME);
        request.onsuccess = () => {
          const database = request.result;
          let settled = false;
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            database.close();
            reject(error);
          };
          try {
            const transaction = database.transaction(
              api.BROWSER_DEVICE_IDENTITY_STORE_NAME,
              "readonly",
            );
            const store = transaction.objectStore(api.BROWSER_DEVICE_IDENTITY_STORE_NAME);
            const keys = store.getAllKeys();
            const records = store.getAll();
            const snapshot = {
              autoIncrement: store.autoIncrement,
              keyPath: store.keyPath,
              keys: [] as IDBValidKey[],
              records: [] as unknown[],
            };
            keys.onsuccess = () => {
              snapshot.keys = keys.result;
            };
            records.onsuccess = () => {
              snapshot.records = records.result;
            };
            transaction.oncomplete = () => {
              if (settled) return;
              settled = true;
              database.close();
              resolve(snapshot);
            };
            transaction.onabort = () =>
              fail(transaction.error ?? new Error("database inspection transaction aborted"));
            transaction.onerror = () =>
              fail(transaction.error ?? new Error("database inspection transaction failed"));
          } catch (error) {
            fail(error);
          }
        };
        request.onerror = () => reject(request.error);
      });

    const cases = [
      {
        autoIncrement: false,
        keyPath: "wrongAccountId",
        seedRecord: { marker: "wrong-key-path", wrongAccountId: "seed" },
      },
      {
        autoIncrement: false,
        keyPath: ["tenant", "account"],
        seedRecord: {
          account: "seed",
          marker: "compound-key-path",
          tenant: "test",
        },
      },
      {
        autoIncrement: false,
        keyPath: null,
        seedKey: "seed",
        seedRecord: { marker: "out-of-line-key" },
      },
      {
        autoIncrement: true,
        keyPath: "accountId",
        seedRecord: { accountId: "seed", marker: "auto-increment" },
      },
    ];
    const observed = [];
    for (const invalid of cases) {
      await deleteDatabase();
      await createInvalidDatabase(invalid);
      const before = await inspectDatabase();
      const errors = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await api.loadOrCreateBrowserDeviceIdentity("00000000-0000-0000-0000-000000000202");
          errors.push("unexpected-success");
        } catch (error) {
          errors.push(error instanceof api.BrowserDeviceIdentityError ? error.code : "unexpected");
        }
      }
      observed.push({ after: await inspectDatabase(), before, errors });
    }
    return observed;
  });

  expect(results).toEqual([
    {
      after: {
        autoIncrement: false,
        keyPath: "wrongAccountId",
        keys: ["seed"],
        records: [{ marker: "wrong-key-path", wrongAccountId: "seed" }],
      },
      before: {
        autoIncrement: false,
        keyPath: "wrongAccountId",
        keys: ["seed"],
        records: [{ marker: "wrong-key-path", wrongAccountId: "seed" }],
      },
      errors: ["corrupt_record", "corrupt_record"],
    },
    {
      after: {
        autoIncrement: false,
        keyPath: ["tenant", "account"],
        keys: [["test", "seed"]],
        records: [{ account: "seed", marker: "compound-key-path", tenant: "test" }],
      },
      before: {
        autoIncrement: false,
        keyPath: ["tenant", "account"],
        keys: [["test", "seed"]],
        records: [{ account: "seed", marker: "compound-key-path", tenant: "test" }],
      },
      errors: ["corrupt_record", "corrupt_record"],
    },
    {
      after: {
        autoIncrement: false,
        keyPath: null,
        keys: ["seed"],
        records: [{ marker: "out-of-line-key" }],
      },
      before: {
        autoIncrement: false,
        keyPath: null,
        keys: ["seed"],
        records: [{ marker: "out-of-line-key" }],
      },
      errors: ["corrupt_record", "corrupt_record"],
    },
    {
      after: {
        autoIncrement: true,
        keyPath: "accountId",
        keys: ["seed"],
        records: [{ accountId: "seed", marker: "auto-increment" }],
      },
      before: {
        autoIncrement: true,
        keyPath: "accountId",
        keys: ["seed"],
        records: [{ accountId: "seed", marker: "auto-increment" }],
      },
      errors: ["corrupt_record", "corrupt_record"],
    },
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
        (
          await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity(
            "00000000-0000-0000-0000-000000000203",
          )
        ).publicKeyWire,
    ),
    secondPage.evaluate(
      async () =>
        (
          await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity(
            "00000000-0000-0000-0000-000000000203",
          )
        ).publicKeyWire,
    ),
  ]);
  expect(second).toBe(first);

  const other = await page.evaluate(
    async () =>
      (
        await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity(
          "00000000-0000-0000-0000-000000000204",
        )
      ).publicKeyWire,
  );
  expect(other).not.toBe(first);

  const mismatchCode = await page.evaluate(async (wrongKey) => {
    try {
      await globalThis.SpawnBrowserIdentity.deleteBrowserDeviceIdentity(
        "00000000-0000-0000-0000-000000000203",
        wrongKey,
      );
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
        (
          await globalThis.SpawnBrowserIdentity.loadOrCreateBrowserDeviceIdentity(
            "00000000-0000-0000-0000-000000000203",
          )
        ).publicKeyWire,
    ),
  ).toBe(first);

  expect(
    await page.evaluate(
      async (expectedKey) =>
        globalThis.SpawnBrowserIdentity.deleteBrowserDeviceIdentity(
          "00000000-0000-0000-0000-000000000203",
          expectedKey,
        ),
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
