import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Unified scrollback (experiment): committed history is seeded into the LIVE
// terminal's own buffer and wheel/touch scroll it natively — the snapshot
// overlay never opens. These tests pin the mode's contract, including the
// duplication scenarios that historically broke the overlay: reseeds and
// resizes must never leave a second copy of anything in the buffer.

const V2_MARKER = "\x1b[8;12;80t";
const V2_SENTINEL = "\x1b_sp:h1\x1b\\";
const EPOCH = "1754300000000000042";

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

async function openUnifiedTerminal(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("spawnScrollback", "unified");
  });
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
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-rows")).toContainText(
    "SCREEN-ROW-00",
  );
}

/** Count a marker across the LIVE terminal's whole buffer by walking the
 *  viewport — xterm renders only visible rows, so one read cannot see
 *  duplicates further up. The final window clamps to the scroll limit and
 *  re-renders rows the previous window already showed; those are skipped by
 *  row arithmetic so a single bottom-of-buffer marker is never counted twice. */
async function countInLiveBuffer(page: Page, needle: string): Promise<number> {
  return page.evaluate(async (marker) => {
    const host = document.querySelector<HTMLElement>('[data-testid="terminal-live-host"]');
    const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
    const rows = host?.querySelector<HTMLElement>(".xterm-rows");
    if (!viewport || !rows) return -1;
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    let total = 0;
    let previousTop = -1;
    let top = 0;
    for (;;) {
      const target = Math.min(top, maxTop);
      viewport.scrollTop = target;
      await frames();
      const effective = viewport.scrollTop;
      const rowEls = Array.from(rows.children) as HTMLElement[];
      const rowHeight = rowEls[0]?.offsetHeight || 1;
      const overlapPx = previousTop < 0 ? 0 : previousTop + viewport.clientHeight - effective;
      const skip = Math.max(0, Math.round(overlapPx / rowHeight));
      const text = rowEls
        .slice(skip)
        .map((row) => row.textContent ?? "")
        .join("\n");
      total += text.split(marker).length - 1;
      previousTop = effective;
      if (target >= maxTop) break;
      top += viewport.clientHeight;
    }
    return total;
  }, needle);
}

test("wheel-up scrolls native history in the live terminal; the overlay never opens", async ({
  page,
}) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  const overlay = page.getByTestId("terminal-scrollback-overlay");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(300);

  // History is readable in the LIVE terminal's own rows.
  await expect(overlay).not.toBeVisible();
  await expect(live.locator(".xterm-rows")).toContainText("commit-");

  // Wheel back down returns to the live screen — same buffer throughout.
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  await expect(overlay).not.toBeVisible();
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-00");
});

test("history and screen each appear exactly once after seeding", async ({ page }) => {
  await openUnifiedTerminal(page);
  // The deep post-connect refresh may rebuild the buffer at full depth
  // shortly after connect; count after it settles.
  await page.waitForTimeout(1200);

  expect(await countInLiveBuffer(page, "commit-000")).toBe(1);
  expect(await countInLiveBuffer(page, "SCREEN-ROW-00")).toBe(1);
});

test("resizing while scrolled back keeps history single-copy", async ({ page }) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(200);
  await expect(live.locator(".xterm-rows")).toContainText("commit-");

  for (const width of [900, 1100, 760, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(600);

  expect(await countInLiveBuffer(page, "commit-000")).toBe(1);
  expect(await countInLiveBuffer(page, "SCREEN-ROW-00")).toBe(1);
});

test("live output while scrolled back does not yank the reader to the bottom", async ({
  page,
}) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(300);
  await expect(live.locator(".xterm-rows")).toContainText("commit-");

  // A busy agent keeps repainting while the reader is in history.
  for (let i = 0; i < 3; i += 1) {
    await sendPty(page, `\x1b[12;1Htick-${i}\r\n`);
    await page.waitForTimeout(200);
  }

  // Still reading history, not staring at the live screen.
  await expect(live.locator(".xterm-rows")).toContainText("commit-");
});
