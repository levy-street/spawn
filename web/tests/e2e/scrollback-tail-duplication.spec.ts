import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Closing and reopening scrollback must not leave the live screen behind in
// the history. Reported as: right-click snapped to the bottom, then scrolling
// back showed three viewports of repeated content before history resumed.

const V2_MARKER = "\x1b[8;12;80t";
const V2_SENTINEL = "\x1b_sp:h1\x1b\\";
const EPOCH = "1754300000000000042";

/** A live screen tall enough to fill the terminal, as a real TUI's is. */
const TALL_SCREEN = `\x1b[H${Array.from(
  { length: 11 },
  (_, i) => `SCREEN-ROW-${String(i).padStart(2, "0")}`,
).join("\r\n")}`;

function v2Replay(lines: number) {
  const history = `${Array.from(
    { length: lines },
    (_, i) => `commit-${String(i).padStart(3, "0")}`,
  ).join("\r\n")}\r\n`;
  return `${V2_MARKER}${V2_SENTINEL}${history}${V2_MARKER}${TALL_SCREEN}`;
}

async function openDeltaTerminal(page: Page) {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: v2Replay(150),
    control: { owner: true, cols: 80, rows: 12, viewers: 1 },
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

/** Count a marker across the WHOLE overlay buffer, not just rendered rows. */
async function countInOverlayBuffer(page: Page, needle: string): Promise<number> {
  return page.evaluate(async (marker) => {
    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-viewport',
    );
    const rows = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-rows',
    );
    if (!viewport || !rows) return -1;
    // Walk the buffer a screen at a time and tally; xterm only renders what
    // is visible, so a single read cannot see duplicates further up.
    let total = 0;
    const step = viewport.clientHeight || 200;
    for (let top = 0; top <= viewport.scrollHeight; top += step) {
      viewport.scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      total += (rows.textContent ?? "").split(marker).length - 1;
    }
    return total;
  }, needle);
}

test("closing and reopening scrollback never appends the live screen to history", async ({
  page,
}) => {
  await openDeltaTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-00");

  const overlay = page.getByTestId("terminal-scrollback-overlay");

  // Three open/close cycles — what the operator did by accidentally
  // right-clicking (snap to bottom) and scrolling back up again.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await live.locator(".xterm").hover();
    await page.mouse.wheel(0, -600);
    await expect(overlay).toBeVisible();
    await page.waitForTimeout(250);
    // Back to the bottom: closes the overlay, which must erase the tail.
    await page.mouse.wheel(0, 6000);
    await expect(overlay).not.toBeVisible();
    await page.waitForTimeout(250);
    // A live repaint between cycles, as a running TUI produces.
    await sendPty(page, TALL_SCREEN);
    await page.waitForTimeout(150);
  }

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  await expect(overlay).toBeVisible();
  await page.waitForTimeout(400);

  // The live screen belongs below the history exactly once. Copies left by
  // earlier cycles are the "repeated viewports" the operator scrolled through.
  const copies = await countInOverlayBuffer(page, "SCREEN-ROW-00");
  expect(copies).toBeLessThanOrEqual(1);
});
