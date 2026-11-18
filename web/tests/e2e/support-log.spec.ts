import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import copy from "../../../proto/support-log-copy.json" with { type: "json" };
import type { SupportLogState } from "../../src/lib/support-log";
import {
  encodeSupportLogConsent,
  type SignedSupportLogConsent,
} from "../../src/lib/support-log-consent";
import { BROWSER_DEVICE_ID, CREATED_AT, HOST_ID, mockApp, USER_ID } from "./app-mocks";

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
function peer(): { id: string; key: string } {
  return { id: randomUUID(), key: randomBytes(32).toString("base64url") };
}
function approval(from: ReturnType<typeof peer>, to: ReturnType<typeof peer>) {
  return {
    endorser_device_id: from.id,
    endorser_public_key: from.key,
    endorsed_device_id: to.id,
    endorsed_public_key: to.key,
    signature: "A".repeat(86),
    created_at: CREATED_AT,
  };
}
async function setup(page: Page) {
  await mockApp(page, { hosts: [] });
  await page.clock.install({ time: now });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/alerts/, (ws) => {
    sockets.push(ws);
  });
  const register = page.waitForResponse((r) => r.url().endsWith("/api/browser-devices/register"));
  await page.goto("/hosts");
  const registration = await (await register).json();
  const self = { id: BROWSER_DEVICE_ID, key: registration.public_key as string };
  const edges: ReturnType<typeof approval>[] = [];
  let approvalReads = 0;
  await page.route("**/api/trust/account-endorsements", (r) => {
    approvalReads++;
    return r.fulfill({ json: edges });
  });
  return { sockets, edges, self, registration, approvalReads: () => approvalReads };
}
async function consentSigns(page: Page) {
  return page.evaluateHandle(() => {
    const calls = { consent: 0 };
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    crypto.subtle.sign = (algorithm, key, data) => {
      if (data.byteLength === 102) calls.consent++;
      return sign(algorithm, key, data);
    };
    return calls;
  });
}

async function openAccount(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
}

for (const [failure, status, body] of [
  ["404", 404, state()],
  ["network", 0, null],
  ["bad shape", 200, { ...state(), hosts: [{}] }],
  ["201", 201, state()],
  ["on without a statement", 200, { ...state(), sharing: "on" }],
  ["removed without a statement", 200, { ...state(), sharing: "off_signer_removed" }],
  ["off with an enabled statement", 200, { ...state("on"), sharing: "off" }],
  ...(["on", "off_signer_removed"] as const).map(
    (sharing) =>
      [
        `${sharing} with a disabled statement`,
        200,
        { ...state(sharing), statement: { ...state(sharing).statement, enabled: false } },
      ] as const,
  ),
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
    (time) =>
      [
        `invalid stored time ${time}`,
        200,
        { ...state("on"), statement: { ...state("on").statement, issued_at_ms: time } },
      ] as const,
  ),
] as const) {
  test(`${failure} leaves the existing Account sections and controls intact`, async ({ page }) => {
    let calls = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/support-log")) calls++;
    });
    const { approvalReads } = await setup(page);
    await page.route("**/api/support-log", (r) =>
      status === 0 ? r.abort() : r.fulfill({ status, json: body }),
    );
    expect(calls).toBe(0);
    await openAccount(page);
    await expect.poll(() => calls).toBe(1);
    expect(approvalReads()).toBe(0);
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
  const { sockets } = await setup(page);
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
  await setup(page);
  await page.route("**/api/support-log", (r) => r.fulfill({ json: data }));
  await openAccount(page);
  const block = page.getByRole("region", { name: copy.title });
  await expect(block.getByText(copy.offSignerRemoved)).toBeVisible();
  await expect(
    block.getByText(copy.needsUpdate.replace("{machine}", "This machine")),
  ).toBeVisible();
  await expect(switchFor(page)).not.toBeChecked();
  await expect(switchFor(page)).toBeEnabled();
  await expect(block.getByText(copy.cannotSign)).toHaveCount(0);
  await expect(block.getByText(copy.help)).toBeVisible();
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
    `${copy.notAccepted} ${copy.signerHelp}`,
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

test("discovery waits quietly for registration to return the local key", async ({ page }) => {
  await mockApp(page, { hosts: [] });
  await page.clock.install({ time: now });
  const keys: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/browser-devices/register", async (r) => {
    keys.push(r.request().postDataJSON().public_key);
    if (keys.length !== 1) return r.fallback();
    await pending;
    return r.fulfill({ status: 503, json: {} });
  });
  await page.route("**/api/support-log", (r) => r.fulfill({ json: state() }));
  await page.goto("/hosts");
  await openAccount(page);
  await expect.poll(() => keys.length).toBe(1);
  await expect(switchFor(page)).toBeDisabled();
  await expect(page.getByText(copy.cannotSign)).toHaveCount(0);
  const failed = page.waitForResponse((r) => r.status() === 503);
  finish();
  await (await failed).finished();
  await page.clock.runFor(50);
  await expect(switchFor(page)).toBeDisabled();
  await expect(page.getByText(copy.cannotSign)).toHaveCount(0);
  await page.clock.fastForward(90_000);
  await expect(switchFor(page)).toBeEnabled();
  expect(keys).toEqual([keys[0], keys[0]]);
  await expect(page.getByText(copy.cannotSign)).toHaveCount(0);
});

test("a successful registration retries a failed local key read", async ({ page }) => {
  const { registration } = await setup(page);
  const restore = await page.evaluateHandle(() => {
    const open = indexedDB.open;
    indexedDB.open = function (name, version) {
      if (name === "spawn-browser-device-identity") throw new Error("Key unavailable");
      return open.call(this, name, version);
    };
    return () => {
      indexedDB.open = open;
    };
  });
  await page.route("**/api/support-log", (r) => r.fulfill({ json: state() }));
  await openAccount(page);
  await expect(page.getByText(copy.failure)).toBeVisible();
  await expect(switchFor(page)).toBeDisabled();
  await restore.evaluate((restore) => restore());
  await page.route("**/api/browser-devices/register", (r) => r.fulfill({ json: registration }));
  await page.clock.fastForward(90_000);
  await expect(switchFor(page)).toBeEnabled();
  await expect(page.getByText(copy.failure)).toHaveCount(0);
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
  const { edges, self, registration, approvalReads } = await setup(page);
  let refreshes = 0;
  await page.route("**/api/browser-devices/register", (r) =>
    r.fulfill({
      json: { ...registration, last_seen_at: new Date(now + ++refreshes).toISOString() },
    }),
  );
  const refreshRegistration = async () => {
    const refreshed = page.waitForResponse((r) =>
      r.url().endsWith("/api/browser-devices/register"),
    );
    await page.clock.fastForward(90_000);
    await (await refreshed).finished();
    await page.clock.runFor(50);
  };
  const peers = Array.from({ length: 9 }, peer);
  const path = peers.map((from, i) => approval(from, peers[i - 1] ?? self));
  const branch = approval(peer(), self);
  edges.push(approval(peer(), peer()), ...[...path].reverse(), branch);
  const nearest = [...path.slice(0, 1), branch, ...path.slice(1, 8)];
  let current = state();
  await page.route("**/api/support-log", (r) =>
    r.fulfill({ json: { ...current, account_id: randomUUID() } }),
  );
  await page.route("**/api/support-log/consent", async (r) => {
    expect(r.request().method()).toBe("PUT");
    const body = r.request().postDataJSON() as SignedSupportLogConsent;
    sent.push(body);
    await gate;
    current = state(body.enabled ? "on" : "off_signer_removed");
    current.next_issued_at_ms = now + 18;
    await r.fulfill({ json: {} });
  });
  await openAccount(page);
  await expect(page.getByText(copy.empty)).toBeVisible();
  await expect(page.getByText(copy.help)).toBeVisible();
  const toggle = switchFor(page);
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: copy.confirmTitle });
  await expect(dialog).toContainText(copy.description);
  await dialog.getByRole("button", { name: copy.cancel }).click();
  expect(sent).toHaveLength(0);
  expect(approvalReads()).toBe(0);
  await toggle.click();
  await expect(dialog).toBeVisible();
  await refreshRegistration();
  await dialog.getByRole("button", { name: copy.turnOn }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(toggle).toBeDisabled();
  await toggle.evaluate((el) => (el as HTMLButtonElement).click());
  await refreshRegistration();
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
      carried_endorsements: nearest.map(
        ({ endorser_public_key, endorsed_public_key, endorsed_device_id, signature }) => ({
          account_id: USER_ID,
          endorser_public_key,
          endorsed_public_key,
          endorsed_device_id,
          signature,
        }),
      ),
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
  test(`a ${status} leaves the switch alone and reads the latest state`, async ({ page }) => {
    await setup(page);
    let reads = 0,
      puts = 0;
    await page.route("**/api/support-log", (r) => {
      reads++;
      if (status === 429 && reads === 3) return r.abort();
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
    expect(reads).toBe(3);
    expect(puts).toBe(1);
  });
}

for (const stamp of [
  now,
  now - 1,
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
    const signs = await consentSigns(page);
    await switchFor(page).click();
    await expect(page.getByText(copy.failure)).toBeVisible();
    expect(puts).toBe(0);
    expect(await signs.jsonValue()).toEqual({ consent: 0 });
  });
}

for (const failedRead of [false, true]) {
  test(`a change carries ${failedRead ? "nothing after a failed read" : "at most 64 nearest approvals"}`, async ({
    page,
  }) => {
    const { edges, self } = await setup(page);
    const first = peer();
    const peers = [first, ...Array.from({ length: 64 }, peer)];
    const nearest = peers.map((p) => approval(p, self));
    edges.push(approval(peer(), first), ...nearest);
    if (failedRead) await page.route("**/api/trust/account-endorsements", (r) => r.abort());
    let reads = 0;
    await page.route("**/api/support-log", (r) =>
      ++reads === 3 ? r.abort() : r.fulfill({ json: state("on") }),
    );
    await page.route("**/api/support-log/consent", (r) => r.fulfill({ status: 204 }));
    await openAccount(page);
    const put = page.waitForRequest((r) => r.url().endsWith("/api/support-log/consent"));
    await switchFor(page).click();
    const sent = (await put).postDataJSON() as SignedSupportLogConsent;
    expect(sent.carried_endorsements.map((e) => e.endorser_public_key)).toEqual(
      failedRead ? [] : nearest.slice(0, 64).map((e) => e.endorser_public_key),
    );
    await expect(page.getByText(copy.sent)).toBeVisible();
    await expect(switchFor(page)).toBeEnabled();
    await expect(switchFor(page)).toBeChecked();
  });
}

test("a delayed signing read cannot go behind a newer stored statement", async ({ page }) => {
  await setup(page);
  let reads = 0;
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/support-log", async (r) => {
    const data = state(++reads === 3 ? "off_signer_removed" : "on");
    if (reads === 2) await delayed;
    else if (reads === 3) data.statement!.issued_at_ms = now + 18;
    await r.fulfill({ json: data });
  });
  let puts = 0;
  await page.route("**/api/support-log/consent", (r) => {
    puts++;
    return r.abort();
  });
  const signs = await consentSigns(page);
  await openAccount(page);
  await switchFor(page).click();
  await expect.poll(() => reads).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(copy.offSignerRemoved)).toBeVisible();
  finish();
  await expect(page.getByText(copy.failure)).toBeVisible();
  expect(await signs.jsonValue()).toEqual({ consent: 0 });
  expect(puts).toBe(0);
});

test("confirmation uses a fresh time and reopening cannot replay it", async ({ page }) => {
  await setup(page);
  let reads = 0;
  let stamp = now + 1;
  const sent: SignedSupportLogConsent[] = [];
  const signs = await consentSigns(page);
  await page.route("**/api/support-log", (r) => {
    reads++;
    return r.fulfill({ json: { ...state(), next_issued_at_ms: stamp } });
  });
  await page.route("**/api/support-log/consent", (r) => {
    sent.push(r.request().postDataJSON());
    return r.fulfill({ status: 204 });
  });
  await openAccount(page);
  await switchFor(page).click();
  const dialog = page.getByRole("dialog", { name: copy.confirmTitle });
  await expect(dialog).toBeVisible();
  stamp++;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBe(2);
  stamp++;
  await dialog.getByRole("button", { name: copy.turnOn }).click();
  await expect(page.getByText(copy.sent)).toBeVisible();
  expect(sent[0]?.issued_at_ms).toBe(stamp);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await switchFor(page).click();
  await dialog.getByRole("button", { name: copy.turnOn }).click();
  await expect(page.getByText(copy.failure)).toBeVisible();
  expect(await signs.jsonValue()).toEqual({ consent: 1 });
  expect(sent).toHaveLength(1);
});

for (const status of [200, 409]) {
  test(`a late ${status} leaves another device's withdrawal on screen`, async ({ page }) => {
    const { approvalReads } = await setup(page);
    let current = state();
    let reads = 0,
      puts = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/api/support-log", (r) => {
      reads++;
      return r.fulfill({ json: current });
    });
    await page.route("**/api/support-log/consent", async (r) => {
      puts++;
      await pending;
      await r.fulfill({ status, json: state("on") });
    });
    await openAccount(page);
    await expect(switchFor(page)).toBeEnabled();
    expect(reads).toBe(1);
    expect(approvalReads()).toBe(0);
    await switchFor(page).click();
    await page
      .getByRole("dialog", { name: copy.confirmTitle })
      .getByRole("button", { name: copy.turnOn })
      .click();
    await expect.poll(() => puts).toBe(1);
    current = state("off_signer_removed");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText(copy.offSignerRemoved)).toBeVisible();
    finish();
    await expect(page.getByText(status === 409 ? copy.stale : copy.sent)).toBeVisible();
    await expect(switchFor(page)).toBeEnabled();
    await expect(switchFor(page)).not.toBeChecked();
    expect(reads).toBe(4);
    expect(approvalReads()).toBe(1);
  });
}

test("a throwing log row leaves account deletion usable", async ({ page }) => {
  await setup(page);
  const data = state();
  const rowTime = new Date(now + 27).toISOString();
  data.collections = [
    {
      id: randomUUID(),
      host_id: null,
      host_name: "",
      reason: "",
      requested_at: rowTime,
      completed_at: null,
      size_bytes: null,
      expires_at: null,
      deleted_at: null,
      state: "requested",
    },
  ];
  await page.route("**/api/support-log", (r) => r.fulfill({ json: data }));
  await page.evaluate((stamp) => {
    const format = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (...args: Parameters<typeof format>) {
      if (this.getTime() === stamp) throw new Error("Broken log row");
      return format.apply(this, args);
    };
  }, Date.parse(rowTime));
  const thrown = page.waitForEvent("console", {
    predicate: (m) => m.text().includes("Broken log row"),
  });
  await openAccount(page);
  await thrown;
  await expect(page.getByRole("region", { name: copy.title })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete account…" }).click();
  await expect(page.getByTestId("delete-account-form")).toBeVisible();
});

test("closing Account aborts its pending read before signing", async ({ page }) => {
  await setup(page);
  let reads = 0,
    puts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/support-log", async (r) => {
    if (++reads === 2) await pending;
    await r.fulfill({ json: state() });
  });
  await page.route("**/api/support-log/consent", (r) => {
    puts++;
    return r.abort();
  });
  const requestSignals = await page.evaluateHandle(() => {
    const signals: AbortSignal[] = [];
    window.fetch = new Proxy(window.fetch, {
      apply(request, receiver, args: [RequestInfo | URL, RequestInit?]) {
        const [url, init] = args;
        if (url === "/api/support-log" && init?.signal) signals.push(init.signal);
        return Reflect.apply(request, receiver, args);
      },
    });
    return signals;
  });
  const signs = await consentSigns(page);
  await openAccount(page);
  await switchFor(page).click();
  await page
    .getByRole("dialog", { name: copy.confirmTitle })
    .getByRole("button", { name: copy.turnOn })
    .click();
  await expect.poll(() => reads).toBe(2);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect.poll(() => requestSignals.evaluate((signals) => signals.at(-1)?.aborted)).toBe(true);
  release();
  expect(await signs.jsonValue()).toEqual({ consent: 0 });
  expect(puts).toBe(0);
  expect(reads).toBe(2);
});
