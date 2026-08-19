import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

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
          fingerprint: browserFingerprint,
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
          host_key_fingerprint: hostFingerprint,
          browser_device_id: body.browser_device_id,
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
          browser_key_fingerprint: body.browser_key_fingerprint,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();

  await expect(page.getByTestId("host-key-fingerprint")).toHaveText(hostFingerprint);
  await expect(page.getByText("build-host", { exact: false })).toBeVisible();
  expect(approved).toBe(false);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("build-host is connected");
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
          fingerprint: fingerprint(body.public_key),
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

  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();

  await expect(page.locator("p[role=alert]")).toContainText(
    "fingerprint did not match its public key",
  );
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
          fingerprint: fingerprint(body.public_key),
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

  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.locator("p[role=alert]")).toContainText("review the device code again");
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry server approval" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Saved in this browser");
  expect(await readHostPins(page)).toMatchObject([
    { state: "active", hostPublicKey: HOST_PUBLIC_KEY },
  ]);

  await page.reload();
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();
  await expect(page.getByRole("button", { name: "Retry server approval" })).toBeVisible();
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
          fingerprint: fingerprint(body.public_key),
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
          host_key_fingerprint: hostFingerprint,
          browser_device_id: "00000000-0000-4000-8000-000000000010",
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
          browser_key_fingerprint: body.browser_key_fingerprint,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.locator("p[role=alert]")).toContainText(
    "Approval response changed the reviewed host or browser identity",
  );
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry server approval" })).toBeVisible();
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
          fingerprint: fingerprint(body.public_key),
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

  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await corruptHostPinStore(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();

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
            fingerprint: fingerprint(body.public_key),
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
            host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
            browser_device_id: body.browser_device_id,
            browser_key_algorithm: body.browser_key_algorithm,
            browser_public_key: body.browser_public_key,
            browser_key_fingerprint: body.browser_key_fingerprint,
          },
        });
        return;
      }
      await route.fulfill({ status: 404, json: { detail: "not mocked" } });
    });
  };
  await installRoutes(page);
  await installRoutes(secondPage);
  await Promise.all([page.goto("/device"), secondPage.goto("/device")]);
  await Promise.all([
    page.getByLabel("Code from the terminal").fill("QZ4K-7HMT"),
    secondPage.getByLabel("Code from the terminal").fill("QZ4K-7HMT"),
  ]);
  await Promise.all([
    page.getByRole("button", { name: "Look up host" }).click(),
    secondPage.getByRole("button", { name: "Look up host" }).click(),
  ]);
  await Promise.all([
    page.getByRole("button", { name: "Approve", exact: true }).click(),
    secondPage.getByRole("button", { name: "Approve", exact: true }).click(),
  ]);
  await expect(page.getByRole("status")).toContainText("is connected");
  await expect(secondPage.getByRole("status")).toContainText("is connected");
  expect(await readHostPins(page)).toMatchObject([
    { hostPublicKey: HOST_PUBLIC_KEY, state: "active" },
  ]);
  expect(await readHostPins(page)).toHaveLength(1);
  await secondPage.close();
});

/** Minimal ceremony mocks: enough to reach the fingerprint screen. */
async function mockPairingCeremony(
  page: Page,
  options: { pendingStatus?: number; pendingDetail?: string } = {},
): Promise<{ lookups: Array<Record<string, unknown>> }> {
  const lookups: Array<Record<string, unknown>> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: { id: USER_ID, email: "owner@example.com", created_at: "2026-07-17T00:00:00Z" },
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
          fingerprint: fingerprint(body.public_key),
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      lookups.push(request.postDataJSON() as Record<string, unknown>);
      if (options.pendingStatus && options.pendingStatus >= 400) {
        await route.fulfill({
          status: options.pendingStatus,
          contentType: "application/json",
          json: { detail: options.pendingDetail ?? "invalid or expired code" },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  return { lookups };
}

test("the printed link lands on the fingerprint check with nothing typed", async ({ page }) => {
  const { lookups } = await mockPairingCeremony(page);

  // What `spawnd login` prints: one clickable line carrying an opaque handle.
  await page.goto("/device?ref=aD114ddf156VAJJEVzpzNAstYsHFxeorag0a2pghXqc");

  await expect(page.getByTestId("verification-code")).toBeVisible();
  await expect(page.getByText("build-host")).toBeVisible();
  // The opaque ref is what was looked up — the short code never enters a link.
  await expect
    .poll(() => lookups)
    .toEqual([{ approval_ref: "aD114ddf156VAJJEVzpzNAstYsHFxeorag0a2pghXqc" }]);

  // Prefilling is not approving: the deliberate act is still required, and
  // the fingerprint is still there to compare first.
  await expect(
    page.getByRole("button", { name: /^(?:Approve|Retry server approval)$/u }),
  ).toBeVisible();
});

test("an expired or invented handle degrades to the manual form", async ({ page }) => {
  await mockPairingCeremony(page, { pendingStatus: 404, pendingDetail: "code expired" });

  await page.goto("/device?ref=stale-handle-from-an-old-terminal");

  // Says what happened, and leaves a way forward rather than a dead screen.
  // Scoped: Next's route announcer is also role="alert".
  await expect(page.locator("p[role=alert]")).toContainText("code expired");
  await expect(page.getByLabel("Code from the terminal")).toBeVisible();
  await expect(page.getByTestId("verification-code")).toHaveCount(0);
});

test("a retyped code is accepted however the human punctuates it", async ({ page }) => {
  const { lookups } = await mockPairingCeremony(page);
  await page.goto("/device");

  const field = page.getByLabel("Code from the terminal");
  const submit = page.getByRole("button", { name: "Look up host" });

  // Nothing to send yet.
  await expect(submit).toBeDisabled();

  // Lower case, no dash, and a stray space are all the same code.
  await field.fill("qz4k 7hmt");
  await expect(field).toHaveValue("QZ4K-7HMT");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByTestId("verification-code")).toBeVisible();
  await expect.poll(() => lookups).toEqual([{ user_code: "QZ4K-7HMT" }]);
});
