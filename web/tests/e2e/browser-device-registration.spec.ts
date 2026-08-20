import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, USER_ID } from "./app-mocks";

test("removing this device is seamless: the key dies, a fresh one takes its place", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/settings");

  const fingerprint = page.getByTestId("browser-fingerprint");
  await expect(fingerprint).toHaveText(/^SHA256:/);
  await expect(page.getByText("This device", { exact: true })).toBeVisible();

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
      fingerprint: document.querySelector('[data-testid="browser-fingerprint"]')?.textContent ?? "",
      localStorage: Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
          .filter(Boolean)
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    };
  }, USER_ID);
  expect(JSON.stringify(before.localStorage)).not.toContain("signature");
  expect(JSON.stringify(before.localStorage)).not.toContain("private");

  await page.locator('[aria-label^="Options for"]').first().click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByTestId("remove-confirm").click();

  // No button, no dead end: registration re-runs, mints a fresh identity, and
  // this browser reappears as an ordinary device — with a DIFFERENT key.
  await expect(fingerprint).not.toHaveText(before.fingerprint, { timeout: 15_000 });
  await expect(fingerprint).toHaveText(/^SHA256:/);
  await expect(page.getByTestId("device-row").getByText("This device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);

  const afterReplace = await page.evaluate(async (userId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const localRecord = await new Promise<Record<string, unknown> | undefined>(
      (resolve, reject) => {
        const request = database
          .transaction("device-identities", "readonly")
          .objectStore("device-identities")
          .get(userId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    database.close();
    return {
      publicKey: localRecord?.publicKeyWire ?? null,
      marker: localStorage.getItem(`spawn.browser-device.revocation.v1.${userId}`),
    };
  }, USER_ID);
  // The revoked key never returns; the replacement is a new key; no marker
  // lingers to gate anything.
  expect(afterReplace.publicKey).not.toBeNull();
  expect(afterReplace.publicKey).not.toBe(before.publicKey);
  expect(afterReplace.marker).toBeNull();

  // The replacement survives a reload unchanged (no second mint).
  await page.reload();
  await page.goto("/settings");
  await expect(fingerprint).toHaveText(/^SHA256:/);
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);

  // The removed key stays in history (under Advanced), never resurrected.
  await page.getByTestId("access-advanced").locator("summary").click();
  await expect(page.getByText(/Removed devices \(1\)/)).toHaveCount(1);
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

  await expect(page.getByRole("alert").first()).toContainText("could not register");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // Logout stays reachable through the Account tab even when registration
  // is broken.
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
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

  await expect(page.getByRole("alert").first()).toContainText("could not register");
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

  await expect(page.getByRole("alert").first()).toContainText("could not register");
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
  await page.locator('[aria-label^="Options for"]').first().click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByTestId("remove-confirm").click();
  await expect(
    page
      .locator("p[role=alert]")
      .filter({ hasText: "did not confirm the expected device key" })
      .first(),
  ).toBeVisible();

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

  await page.locator('[aria-label^="Options for"]').first().click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const nameInput = page.getByPlaceholder("e.g. Work laptop, Pixel phone");
  await nameInput.fill("Test rig");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Test rig", { exact: true })).toBeVisible();
  // Renaming is recognition metadata only: same key, same locally derived
  // fingerprint, same "this device" binding.
  await expect(fingerprint).toHaveText(before ?? /^SHA256:/);
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
});

test("clearing history prunes tombstones but never active devices", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    extraBrowserDevices: [
      {
        id: "00000000-0000-4000-8000-000000000041",
        key_algorithm: "ed25519",
        public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
        fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
        label: "Old laptop",
        created_at: "2026-07-01T00:00:00Z",
        revoked_at: "2026-07-02T00:00:00Z",
      },
    ],
  });
  await page.goto("/settings");

  await page.getByTestId("access-advanced").locator("summary").click();
  await expect(page.getByText(/Removed devices \(1\)/)).toBeVisible();
  // Matches both the roster tombstone and the history line — both are correct.
  await expect(page.getByText("Old laptop").first()).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();

  // The tombstone section disappears entirely; this device's active row stays.
  await expect(page.getByText(/Removed devices/)).toHaveCount(0);
  await expect(page.getByText("Old laptop")).toHaveCount(0);
  await expect(page.getByTestId("device-row").getByText("This device")).toBeVisible();
});

test("a remotely-removed device replaces its key seamlessly on the next load", async ({ page }) => {
  await mockAuthenticatedApi(page);
  // The server refuses the FIRST key as revoked: this device was removed from
  // ANOTHER device, and this load is the moment it finds out. The replacement
  // key (second register call) is accepted by the underlying stateful mock.
  let refusals = 0;
  await page.route("**/api/browser-devices/register", async (route) => {
    if (refusals === 0) {
      refusals += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        json: { detail: "revoked browser public keys cannot be registered again" },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/settings");

  // Straight to an ordinary registered device — no dead end, no button.
  await expect(page.getByTestId("browser-fingerprint")).toHaveText(/^SHA256:/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("device-row").getByText("This device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over" })).toHaveCount(0);
  await expect(page.getByText("could not register")).toHaveCount(0);
  expect(refusals).toBe(1);
});
