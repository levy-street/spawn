import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Resizing while scrolled back: the window changing size, or the sidebar
// collapsing, must not duplicate what the reader is looking at.

const V2_MARKER = "\x1b[8;36;120t";
const V2_SENTINEL = "\x1b_sp:h1\x1b\\";
const EPOCH = "1754300000000000042";

function v2Replay(lines: number) {
  const history = `${Array.from(
    { length: lines },
    (_, i) => `commit-${String(i).padStart(3, "0")}`,
  ).join("\r\n")}\r\n`;
  const screen = "\x1b[H\x1b[0mlive-screen-top\r\nready\r\n$ ";
  return `${V2_MARKER}${V2_SENTINEL}${history}${V2_MARKER}${screen}`;
}

async function openDeltaTerminal(page: Page) {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: v2Replay(120),
    control: { owner: true, cols: 120, rows: 36, viewers: 1 },
    autoSnapshot: true,
    historyEpoch: EPOCH,
    historyOffset: 0,
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

/**
 * How many times a marker appears at the BOTTOM of the overlay buffer.
 *
 * xterm only renders the visible viewport, so counting the rows while
 * scrolled up sees nothing of the tail. Jump to the bottom (via the DOM, so
 * no wheel event closes the overlay) and count what is actually there.
 */
async function overlayOccurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate(async (marker) => {
    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-viewport',
    );
    if (!viewport) return -1;
    viewport.scrollTop = viewport.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-rows',
    );
    return (rows?.textContent ?? "").split(marker).length - 1;
  }, needle);
}

test("resizing while scrolled back does not duplicate the live screen", async ({ page }) => {
  await openDeltaTerminal(page);
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-rows")).toContainText(
    "live-screen-top",
  );

  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("commit-");

  // The live screen is painted once below the history at reveal.
  await expect.poll(() => overlayOccurrences(page, "live-screen-top")).toBe(1);

  // Now do what a sidebar collapse or window drag does: change the size,
  // repeatedly, while the reader stays scrolled back.
  for (const width of [900, 1100, 760, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(600);

  // The reader is still in scrollback. A reflow renumbers lines, and letting
  // that collapse the view onto the live edge used to hide the overlay
  // without closing it — the reader jumped to the live screen while the wheel
  // kept scrolling a terminal they could no longer see.
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("commit-");
  expect(await overlayOccurrences(page, "live-screen-top")).toBe(1);
});

test("live output while scrolled back and resizing stays single-copy", async ({ page }) => {
  await openDeltaTerminal(page);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();

  // A busy TUI repainting its screen while the reader is scrolled back and
  // the window is being dragged — the combination the operator hit.
  for (let i = 0; i < 3; i += 1) {
    await sendPty(page, `\x1b[H\x1b[2Klive-screen-top\r\nready\r\nTICK-${i}\r\n$ `);
    await page.setViewportSize({ width: 900 + i * 120, height: 800 });
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(700);

  await expect(overlay).toBeVisible();
  expect(await overlayOccurrences(page, "live-screen-top")).toBe(1);
});
