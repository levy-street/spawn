import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, USER_ID } from "./app-mocks";

test("registers, displays, revokes, cleans locally, and replaces only after explicit action", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/settings");

  const fingerprint = page.getByTestId("browser-fingerprint");
  await expect(fingerprint).toHaveText(/^SHA256:/);
  await expect(page.getByText("this browser", { exact: true })).toBeVisible();

  const before = await page.evaluate(async (userId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = database
        .transaction("device-identities", "readonly")
        .objectStore("device-identities")
        .get(userId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      publicKey: record.publicKeyWire,
      localStorage: Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
          .filter(Boolean)
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    };
  }, USER_ID);
  expect(JSON.stringify(before.localStorage)).not.toContain("signature");
  expect(JSON.stringify(before.localStorage)).not.toContain("private");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create replacement identity" })).toBeVisible();

  const afterRevoke = await page.evaluate(async (userId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const localRecord = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction("device-identities", "readonly")
        .objectStore("device-identities")
        .get(userId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      localRecord,
      marker: localStorage.getItem(`spawn.browser-device.revocation.v1.${userId}`),
    };
  }, USER_ID);
  expect(afterRevoke.localRecord).toBeUndefined();
  expect(afterRevoke.marker).toBe(`revoked:${before.publicKey}`);

  await page.reload();
  await expect(page.getByRole("button", { name: "Create replacement identity" })).toBeVisible();
  const stillAbsent = await page.evaluate(async (userId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = database
      .transaction("device-identities", "readonly")
      .objectStore("device-identities")
      .get(userId);
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result;
  }, USER_ID);
  expect(stillAbsent).toBeUndefined();

  await page.getByRole("button", { name: "Create replacement identity" }).click();
  await expect(fingerprint).toHaveText(/^SHA256:/);
  await expect(page.getByText("revoked", { exact: true })).toHaveCount(1);
});

test("registration failure stays loud while settings and logout remain accessible", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.route("**/api/browser-devices/register", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { detail: "registration temporarily unavailable" },
    });
  });
  await page.goto("/settings");

  await expect(page.getByRole("alert").first()).toContainText("registration failed");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByText("Browser devices", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry registration" })).toBeVisible();
});

test("rejects a substituted registration response", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.route("**/api/browser-devices/register", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        id: "00000000-0000-4000-8000-000000000098",
        key_algorithm: "ed25519",
        public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
        fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
        created_at: "2026-07-17T00:00:00Z",
        revoked_at: null,
      },
    });
  });
  await page.goto("/settings");

  await expect(page.getByRole("alert").first()).toContainText("registration failed");
  await expect(page.getByTestId("browser-fingerprint")).not.toBeVisible();
});

test("rejects a server fingerprint that does not match the submitted browser key", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.route("**/api/browser-devices/register", async (route) => {
    const body = route.request().postDataJSON() as { public_key: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        id: "00000000-0000-4000-8000-000000000098",
        key_algorithm: "ed25519",
        public_key: body.public_key,
        fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
        created_at: "2026-07-17T00:00:00Z",
        revoked_at: null,
      },
    });
  });
  await page.goto("/settings");

  await expect(page.getByRole("alert").first()).toContainText("registration failed");
  await expect(page.getByTestId("browser-fingerprint")).not.toBeVisible();
});

test("rejects a substituted revocation response without deleting the local key", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/settings");
  await expect(page.getByTestId("browser-fingerprint")).toHaveText(/^SHA256:/);

  await page.route("**/api/browser-devices/*/revoke", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        id: "00000000-0000-4000-8000-000000000099",
        key_algorithm: "ed25519",
        public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
        fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
        created_at: "2026-07-17T00:00:00Z",
        revoked_at: "2026-07-17T00:01:00Z",
      },
    });
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Revocation response did not confirm");

  const localKeyStillExists = await page.evaluate(async (userId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = database
      .transaction("device-identities", "readonly")
      .objectStore("device-identities")
      .get(userId);
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result !== undefined;
  }, USER_ID);
  expect(localKeyStillExists).toBe(true);
});

test("devices can be renamed for recognition without touching the key", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/settings");

  const fingerprint = page.getByTestId("browser-fingerprint");
  await expect(fingerprint).toHaveText(/^SHA256:/);
  const before = await fingerprint.textContent();

  await page.getByRole("button", { name: /^Rename/ }).click();
  const nameInput = page.getByPlaceholder("e.g. Work laptop, Pixel phone");
  await nameInput.fill("Test rig");
  await page.getByRole("button", { name: "Save name" }).click();

  await expect(page.getByText("Test rig", { exact: true })).toBeVisible();
  // Renaming is recognition metadata only: same key, same locally derived
  // fingerprint, same "this browser" binding.
  await expect(fingerprint).toHaveText(before ?? /^SHA256:/);
  await expect(page.getByText("this browser", { exact: true })).toBeVisible();
});
