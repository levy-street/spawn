import { expect, type Page, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockApp, USER_ID } from "./app-mocks";

// #121: Chrome clears a best-effort origin's IndexedDB — the device key with
// it — when the disk runs low, and refuses `navigator.storage.persist()` by
// heuristic. A browser that was refused, on an account with no passkey, is
// told once that it may forget its approval, and where the way back is.

const KEYED_HOST = {
  ...host,
  host_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
};
const TITLE = "This browser may forget its approval";

async function answerPersist(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((answer) => {
    const storage = navigator.storage;
    Object.defineProperty(storage, "persisted", { value: async () => answer, configurable: true });
    Object.defineProperty(storage, "persist", { value: async () => answer, configurable: true });
  }, granted);
}

/** This browser holds trust for one host: it has an approval worth keeping. */
async function seedLocalHostPin(page: Page): Promise<void> {
  await page.evaluate(
    async ({ accountId, hostId, hostPublicKey }) => {
      const request = indexedDB.open("spawn-browser-host-pins", 1);
      // Whoever opens first creates the store, exactly as the app does.
      request.onupgradeneeded = () => {
        request.result.createObjectStore("host-pins", { keyPath: "recordId" });
      };
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const encodedKey = `${hostPublicKey.replaceAll("-", "+").replaceAll("_", "/")}=`;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          Uint8Array.from(atob(encodedKey), (c) => c.charCodeAt(0)),
        );
        const hostFingerprint = `SHA256:${btoa(
          String.fromCharCode(...new Uint8Array(digest).slice(0, 12)),
        )
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "")}`;
        const origin = location.origin;
        const transaction = database.transaction("host-pins", "readwrite");
        transaction.objectStore("host-pins").put({
          accountId,
          approvedAtMs: 1_000,
          createdAtMs: 1_000,
          hostFingerprint,
          hostIds: [hostId],
          hostPublicKey,
          origin,
          recordId: JSON.stringify([accountId, origin, hostPublicKey]),
          revokedAtMs: null,
          state: "active",
          version: 1,
        });
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { accountId: USER_ID, hostId: HOST_ID, hostPublicKey: KEYED_HOST.host_public_key },
  );
}

async function openApprovedBrowser(page: Page): Promise<void> {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible();
  await seedLocalHostPin(page);
  await page.reload();
}

test("a refused browser on an account without a passkey is told once, and Not now is remembered", async ({
  page,
}) => {
  await answerPersist(page, false);
  await mockApp(page, { hosts: [KEYED_HOST], hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] } });
  await openApprovedBrowser(page);

  const notice = page.getByRole("status").filter({ hasText: TITLE });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "Your browser can clear the key that marks it as approved. Add a passkey and it can get back in on its own, without another device.",
  );
  await expect(notice.getByRole("button", { name: "Add passkey" })).toBeVisible();
  await notice.getByRole("button", { name: "Not now" }).click();
  await expect(notice).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status").filter({ hasText: TITLE })).toHaveCount(0);
});

test("closing it with its X is remembered too", async ({ page }) => {
  await answerPersist(page, false);
  await mockApp(page, { hosts: [KEYED_HOST], hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] } });
  await openApprovedBrowser(page);

  const notice = page.getByRole("status").filter({ hasText: TITLE });
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status").filter({ hasText: TITLE })).toHaveCount(0);
});

test("Add passkey goes to Account, where passkeys are added", async ({ page }) => {
  await answerPersist(page, false);
  await mockApp(page, { hosts: [KEYED_HOST], hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] } });
  await openApprovedBrowser(page);

  const notice = page.getByRole("status").filter({ hasText: TITLE });
  await notice.getByRole("button", { name: "Add passkey" }).click();
  await expect(notice).toHaveCount(0);
  const passkeys = page.getByTestId("passkey-list");
  await expect(passkeys).toBeVisible();
  await expect(passkeys.getByTestId("passkey-way-back")).toHaveText(
    "A passkey lets a browser or device that has lost its approval get back in on its own.",
  );
});

test("nothing is shown when the browser keeps its storage", async ({ page }) => {
  await answerPersist(page, true);
  await mockApp(page, { hosts: [KEYED_HOST], hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] } });
  await openApprovedBrowser(page);
  await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status").filter({ hasText: TITLE })).toHaveCount(0);
});

test("nothing is shown when the account already has a passkey", async ({ page }) => {
  await answerPersist(page, false);
  await mockApp(page, { hosts: [KEYED_HOST], hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] } });
  // Registered after the app mocks, so it wins: a sealed bundle exists.
  await page.route("**/api/trust/bundle", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { sealed: "sealed-bundle", revision: 1, updated_at: "2026-11-01T00:00:00Z" },
    }),
  );
  await openApprovedBrowser(page);
  await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("status").filter({ hasText: TITLE })).toHaveCount(0);
});
