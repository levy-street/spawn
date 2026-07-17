import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock } from "./agent-rtc-mock";
import {
  AGENT_B_ID,
  AGENT_ID,
  agent,
  CREATED_AT,
  mockAuthenticatedApi,
  USER_ID,
  user,
} from "./app-mocks";

const USER_B_ID = "00000000-0000-4000-8000-000000000010";
const userB = {
  id: USER_B_ID,
  email: "switch@example.com",
  created_at: CREATED_AT,
};

async function rtcConnectionCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (
      window as unknown as { __spawnRtcTest: { connectionCount: () => number } }
    ).__spawnRtcTest.connectionCount();
  });
}

async function ptyChannelStates(page: Page): Promise<RTCDataChannelState[]> {
  return page.evaluate(() => {
    return (
      window as unknown as { __spawnRtcTest: { ptyChannelStates: () => RTCDataChannelState[] } }
    ).__spawnRtcTest.ptyChannelStates();
  });
}

async function pooledHostCount(page: Page): Promise<number> {
  return page.locator("[data-live-terminal-pool-host]").count();
}

async function installTerminalScenario(page: Page) {
  const messages: Array<string | Buffer> = [];
  const closedChannels: string[] = [];
  await installAgentRtcMock(page, messages, {
    onChannelClose: (label) => {
      closedChannels.push(label);
    },
  });
  await mockAuthenticatedApi(page, {
    agents: [agent(), agent({ id: AGENT_B_ID, name: "second" })],
  });
  await page.route(`**/api/agents/${AGENT_B_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: agent({ id: AGENT_B_ID, name: "second" }),
    });
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => handleAgentRtcSignal(ws, message));
    ws.send(
      JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        binding_nonce_required: true,
      }),
    );
    ws.send(JSON.stringify({ type: "agent.status", status: "running" }));
  });
  return { closedChannels, messages, sockets };
}

async function openAgent(page: Page, agentId: string) {
  const link = page.locator(`a[href="/agents/${agentId}"]`).first();
  if (await link.count()) await link.click();
  else await page.goto(`/agents/${agentId}`);
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
  await expect(
    page.locator(`[data-live-terminal-pool-host="${agentId}"]`).getByLabel("Agent terminal"),
  ).toBeVisible();
}

test("logout closes claimed and parked pools; a later login creates only a fresh terminal", async ({
  page,
}) => {
  const { closedChannels } = await installTerminalScenario(page);
  let currentUser: typeof user | typeof userB | null = user;
  let meRequests = 0;
  await page.route("**/api/me", async (route) => {
    if (currentUser === null) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        json: { detail: "expired" },
      });
      meRequests += 1;
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { user: currentUser },
    });
    meRequests += 1;
  });
  await page.route("**/api/auth/logout", async (route) => {
    currentUser = null;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/login", async (route) => {
    currentUser = userB;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { access_token: "test-token", user: userB },
    });
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => rtcConnectionCount(page)).toBe(1);
  await openAgent(page, AGENT_B_ID);
  await expect.poll(() => rtcConnectionCount(page)).toBe(2);
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open", "open"]);
  await expect.poll(() => pooledHostCount(page)).toBe(2);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect.poll(() => closedChannels.filter((label) => label === "spawn.pty").length).toBe(2);
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => pooledHostCount(page)).toBe(0);
  await expect.poll(() => meRequests).toBeGreaterThanOrEqual(2);

  await page.getByLabel("Email").fill(userB.email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await openAgent(page, AGENT_ID);

  await expect.poll(() => rtcConnectionCount(page)).toBe(1);
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);
  await expect.poll(() => pooledHostCount(page)).toBe(1);
});

test("same-user navigation preserves the warm terminal epoch", async ({ page }) => {
  await installTerminalScenario(page);
  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => rtcConnectionCount(page)).toBe(1);

  await page.getByRole("link", { name: "Agents", exact: true }).first().click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);
  await openAgent(page, AGENT_ID);

  await expect.poll(() => rtcConnectionCount(page)).toBe(1);
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);
});

test("an expired-session 401 closes a currently claimed data channel", async ({ page }) => {
  await installTerminalScenario(page);
  let expired = false;
  await page.route("**/api/agents", async (route) => {
    if (!expired) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      json: { detail: "expired" },
    });
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);
  expired = true;

  await expect.poll(() => ptyChannelStates(page), { timeout: 8_000 }).toEqual(["closed"]);
  await expect.poll(() => pooledHostCount(page)).toBe(0);
  await expect(page).toHaveURL(/\/login$/);
});

test("registration error closes a claimed terminal and prevents replacement claims", async ({
  page,
}) => {
  await installTerminalScenario(page);
  let failRegistration = false;
  await page.route("**/api/browser-devices/register", async (route) => {
    if (!failRegistration) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { detail: "registration unavailable" },
    });
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);
  failRegistration = true;
  await page.evaluate((userId) => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `spawn.browser-device.revocation.v1.${userId}`,
      }),
    );
  }, USER_ID);

  await expect(page.getByRole("alert").first()).toContainText("registration failed");
  await expect.poll(() => ptyChannelStates(page)).toEqual(["closed"]);
  await expect.poll(() => pooledHostCount(page)).toBe(0);
  await page.locator(`a[href="/agents/${AGENT_B_ID}"]`).first().click();
  await expect.poll(() => rtcConnectionCount(page)).toBe(1);
});

test("revoking this browser closes a parked warm terminal", async ({ page }) => {
  await installTerminalScenario(page);
  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => ptyChannelStates(page)).toEqual(["open"]);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await expect.poll(() => ptyChannelStates(page)).toEqual(["closed"]);
  await expect.poll(() => pooledHostCount(page)).toBe(0);
});

test("a second tab closes on logout and creates only a fresh account-B epoch", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const peer = await context.newPage();
  const sourceRtc = await installTerminalScenario(page);
  const peerRtc = await installTerminalScenario(peer);
  let currentUser: typeof user | typeof userB | null = user;
  for (const tab of [page, peer]) {
    await tab.route("**/api/me", async (route) => {
      if (currentUser === null) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          json: { detail: "expired" },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { user: currentUser },
      });
    });
  }
  await page.route("**/api/auth/logout", async (route) => {
    currentUser = null;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/login", async (route) => {
    currentUser = userB;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { access_token: "test-token", user: userB },
    });
  });

  await Promise.all([page.goto(`/agents/${AGENT_ID}`), peer.goto(`/agents/${AGENT_ID}`)]);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect(peer.getByLabel("Agent terminal")).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(peer).toHaveURL(/\/login$/);
  await expect
    .poll(() => sourceRtc.closedChannels.filter((label) => label === "spawn.pty").length)
    .toBe(1);
  await expect
    .poll(() => peerRtc.closedChannels.filter((label) => label === "spawn.pty").length)
    .toBe(1);
  await expect.poll(() => pooledHostCount(peer)).toBe(0);

  await page.getByLabel("Email").fill(userB.email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await peer.goto(`/agents/${AGENT_ID}`);
  await expect(peer.getByRole("button", { name: "Account menu" })).toContainText(userB.email);
  await expect(peer.getByLabel("Agent terminal")).toBeVisible();
  await expect.poll(() => rtcConnectionCount(peer)).toBe(1);
  await expect.poll(() => ptyChannelStates(peer)).toEqual(["open"]);
});

test("an authoritative expiry in one tab invalidates a second tab", async ({ context, page }) => {
  const peer = await context.newPage();
  await installTerminalScenario(page);
  await installTerminalScenario(peer);
  let expired = false;
  for (const tab of [page, peer]) {
    await tab.route("**/api/me", async (route) => {
      if (expired) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          json: { detail: "expired" },
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", json: { user } });
    });
  }
  await page.route("**/api/agents", async (route) => {
    if (!expired) return await route.fallback();
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      json: { detail: "expired" },
    });
  });

  await Promise.all([page.goto(`/agents/${AGENT_ID}`), peer.goto(`/agents/${AGENT_ID}`)]);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect(peer.getByLabel("Agent terminal")).toBeVisible();
  expired = true;

  await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });
  await expect(peer).toHaveURL(/\/login$/, { timeout: 10_000 });
  await expect.poll(() => ptyChannelStates(peer)).toEqual(["closed"]);
  await expect.poll(() => pooledHostCount(peer)).toBe(0);
});

test("a peer tab revalidates after registration error instead of retaining its old epoch", async ({
  context,
  page,
}) => {
  const peer = await context.newPage();
  await installTerminalScenario(page);
  const peerRtc = await installTerminalScenario(peer);
  let failRegistration = false;
  await page.route("**/api/browser-devices/register", async (route) => {
    if (!failRegistration) return await route.fallback();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { detail: "registration unavailable" },
    });
  });

  await Promise.all([page.goto(`/agents/${AGENT_ID}`), peer.goto(`/agents/${AGENT_ID}`)]);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect(peer.getByLabel("Agent terminal")).toBeVisible();
  failRegistration = true;
  await page.evaluate((userId) => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: `spawn.browser-device.revocation.v1.${userId}` }),
    );
  }, USER_ID);

  await expect(page.getByRole("alert").first()).toContainText("registration failed");
  await expect
    .poll(() => peerRtc.closedChannels.filter((label) => label === "spawn.pty").length)
    .toBe(1);
  await expect.poll(() => rtcConnectionCount(peer)).toBe(2);
  await expect.poll(() => ptyChannelStates(peer)).toEqual(["closed", "open"]);
});

test("revocation reaches a peer even when the source tab cannot write its cleanup marker", async ({
  context,
  page,
}) => {
  const peer = await context.newPage();
  await installTerminalScenario(page);
  await installTerminalScenario(peer);
  let revoked = false;
  await page.route(/\/api\/browser-devices\/[^/]+\/revoke$/, async (route) => {
    revoked = true;
    await route.fallback();
  });
  await peer.route("**/api/browser-devices/register", async (route) => {
    if (!revoked) return await route.fallback();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      json: { detail: "browser key is revoked" },
    });
  });

  await Promise.all([page.goto(`/agents/${AGENT_ID}`), peer.goto(`/agents/${AGENT_ID}`)]);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect(peer.getByLabel("Agent terminal")).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.evaluate((userId) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key === `spawn.browser-device.revocation.v1.${userId}`) {
        throw new DOMException("marker unavailable", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, USER_ID);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByText(/server revocation succeeded/i)).toBeVisible();
  await expect.poll(() => ptyChannelStates(page)).toEqual(["closed"]);
  await expect.poll(() => ptyChannelStates(peer)).toEqual(["closed"]);
  await expect.poll(() => pooledHostCount(peer)).toBe(0);
});
