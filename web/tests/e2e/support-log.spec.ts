import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import copy from "../../../proto/support-log-copy.json" with { type: "json" };
import type { SupportLogState } from "../../src/lib/support-log";
import {
  encodeSupportLogConsent,
  type SignedSupportLogConsent,
} from "../../src/lib/support-log-consent";
import {
  type AppMockOptions,
  BROWSER_DEVICE_ID,
  CREATED_AT,
  HOST_ID,
  mockApp,
  USER_ID,
} from "./app-mocks";

const now = Date.parse(CREATED_AT);
function state(sharing: SupportLogState["sharing"] = "off"): SupportLogState {
  return {
    sharing,
    statement:
      sharing === "off"
        ? null
        : {
            enabled: true,
            issued_at_ms: now,
            signer_device_id: BROWSER_DEVICE_ID,
            signer_device_name: null,
          },
    next_issued_at_ms: now + 17,
    retention_days: 7,
    hosts: [{ id: HOST_ID, name: "This machine", capable: false, last_seen_at: null }],
    collections: [],
  };
}
const switchFor = (page: Page) => page.getByRole("switch", { name: copy.switchLabel });
async function setup(page: Page, approved = true, options: AppMockOptions = {}) {
  await mockApp(page, { hostPins: { [HOST_ID]: approved ? [BROWSER_DEVICE_ID] : [] }, ...options });
  await page.clock.install({ time: now });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/alerts/, (ws) => {
    sockets.push(ws);
  });
  const register = page.waitForResponse((r) => r.url().endsWith("/api/browser-devices/register"));
  await page.goto("/hosts");
  await register;
  return sockets;
}
async function openAccount(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
}

for (const failure of ["404", "network", "bad shape", "201"]) {
  test(`${failure} leaves the existing Account sections and controls intact`, async ({ page }) => {
    let calls = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/support-log")) calls++;
    });
    await setup(page);
    await page.route("**/api/support-log", (r) => {
      return failure === "network"
        ? r.abort()
        : r.fulfill({
            status: failure === "bad shape" ? 200 : Number(failure),
            json: failure === "bad shape" ? { ...state(), hosts: [{}] } : state(),
          });
    });
    expect(calls).toBe(0);
    await openAccount(page);
    await expect.poll(() => calls).toBe(1);
    await page.clock.fastForward(180_000);
    const panel = page.getByRole("heading", { name: "Account", exact: true }).locator("../..");
    expect(
      await panel.locator(":scope > *").evaluateAll((nodes) =>
        nodes.map((node) => ({
          heading: node.querySelector("h2, p")?.textContent,
          buttons: [...node.querySelectorAll("button")].map((button) => button.textContent),
        })),
      ),
    ).toEqual([
      { heading: "Account", buttons: [] },
      { heading: "Passkeys", buttons: ["Add passkey"] },
      { heading: "Sessions", buttons: ["Log out", "Sign out everywhere"] },
      { heading: "Delete account", buttons: ["Delete account…"] },
    ]);
    expect(calls).toBe(1);
  });
}

test("only visible Account reads on show, window focus and another client's event", async ({
  page,
}) => {
  const sockets = await setup(page);
  let reads = 0;
  await page.route("**/api/support-log", (r) => {
    reads++;
    return r.fulfill({ json: state() });
  });
  const event = () => {
    for (const ws of sockets) ws.send(JSON.stringify({ type: "data", resource: "support-log" }));
  };
  event();
  expect(reads).toBe(0);
  await openAccount(page);
  await expect(switchFor(page)).toBeEnabled();
  await page.clock.fastForward(30_000);
  expect(reads).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBe(2);
  event();
  await expect.poll(() => reads).toBe(3);
  const visibility = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await visibility(true);
  await expect(switchFor(page)).toHaveCount(0);
  event();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(reads).toBe(3);
  await visibility(false);
  await expect(switchFor(page)).toBeEnabled();
  expect(reads).toBe(4);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  event();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.fastForward(180_000);
  expect(reads).toBe(4);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(switchFor(page)).toBeEnabled();
  await page.clock.fastForward(180_000);
  expect(reads).toBe(5);
});

test("shows the removed signer, update, ordered history and every reason", async ({ page }) => {
  const data = state("off_signer_removed");
  const base = {
    host_id: null,
    host_name: "This machine",
    requested_at: CREATED_AT,
    completed_at: CREATED_AT,
    size_bytes: 21,
    expires_at: CREATED_AT,
    deleted_at: CREATED_AT,
  };
  const states = [
    "requested",
    "dispatched",
    "collected",
    "deleted",
    "failed",
    "expired",
    "cancelled",
  ] as const;
  const declines = [
    "signer_untrusted",
    "not_consented",
    "no_log",
    "rate_limited",
    "failed",
  ] as const;
  data.collections = [
    ...states.map((state) => ({ ...base, id: randomUUID(), reason: state, state })),
    ...declines.map((decline_code) => ({
      ...base,
      id: randomUUID(),
      reason: decline_code,
      state: "declined" as const,
      decline_code,
    })),
  ];
  let puts = 0;
  await setup(page, false);
  await page.route("**/api/support-log/consent", (r) => {
    puts++;
    return r.abort();
  });
  await page.route("**/api/support-log", (r) => r.fulfill({ json: data }));
  await openAccount(page);
  const block = page.getByRole("region", { name: copy.title });
  await expect(block.getByText(copy.offSignerRemoved)).toBeVisible();
  await expect(
    block.getByText(copy.needsUpdate.replace("{machine}", "This machine")),
  ).toBeVisible();
  await expect(switchFor(page)).not.toBeChecked();
  await expect(switchFor(page)).toBeDisabled();
  await expect(block.getByText(copy.cannotSign)).toBeVisible();
  await switchFor(page).evaluate((el) => (el as HTMLButtonElement).click());
  expect(puts).toBe(0);
  const rows = block.getByRole("listitem");
  await expect(rows).toHaveCount(data.collections.length);
  const templates = [
    copy.waiting,
    copy.waiting,
    copy.kept,
    copy.deleted,
    copy.notCollected,
    copy.notCollected,
    copy.notCollected,
    copy.notAccepted,
    copy.sharingOff,
    copy.notCollected,
    copy.notCollected,
    copy.notCollected,
  ];
  const { time, date } = await page.evaluate(
    (stamp) => ({
      time: new Date(stamp).toLocaleString(),
      date: new Date(stamp).toLocaleDateString(),
    }),
    CREATED_AT,
  );
  for (const [index, row] of data.collections.entries()) {
    await expect(rows.nth(index).locator("p")).toHaveText([
      templates[index]
        .replace("{time}", time)
        .replace("{date}", date)
        .replace("{size}", "21 B")
        .replace("{machine}", "This machine"),
      copy.reason.replace("{reason}", row.reason),
    ]);
  }
});

test("a browser with a registration but no local key cannot sign", async ({ page }) => {
  await setup(page);
  await page.evaluate(async (accountId) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-device-identity");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("device-identities", "readwrite");
        tx.objectStore("device-identities").delete(accountId);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, USER_ID);
  let puts = 0;
  await page.route("**/api/support-log", (r) => r.fulfill({ json: state() }));
  await page.route("**/api/support-log/consent", (r) => {
    puts++;
    return r.abort();
  });
  await openAccount(page);
  await expect(page.getByText(copy.cannotSign)).toBeVisible();
  await expect(switchFor(page)).toBeDisabled();
  await switchFor(page).evaluate((el) => (el as HTMLButtonElement).click());
  expect(puts).toBe(0);
});

test("one confirmed on, immediate off, and the server's returned history", async ({ page }) => {
  const sent: SignedSupportLogConsent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const approvers = Array.from({ length: 66 }, () => ({
    id: randomUUID(),
    public_key: generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    key_algorithm: "ed25519",
    revoked_at: null,
    created_at: CREATED_AT,
  }));
  await setup(page, false, {
    extraBrowserDevices: approvers,
    hostPins: { [HOST_ID]: approvers.slice(1).map((d) => d.id) },
    accountEndorsements: approvers.map((d) => ({
      endorser_device_id: d.id,
      endorsed_device_id: BROWSER_DEVICE_ID,
    })),
  });
  await page.route("**/api/support-log", (r) =>
    r.fulfill({ json: { ...state(), account_id: randomUUID() } }),
  );
  await page.route("**/api/support-log/consent", async (r) => {
    expect(r.request().method()).toBe("PUT");
    const body = r.request().postDataJSON() as SignedSupportLogConsent;
    sent.push(body);
    await gate;
    const next = state(body.enabled ? "on" : "off_signer_removed");
    next.next_issued_at_ms = now + 18;
    await r.fulfill({ json: next });
  });
  await openAccount(page);
  await expect(page.getByText(copy.empty)).toBeVisible();
  const toggle = switchFor(page);
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: copy.confirmTitle });
  await expect(dialog).toContainText(copy.description);
  await dialog.getByRole("button", { name: copy.cancel }).click();
  expect(sent).toHaveLength(0);
  await toggle.click();
  await dialog.getByRole("button", { name: copy.turnOn }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(toggle).toBeDisabled();
  await toggle.evaluate((el) => (el as HTMLButtonElement).click());
  release();
  await expect(toggle).toBeChecked();
  await expect(page.getByText(copy.sent)).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(page.getByText(copy.offSignerRemoved)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(sent.map((s) => s.enabled)).toEqual([true, false]);
  for (const [i, statement] of sent.entries()) {
    expect(statement).toMatchObject({
      version: 1,
      account_id: USER_ID,
      signer_device_id: BROWSER_DEVICE_ID,
      issued_at_ms: now + 17 + i,
      carried_endorsements: approvers.slice(1, 65).map((d) => ({
        account_id: USER_ID,
        endorser_public_key: d.public_key,
        endorsed_device_id: BROWSER_DEVICE_ID,
        endorsed_public_key: statement.signer_public_key,
        signature: "A".repeat(86),
      })),
    });
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(statement.signer_public_key, "base64url"),
      "Ed25519",
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        key,
        Buffer.from(statement.signature, "base64url"),
        encodeSupportLogConsent(statement),
      ),
    ).toBe(true);
  }
});

for (const [status, message] of [
  [403, copy.removed],
  [409, copy.stale],
  [429, copy.wait.replace("{seconds}", "19")],
  [500, copy.failure],
] as const) {
  test(`a ${status} leaves the switch alone and only stale reads again`, async ({ page }) => {
    await setup(page);
    let reads = 0,
      puts = 0;
    await page.route("**/api/support-log", (r) => {
      reads++;
      return r.fulfill({ json: state("on") });
    });
    await page.route("**/api/support-log/consent", (r) => {
      puts++;
      return r.fulfill({ status, json: { detail: { retry_after_seconds: 19 } } });
    });
    await openAccount(page);
    await switchFor(page).click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(switchFor(page)).toBeEnabled();
    await expect(switchFor(page)).toBeChecked();
    expect(reads).toBe(status === 409 ? 2 : 1);
    expect(puts).toBe(1);
  });
}

for (const stamp of [
  now - 86_400_001,
  now + 90_000_000,
  Number.MAX_SAFE_INTEGER + 1,
  { code: "timestamp_overflow" },
]) {
  test(`unusable signing time ${JSON.stringify(stamp)} sends nothing`, async ({ page }) => {
    await setup(page);
    let puts = 0;
    await page.route("**/api/support-log", (r) =>
      r.fulfill({ json: { ...state("on"), next_issued_at_ms: stamp } }),
    );
    await page.route("**/api/support-log/consent", (r) => {
      puts++;
      return r.abort();
    });
    await openAccount(page);
    await expect(switchFor(page)).toBeEnabled();
    const signs = await page.evaluateHandle(() => {
      const calls = { consent: 0 };
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      crypto.subtle.sign = (algorithm, key, data) => {
        if (data.byteLength === 102) calls.consent++;
        return sign(algorithm, key, data);
      };
      return calls;
    });
    await switchFor(page).click();
    await expect(page.getByText(copy.failure)).toBeVisible();
    expect(puts).toBe(0);
    expect(await signs.jsonValue()).toEqual({ consent: 0 });
  });
}
