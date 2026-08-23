import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

// The /device approval page on its no-fragment paths: every test here opens
// the page WITHOUT a `#k=` host-key fragment, which is the fallback lane
// (older daemons, retyped URLs) — the human compares the full fingerprint
// against the host's terminal. The fragment lane, and the refusal of a
// server-substituted host key, live in possess-key-check.spec.ts.

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return `SHA256:${digest.subarray(0, 12).toString("base64url")}`;
}

async function readHostPins(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("host-pins", "readonly");
      const records = transaction.objectStore("host-pins").getAll();
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        records.onsuccess = () => resolve(records.result);
        records.onerror = () => reject(records.error);
      });
    } finally {
      database.close();
    }
  });
}

async function corruptHostPinStore(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("host-pins", "readwrite");
      transaction.objectStore("host-pins").add({ recordId: "corrupt", unknown: true });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

test("device approval shows the locally derived fingerprint before confirmation", async ({
  page,
}) => {
  const hostFingerprint = fingerprint(HOST_PUBLIC_KEY);
  const hostPublicKey = HOST_PUBLIC_KEY;
  let approved = false;
  let approvalBody: unknown = null;
  let browserPublicKey = "";
  let browserFingerprint = "";
  let localPinAtServerApproval: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      browserPublicKey = body.public_key;
      browserFingerprint = fingerprint(body.public_key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: browserPublicKey,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      localPinAtServerApproval = await readHostPins(page);
      approved = true;
      approvalBody = request.postDataJSON();
      const body = approvalBody as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          browser_device_id: body.browser_device_id,
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device?code=QZ4K-7HMT");

  await expect(page.getByTestId("host-key-fingerprint")).toHaveText(hostFingerprint);
  await expect(page.getByText("build-host", { exact: false })).toBeVisible();
  expect(approved).toBe(false);

  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByTestId("ceremony-done")).toContainText("build-host is possessed");
  expect(approved).toBe(true);
  expect(localPinAtServerApproval).toMatchObject([
    {
      accountId: USER_ID,
      hostFingerprint,
      hostPublicKey,
      origin: new URL(page.url()).origin,
      state: "active",
      version: 1,
    },
  ]);
  expect(approvalBody).toMatchObject({
    user_code: "QZ4K-7HMT",
    approval_nonce: APPROVAL_NONCE,
    host_key_algorithm: "ed25519",
    host_public_key: hostPublicKey,
    // Both request fingerprints are still sent — the reviewed one from the
    // pending response and this browser's own, both derived/cross-checked
    // client-side (mesh B5) and binding-validated by the server.
    host_key_fingerprint: hostFingerprint,
    browser_device_id: BROWSER_DEVICE_ID,
    browser_key_algorithm: "ed25519",
    browser_public_key: browserPublicKey,
    browser_key_fingerprint: browserFingerprint,
  });
  expect((approvalBody as { signature: string }).signature).toHaveLength(86);
  const webStorage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
  }));
  expect(JSON.stringify(webStorage)).not.toContain(
    (approvalBody as { signature: string }).signature,
  );
});

test("the bare page instructs — one command, no code to type", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        json: {
          user: { id: USER_ID, email: "owner@example.com", created_at: "2026-07-17T00:00:00Z" },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = route.request().postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  await page.goto("/device");

  const instructions = page.getByTestId("possess-instructions");
  await expect(instructions).toBeVisible();
  await expect(instructions).toContainText("spawnd possess");
  await expect(instructions).toContainText("single click");
  // The terminal's link is still the intended entry, but /device is the shared
  // connect surface after the workspaces overhaul, so code entry stays on the
  // page as the stated fallback for a host whose link you cannot open. Typing a
  // code is not a weaker path: it runs the same fingerprint-compare ceremony.
  await expect(instructions).toContainText("fallback");
  await expect(page.getByLabel("Code from the terminal")).toBeVisible();
});

test("blocks first contact when the server fingerprint disagrees with the host key", async ({
  page,
}) => {
  let approveCalled = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "substituted-fingerprint-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      approveCalled = true;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device?code=QZ4K-7HMT");

  await expect(page.locator("p[role=alert]")).toContainText("identity did not check out");
  await expect(page.getByTestId("host-key-fingerprint")).not.toBeVisible();
  expect(approveCalled).toBe(false);
});

test("server approval failure retains a reload-safe local pin and offers explicit retry", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = route.request().postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "changed-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        json: {
          detail: "host identity changed since review; review the device code again",
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device?code=QZ4K-7HMT");
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await page.getByRole("button", { name: "They match" }).click();

  await expect(page.locator("p[role=alert]")).toContainText("review the device code again");
  await expect(page.locator("p[role=alert]")).toContainText("saved in this browser");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(await readHostPins(page)).toMatchObject([
    { state: "active", hostPublicKey: HOST_PUBLIC_KEY },
  ]);

  await page.reload();
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible();
});

test("substituted approval response fails loudly while preserving retryable local trust", async ({
  page,
}) => {
  const hostPublicKey = HOST_PUBLIC_KEY;
  const hostFingerprint = fingerprint(HOST_PUBLIC_KEY);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "substituted-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      const body = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "substituted-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          browser_device_id: "00000000-0000-4000-8000-000000000010",
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device?code=QZ4K-7HMT");
  await page.getByRole("button", { name: "They match" }).click();

  await expect(page.locator("p[role=alert]")).toContainText(
    "approval response changed the reviewed host or browser identity",
  );
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(await readHostPins(page)).toMatchObject([
    { state: "active", hostPublicKey: HOST_PUBLIC_KEY },
  ]);
});

test("local pin write corruption blocks approval before any server call", async ({ page }) => {
  let approveCalls = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        json: {
          user: { id: USER_ID, email: "owner@example.com", created_at: "2026-07-17T00:00:00Z" },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = route.request().postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        json: {
          host_name: "corrupt-local-store-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") approveCalls += 1;
    await route.fulfill({ status: 500, json: { detail: "must not be called" } });
  });

  await page.goto("/device?code=QZ4K-7HMT");
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await corruptHostPinStore(page);
  await page.getByRole("button", { name: "They match" }).click();

  await expect(page.locator("p[role=alert]")).toContainText("stored host pin");
  expect(approveCalls).toBe(0);
});

test("two native Chromium tabs converge on one exact local pin", async ({ context, page }) => {
  const secondPage = await context.newPage();
  const installRoutes = async (target: Page) => {
    await target.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me") {
        await route.fulfill({
          status: 200,
          json: {
            user: {
              id: USER_ID,
              email: "owner@example.com",
              created_at: "2026-07-17T00:00:00Z",
            },
          },
        });
        return;
      }
      if (path === "/api/browser-devices/register") {
        const body = route.request().postDataJSON() as { public_key: string };
        await route.fulfill({
          status: 200,
          json: {
            id: BROWSER_DEVICE_ID,
            key_algorithm: "ed25519",
            public_key: body.public_key,
            created_at: "2026-07-17T00:00:00Z",
            revoked_at: null,
          },
        });
        return;
      }
      if (path === "/api/auth/device/pending") {
        await route.fulfill({
          status: 200,
          json: {
            host_name: "concurrent-host",
            approval_nonce: APPROVAL_NONCE,
            host_key_algorithm: "ed25519",
            host_public_key: HOST_PUBLIC_KEY,
            host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
          },
        });
        return;
      }
      if (path === "/api/auth/device/approve") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          json: {
            host_name: "concurrent-host",
            approval_nonce: APPROVAL_NONCE,
            host_key_algorithm: "ed25519",
            host_public_key: HOST_PUBLIC_KEY,
            browser_device_id: body.browser_device_id,
            browser_key_algorithm: body.browser_key_algorithm,
            browser_public_key: body.browser_public_key,
          },
        });
        return;
      }
      await route.fulfill({ status: 404, json: { detail: "not mocked" } });
    });
  };
  await installRoutes(page);
  await installRoutes(secondPage);
  await Promise.all([
    page.goto("/device?code=QZ4K-7HMT"),
    secondPage.goto("/device?code=QZ4K-7HMT"),
  ]);
  await Promise.all([
    page.getByRole("button", { name: "They match" }).click(),
    secondPage.getByRole("button", { name: "They match" }).click(),
  ]);
  await expect(page.getByTestId("ceremony-done")).toContainText("is possessed");
  await expect(secondPage.getByTestId("ceremony-done")).toContainText("is possessed");
  expect(await readHostPins(page)).toMatchObject([
    { hostPublicKey: HOST_PUBLIC_KEY, state: "active" },
  ]);
  expect(await readHostPins(page)).toHaveLength(1);
  await secondPage.close();
});
