import { createHash } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000002";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_HOST_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HOST_PUBLIC_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

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
  // No host_key_fingerprint (mesh B5): the app derives it from the key.
  host_public_key: HOST_PUBLIC_KEY,
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

async function seedUnboundHostPins(page: Page, publicKeys: string[]): Promise<void> {
  await page.evaluate(
    async ({ keys, accountId }) => {
      const request = indexedDB.open("spawn-browser-host-pins", 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const transaction = database.transaction("host-pins", "readwrite");
        const store = transaction.objectStore("host-pins");
        for (const [index, hostPublicKey] of keys.entries()) {
          const encodedKey = `${hostPublicKey.replaceAll("-", "+").replaceAll("_", "/")}=`;
          const digest = await crypto.subtle.digest(
            "SHA-256",
            Uint8Array.from(atob(encodedKey), (c) => c.charCodeAt(0)),
          );
          const shortDigest = String.fromCharCode(...new Uint8Array(digest).slice(0, 12));
          const hostFingerprint = `SHA256:${btoa(shortDigest)
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "")}`;
          const origin = location.origin;
          store.put({
            accountId,
            approvedAtMs: 1_000 + index,
            createdAtMs: 1_000 + index,
            hostFingerprint,
            hostIds: [],
            hostPublicKey,
            origin,
            recordId: JSON.stringify([accountId, origin, hostPublicKey]),
            revokedAtMs: null,
            state: "active",
            version: 1,
          });
        }
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { keys: publicKeys, accountId: USER_ID },
  );
}

async function expectExactHostBinding(page: Page): Promise<void> {
  await expect.poll(async () => (await readHostPins(page))[0]?.hostIds).toEqual([HOST_ID]);
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
  // The primary lane: the daemon's link carries the host key as a `#k=`
  // fragment; the page verifies it invisibly and offers a single Approve.
  await page.goto(`/device?code=QZ4K-7HMT#k=${HOST_PUBLIC_KEY}`);
  await page.getByRole("button", { name: /^(?:Approve deletion-host|Retry)$/u }).click();
  await expect(page.getByTestId("ceremony-done")).toContainText("is possessed");
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
    hostResponse?: typeof host;
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
          // Keys alone, like the real approve echo (mesh B5).
          host_name: host.name,
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
    if (path === "/api/hosts" && request.method() === "GET") {
      await route.fulfill({ status: 200, json: state.hostVisible ? [host] : [] });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}` && request.method() === "GET") {
      await route.fulfill(
        state.hostVisible
          ? { status: 200, json: state.hostResponse ?? host }
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

test("response-ID substitution blocks local mutation and the route-target DELETE", async ({
  page,
}) => {
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    hostResponse: { ...host, id: OTHER_HOST_ID },
    onDelete: async (route: Route) => route.fulfill({ status: 204 }),
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  const before = JSON.stringify(await readHostPins(page));

  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.locator("p[role=alert]")).toContainText(
    "Host API response ID does not exactly match this route",
  );
  await requestHostDeletion(page);

  await expect(page.locator("p[role=alert]")).toContainText("blocked before any server DELETE");
  expect(state.deleteCalls).toBe(0);
  expect(JSON.stringify(await readHostPins(page))).toBe(before);
});

test("key substitution cannot retarget an established Host-ID binding", async ({ page }) => {
  const state: {
    deleteCalls: number;
    hostVisible: boolean;
    hostResponse?: typeof host;
    onDelete: (route: Route) => Promise<void>;
  } = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) => route.fulfill({ status: 204 }),
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  await page.goto(`/hosts/${HOST_ID}`);
  await expectExactHostBinding(page);
  const before = JSON.stringify(await readHostPins(page));

  state.hostResponse = { ...host, host_public_key: OTHER_HOST_PUBLIC_KEY };
  await page.reload();
  // The guided panel (review R-b) replaces the raw storage error: it names
  // both possibilities honestly — the owner's own reinstall/re-key cycle and
  // a substitution attack are indistinguishable — keeps connections blocked,
  // and offers exactly one exit: removal, then a fresh possession ceremony.
  // There is no "accept the new identity" control anywhere.
  const panel = page.getByTestId("host-identity-conflict");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("identity changed");
  await expect(panel).toContainText("spawnd possess");
  await expect(panel.getByRole("button")).toHaveText(/Remove this host/u);
  // Nothing was rebound or reactivated by the substituted key.
  expect(JSON.stringify(await readHostPins(page))).toBe(before);

  // The safe exit works (previously this wedged on host_id_key_conflict):
  // removal tombstones the BOUND record — the key this device actually
  // approved; the server's claimed key cannot veto a local trust withdrawal —
  // and the server DELETE proceeds, clearing the way for `spawnd possess`.
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByTestId("conflict-remove-host").click();
  await page.waitForURL("**/hosts");
  expect(state.deleteCalls).toBe(1);
  const pins = await readHostPins(page);
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({ hostPublicKey: HOST_PUBLIC_KEY, state: "revoked" });
  // NOTE (mesh B5): the old fingerprint-substitution half of this test is
  // structurally impossible now — the Host API serves no fingerprint field,
  // so the only identity a server can lie about is the key itself, covered
  // above.
});

test("deletion never revokes among multiple active unbound host pins", async ({ page }) => {
  // Since e6763f4 an unbound host may be deleted server-side (orphaned and
  // legacy hosts must be removable), but the ambiguity protection holds in a
  // stronger form: with no exact Host-ID-to-key binding there is nothing to
  // select, so NO local pin is revoked — deletion can never guess and
  // tombstone the wrong key. Both pins must survive untouched and active.
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) => route.fulfill({ status: 204 }),
  };
  await installRoutes(page, state);
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.locator("p[role=alert]")).toContainText("no locally approved host pin matches");
  await seedUnboundHostPins(page, [HOST_PUBLIC_KEY, OTHER_HOST_PUBLIC_KEY]);
  const before = JSON.stringify(await readHostPins(page));

  await requestHostDeletion(page);

  await page.waitForURL("**/hosts");
  expect(state.deleteCalls).toBe(1);
  expect(JSON.stringify(await readHostPins(page))).toBe(before);
});

test("corrupt local storage aborts host deletion before server DELETE", async ({ page }) => {
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) => route.fulfill({ status: 204 }),
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  await corruptExistingPin(page);
  const before = JSON.stringify(await readHostPins(page));
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByRole("button", { name: "Host actions" })).toBeVisible();
  await requestHostDeletion(page);

  await expect(page.locator("p[role=alert]")).toContainText("blocked before any server DELETE");
  expect(state.deleteCalls).toBe(0);
  expect(JSON.stringify(await readHostPins(page))).toBe(before);
});

test("host-detail resolution binds before a legitimate tombstone-first DELETE", async ({
  page,
}) => {
  let pinStateAtDelete: Array<Record<string, unknown>> = [];
  const state = {
    deleteCalls: 0,
    hostVisible: true,
    onDelete: async (route: Route) => {
      pinStateAtDelete = await readHostPins(page);
      await route.fulfill({ status: 204 });
    },
  };
  await installRoutes(page, state);
  await approveExactHost(page);
  await page.goto(`/hosts/${HOST_ID}`);
  await expectExactHostBinding(page);

  await requestHostDeletion(page);

  await expect(page).toHaveURL(/\/hosts$/u);
  expect(state.deleteCalls).toBe(1);
  expect(pinStateAtDelete).toMatchObject([
    { hostIds: [HOST_ID], hostPublicKey: HOST_PUBLIC_KEY, state: "revoked" },
  ]);
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
  await expectExactHostBinding(page);
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

  await page.goto(`/device?code=QZ4K-7HMT#k=${HOST_PUBLIC_KEY}`);
  await expect(page.getByTestId("local-pin-state")).toContainText("previously removed this host");
  await page.getByRole("button", { name: "Approve deletion-host" }).click();
  await expect(page.getByTestId("ceremony-done")).toContainText("is possessed");
  expect(await readHostPins(page)).toMatchObject([
    { hostIds: [HOST_ID], hostPublicKey: HOST_PUBLIC_KEY, state: "active" },
  ]);
});
