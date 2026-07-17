import { createHash } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000002";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return `SHA256:${digest.subarray(0, 12).toString("base64url")}`;
}

const host = {
  id: HOST_ID,
  name: "deletion-host",
  os: "linux",
  arch: "x86_64",
  version: "0.1.0",
  host_key_algorithm: "ed25519",
  host_public_key: HOST_PUBLIC_KEY,
  host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
  status: "online",
  last_seen_at: "2026-07-17T00:00:00Z",
  agent_count: 0,
};

async function readHostPins(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("host-pins", "readonly");
      const getAll = transaction.objectStore("host-pins").getAll();
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
    } finally {
      database.close();
    }
  });
}

async function corruptExistingPin(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = database.transaction("host-pins", "readonly").objectStore("host-pins").getAll();
      const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      const transaction = database.transaction("host-pins", "readwrite");
      transaction.objectStore("host-pins").put({ ...records[0], unknown: true });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

async function approveExactHost(page: Page): Promise<void> {
  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();
  await page
    .getByRole("button", { name: /Confirm (?:approval|reapproval)|Retry server approval/u })
    .click();
  await expect(page.getByRole("status")).toContainText("Approved daemon");
}

async function requestHostDeletion(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Host actions" }).click();
  await page.getByText(/^(?:Remove host|Retry server deletion)$/u).click();
}

async function installRoutes(
  page: Page,
  state: {
    deleteCalls: number;
    hostVisible: boolean;
    onDelete: (route: Route) => Promise<void>;
  },
): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
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
      const body = request.postDataJSON() as { public_key: string };
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
          host_name: host.name,
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      const body = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        json: {
          host_name: host.name,
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
    if (path === "/api/hosts" && request.method() === "GET") {
      await route.fulfill({ status: 200, json: state.hostVisible ? [host] : [] });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}` && request.method() === "GET") {
      await route.fulfill(
        state.hostVisible
          ? { status: 200, json: host }
          : { status: 404, json: { detail: "host not found" } },
      );
      return;
    }
    if (path === `/api/hosts/${HOST_ID}` && request.method() === "DELETE") {
      state.deleteCalls += 1;
      await state.onDelete(route);
      return;
    }
    if (path === `/api/hosts/${HOST_ID}/tools`) {
      await route.fulfill({ status: 200, json: { tools: [] } });
      return;
    }
    if (path === "/api/agents") {
      await route.fulfill({ status: 200, json: [] });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: `not mocked: ${path}` } });
  });
}

test("corrupt local storage aborts host deletion before server DELETE", async ({ page }) => {
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) => route.fulfill({ status: 204 }),
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  await corruptExistingPin(page);
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByRole("button", { name: "Host actions" })).toBeVisible();
  await requestHostDeletion(page);

  await expect(page.locator("p[role=alert]")).toContainText("blocked before any server DELETE");
  expect(state.deleteCalls).toBe(0);
});

test("server delete failure retains tombstone across disappearance, reload, retry, and exact reapproval", async ({
  page,
}) => {
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) =>
      route.fulfill({ status: 503, json: { detail: "server deletion unavailable" } }),
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  await page.goto(`/hosts/${HOST_ID}`);
  await requestHostDeletion(page);

  await expect(page.locator("p[role=alert]")).toContainText("Local host trust is revoked");
  await expect(page.getByRole("status")).toContainText("retains a revoked host/key tombstone");
  expect(state.deleteCalls).toBe(1);
  expect(await readHostPins(page)).toMatchObject([
    { hostIds: [HOST_ID], hostPublicKey: HOST_PUBLIC_KEY, state: "revoked" },
  ]);

  state.hostVisible = false;
  await page.goto("/hosts");
  await expect(page.getByText("No hosts yet")).toBeVisible();
  expect(await readHostPins(page)).toMatchObject([{ state: "revoked" }]);

  state.hostVisible = true;
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByText("This browser retains a revoked host/key tombstone.")).toBeVisible();
  await requestHostDeletion(page);
  await expect(page.locator("p[role=alert]")).toContainText("server deletion unavailable");
  expect(state.deleteCalls).toBe(2);
  expect(await readHostPins(page)).toMatchObject([{ state: "revoked" }]);

  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();
  await expect(page.getByTestId("local-pin-state")).toContainText("deletion tombstone");
  await page.getByRole("button", { name: "Confirm reapproval" }).click();
  await expect(page.getByRole("status")).toContainText("Approved daemon");
  expect(await readHostPins(page)).toMatchObject([
    { hostIds: [HOST_ID], hostPublicKey: HOST_PUBLIC_KEY, state: "active" },
  ]);
});
