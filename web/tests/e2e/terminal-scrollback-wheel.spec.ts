import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

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
  await page.addInitScript(() => {
    (window as { __spawnForceWsV1?: boolean }).__spawnForceWsV1 = true;
  });
  await mockAuthenticatedApi(page, { agents: [agent()] });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    ws.send(
      JSON.stringify({ type: "display.control", owner: true, cols: 120, rows: 36, viewers: 1 }),
    );
    ws.send(JSON.stringify({ type: "history", bytes_b64: b64(`${longHistory(180)}ready\n$ `) }));
    ws.send(JSON.stringify({ type: "agent.status", status: "running" }));
    ws.onMessage((message) => {
      if (typeof message === "string") {
        const parsed = JSON.parse(message);
        if (parsed.type === "snapshot") {
          ws.send(
            JSON.stringify({
              type: "snapshot",
              bytes_b64: b64(`${longHistory(220)}snapshot-tail\n$ `),
              plain: false,
            }),
          );
        }
      }
    });
  });
  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  return sockets;
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
  const sockets = await openTerminal(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(600);
  sockets[0]?.send(Buffer.from("\r\nuploaded:audit-note.txt\r\n$ "));
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
