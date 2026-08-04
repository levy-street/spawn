import { expect, type Page, test } from "@playwright/test";
import {
  handleAgentRtcSignal,
  installAgentRtcMock,
  sendHistoryDelta,
  sendHistoryWipe,
  sendPty,
} from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Committed-history delta mode: when replay responses carry a history anchor,
// the scrollback overlay becomes a pure view of the worker's committed-line
// log — seeded from the replay's history section and extended ONLY by
// history_delta events. Raw live PTY bytes never enter it; the live screen is
// painted below the history at reveal time from the local live terminal.

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

test("scrollback shows committed lines only — raw scroll-off bytes never pollute it", async ({
  page,
}) => {
  await openDeltaTerminal(page);

  // Scroll the LIVE terminal with raw output that the worker never commits
  // (the mock withholds deltas for it). In the old raw-append architecture
  // these lines accumulated as xterm-native scrollback and appeared right
  // above the live screen; in delta mode they must not exist there.
  const rawLines = Array.from(
    { length: 60 },
    (_, i) => `raw-scroll-${String(i).padStart(2, "0")}`,
  ).join("\r\n");
  await sendPty(page, `${rawLines}\r\n$ `);
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-rows")).toContainText(
    "raw-scroll-59",
  );

  // Two committed batches arrive as deltas chained from the seed's anchor.
  await sendHistoryDelta(page, EPOCH, 0, "delta-line-A\r\n");
  await sendHistoryDelta(page, EPOCH, 14, "delta-line-B\r\n");

  // Open well above the seam, then walk down in sub-viewport steps until the
  // newest committed line scrolls into view (wheel-to-row mapping varies a
  // few rows run to run).
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -900);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  const rows = overlay.locator(".xterm-rows");
  for (let step = 0; step < 12; step += 1) {
    if ((await rows.textContent())?.includes("delta-line-B")) break;
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(120);
  }
  // The seam region: newest committed content directly above the live
  // screen's top. Uncommitted raw lines that scrolled off (00–1x) would sit
  // exactly here under the old architecture.
  await expect(rows).toContainText("delta-line-B");
  await expect(rows).toContainText("commit-119");
  await expect(rows).not.toContainText(/raw-scroll-0\d/);
});

test("history wipe leaves nothing to scroll to", async ({ page }) => {
  await openDeltaTerminal(page);
  await sendHistoryDelta(page, EPOCH, 0, "pre-wipe-line\r\n");
  // Let the deep post-connect refresh land first: the mock keeps serving the
  // full history text on snapshot (a real daemon's post-wipe replay is
  // empty), so a refresh racing the wipe would falsely repopulate.
  await page.waitForTimeout(2000);
  await sendHistoryWipe(page, "1754300000000000043");
  await page.waitForTimeout(300);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("terminal-scrollback-overlay")).toBeHidden();
});

test("a delta hole heals through one snapshot re-seed", async ({ page }) => {
  await openDeltaTerminal(page);
  await sendHistoryDelta(page, EPOCH, 0, "chained-delta\r\n");
  // Skip ahead: offset 500 does not chain — the client must re-anchor from a
  // fresh snapshot (the mock's autoSnapshot answers with the current anchor).
  await sendHistoryDelta(page, EPOCH, 500, "post-hole-delta\r\n");
  await page.waitForTimeout(800);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -650);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("commit-119");
});
