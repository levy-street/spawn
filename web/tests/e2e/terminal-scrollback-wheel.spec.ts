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

// Committed-line (v2) worker replays: geometry marker + APC sentinel +
// flowing history lines, then a second marker + self-contained screen
// repaint. The overlay must show the newest committed line immediately above
// the live screen — the repaint may not overwrite history, and history must
// not be geometry-walked.
const V2_MARKER = "[8;36;120t";
const V2_SENTINEL = "_sp:h1\\";

function v2Replay(lines: number) {
  const history = `${Array.from(
    { length: lines },
    (_, i) => `commit-${String(i).padStart(3, "0")}`,
  ).join("\r\n")}\r\n`;
  const screen = "[H[0mlive-screen-top\r\nready\r\n$ ";
  return `${V2_MARKER}${V2_SENTINEL}${history}${V2_MARKER}${screen}`;
}

async function openV2Terminal(page: Page, replay: string) {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: replay,
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

test("committed-line replay shows newest history right above the live screen", async ({ page }) => {
  await openV2Terminal(page, v2Replay(180));
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  const rows = overlay.locator(".xterm-rows");
  // Any modest scroll-up lands with the newest committed line and the top of
  // the live screen both in view: adjacency proves the screen repaint flushed
  // the viewport instead of overwriting the newest history lines.
  await expect(rows).toContainText("commit-179");
  await expect(rows).toContainText("live-screen-top");
});

test("committed-line replay with wiped history leaves nothing to scroll to", async ({ page }) => {
  // After an app-driven scrollback wipe (ESC[3J → daemon log truncation) the
  // replay's history section is empty: scrolling up must not reveal stale
  // content — there is none.
  await openV2Terminal(page, `${V2_MARKER}${V2_SENTINEL}${V2_MARKER}[Honly-screen\r\n$ `);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(1200);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeHidden();
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
