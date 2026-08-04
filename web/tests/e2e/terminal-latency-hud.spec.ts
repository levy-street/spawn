import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

async function openTerminal(page: Page, { hud = true } = {}) {
  if (hud) {
    await page.addInitScript(() => {
      window.localStorage.setItem("spawnLatencyHud", "on");
    });
  }
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: "ready\n$ ",
    control: { owner: true, cols: 120, rows: 36, viewers: 1 },
    autoSnapshot: true,
  });
  await mockAuthenticatedApi(page, { agents: [agent()] });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
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
  await page.goto(`/agents/${AGENT_ID}`);
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm")).toBeVisible();
  await expect(live.locator(".xterm-rows")).toContainText("$");
  await live.locator(".xterm").click();
}

test("latency HUD reports keystroke echo times when enabled", async ({ page }) => {
  await openTerminal(page);
  const hud = page.getByTestId("terminal-latency-hud");
  await expect(hud).toBeVisible();
  await page.keyboard.type("a");
  await sendPty(page, "a");
  await expect(hud).toContainText("echo p50", { timeout: 5_000 });
  await expect(hud).toContainText("keys/60s");
});

test("latency HUD is absent without the flag", async ({ page }) => {
  await openTerminal(page, { hud: false });
  await page.keyboard.type("a");
  await sendPty(page, "a");
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("terminal-latency-hud")).toHaveCount(0);
});
