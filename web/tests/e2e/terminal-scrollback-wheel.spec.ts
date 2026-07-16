import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Regression coverage for the wheel-scrollback overlay wedging shut after a
// window resize: xterm's Viewport can poison its buffer scroll offset with
// NaN when the overlay relayouts with a zero measured row height (upstream
// xterm.js 5.5.0 Viewport bug; Terminal.tsx heals it). The corruption only
// reproduces under slow frame timing, so keep video+trace recording ON here
// — the recording load is the trigger, not just the evidence.
test.use({ trace: "on", video: "on" });

function longHistory(lines: number) {
  return `${Array.from({ length: lines }, (_, i) => `audit-history-${String(i).padStart(3, "0")}`).join("\n")}\n`;
}

async function openTerminal(page: Page) {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: `${longHistory(180)}ready\n$ `,
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
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
}

test("wheel scrollback without resize", async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -900);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(overlay).toBeVisible();
});

test("wheel scrollback after viewport resize", async ({ page }) => {
  await openTerminal(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(600);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -900);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(overlay).toBeVisible();
});

test("wheel scrollback after resize plus live output", async ({ page }) => {
  await openTerminal(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(600);
  await sendPty(page, "\r\nuploaded:audit-note.txt\r\n$ ");
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-rows")).toContainText(
    "uploaded:audit-note.txt",
  );
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -900);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(overlay).toBeVisible();
});
