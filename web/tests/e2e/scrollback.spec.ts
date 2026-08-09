import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Unified scrollback: committed history is seeded into the live terminal's
// own buffer and wheel/touch scroll it natively — one buffer, one coordinate
// space. These tests pin that contract, including the duplication scenarios
// that broke the old overlay design: seeds, deep rebuilds, and resizes must
// never leave a second copy of anything in the buffer.

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
  return messages;
}

function binaryText(messages: Array<string | Buffer>) {
  return messages
    .filter((message): message is Buffer => Buffer.isBuffer(message))
    .map((message) => message.toString("latin1"))
    .join("");
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

/** The live terminal renders exactly `term.rows` row elements, so the count of
 *  `.xterm-rows` children is the grid's current row count. A reflow (refit)
 *  changes it; a freeze-and-pan does not. */
async function gridRowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = document.querySelector('[data-testid="terminal-live-host"] .xterm-rows');
    return rows ? rows.children.length : -1;
  });
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

test("live output while scrolled back does not yank the reader to the bottom", async ({ page }) => {
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

test("the newest history line sits immediately above the live screen", async ({ page }) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(250);

  // Seam order: the last committed line, then the screen — nothing between.
  const text = await live.locator(".xterm-rows").innerText();
  const history = text.indexOf("commit-149");
  const screen = text.indexOf("SCREEN-ROW-00");
  expect(history).toBeGreaterThanOrEqual(0);
  expect(screen).toBeGreaterThan(history);
});

test("right-clicking while scrolled up keeps the reader where they were", async ({ page }) => {
  const messages = await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);

  const viewport = live.locator(".xterm-viewport");
  const before = await viewport.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThanOrEqual(0);

  const box = await live.boundingBox();
  if (!box) throw new Error("terminal not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(400);

  // The reader stays scrolled up: a click is not "take me to the bottom".
  // (With mouse tracking enabled an app would receive the click — native
  // terminal semantics — but without it, nothing is typed on the user's
  // behalf either.)
  const after = await viewport.evaluate((el) => el.scrollTop);
  expect(after).toBe(before);
  expect(binaryText(messages)).not.toContain("\x1b[<");
});

test("typing while scrolled up returns to the live edge", async ({ page }) => {
  const messages = await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  await expect(live.locator(".xterm-rows")).toContainText("commit-");

  await page.keyboard.type("x");

  await expect.poll(() => binaryText(messages)).toContain("x");
  await expect
    .poll(async () => {
      const viewport = live.locator(".xterm-viewport");
      return viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2);
    })
    .toBe(true);
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-00");
});

test("an in-band scrollback wipe (ED3) empties history", async ({ page }) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  // The app clears its scrollback; xterm applies it natively to the buffer.
  await sendPty(page, "\x1b[3J");
  await page.waitForTimeout(200);

  expect(await countInLiveBuffer(page, "commit-000")).toBe(0);
  // The visible screen survives an ED3.
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-00");
});

// Mobile: the on-screen keyboard and URL bar change the viewport HEIGHT (rows)
// constantly, at a fixed width. The contract: a rows-only change must not
// rewrap or rewrite history (wrap depends only on cols) and must never yank a
// reader who is scrolled back. Note the timing race this guards — pin/reseed
// firing during a resize's transient at-bottom — needs real-device WebRTC
// latency to surface; the synchronous mock cannot force it, so this is a
// contract/smoke check of the fixed behaviour, not a red/green repro.
test("rows-only resize churn while scrolled back keeps history single-copy", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 780 });
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(250);
  await expect(live.locator(".xterm-rows")).toContainText("commit-");
  const viewport = live.locator(".xterm-viewport");
  const scrolledTo = await viewport.evaluate((el) => el.scrollTop);

  // Keyboard open/close/open/close: same width, changing height only.
  for (const height of [520, 780, 500, 780, 540]) {
    await page.setViewportSize({ width: 420, height });
    await page.waitForTimeout(150);
  }
  // Wait past the snapshot cache-refresh debounce: a rows-only change must not
  // owe a history reseed, so no destructive rewrite should arrive to yank the
  // reader. (Before the fix, every keyboard toggle flagged a reseed and the
  // refresh that followed rewrote the buffer and dropped the reader at the
  // live edge.)
  await page.waitForTimeout(900);

  // The reader still sees history, not the live screen. Assert on rendered
  // content at a fixed time — a real guard, not a lenient poll.
  const view = await live.locator(".xterm-rows").innerText();
  expect(view).toContain("commit-");
  expect(view).not.toContain("SCREEN-ROW-00");
  // No duplication: history once, live screen never left behind in scrollback.
  expect(await countInLiveBuffer(page, "commit-000")).toBe(1);
  expect(await countInLiveBuffer(page, "SCREEN-ROW-00")).toBeLessThanOrEqual(1);
  void scrolledTo;
});

// Mobile: the on-screen keyboard shrinks visualViewport WITHOUT changing
// window.innerHeight (iOS Safari). Option 1's contract: while the keyboard is up
// the terminal FREEZES its row count and pans, so it never refits/reflows
// (rewrapping history, spilling blank bands, churning the PTY) on every
// open/close — that churn is what jammed the scrollback heal on mobile.
// setViewportSize can't model this (it moves innerHeight too), so we stub
// visualViewport and a coarse pointer.
test("soft keyboard inset freezes the grid and pans instead of reflowing", async ({ page }) => {
  await page.addInitScript(() => {
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((q: string) =>
      q.includes("pointer: coarse")
        ? {
            matches: true,
            media: q,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => true,
          }
        : realMatchMedia(q)) as typeof window.matchMedia;

    let inset = 0;
    const resizeListeners = new Set<EventListenerOrEventListenerObject>();
    const fire = (fn: EventListenerOrEventListenerObject) =>
      typeof fn === "function" ? fn(new Event("resize")) : fn.handleEvent(new Event("resize"));
    const vv = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return window.innerHeight - inset;
      },
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: (t: string, fn: EventListenerOrEventListenerObject) => {
        if (t === "resize") resizeListeners.add(fn);
      },
      removeEventListener: (_t: string, fn: EventListenerOrEventListenerObject) =>
        resizeListeners.delete(fn),
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
    (window as unknown as { __setKeyboardInset: (px: number) => void }).__setKeyboardInset = (
      px,
    ) => {
      inset = px;
      for (const fn of resizeListeners) fire(fn);
    };
  });

  const setInset = (px: number) =>
    page.evaluate(
      (p) => (window as unknown as { __setKeyboardInset: (px: number) => void }).__setKeyboardInset(p),
      px,
    );

  await page.setViewportSize({ width: 420, height: 860 });
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-00");
  await page.waitForTimeout(300);

  // Keyboard-down row count. A 380px inset would drop ~22 rows if we reflowed,
  // so there is ample headroom for a reflow to be detectable.
  const rowsBefore = await gridRowCount(page);
  expect(rowsBefore).toBeGreaterThan(20);

  // Keyboard opens: large inset, innerHeight unchanged.
  await setInset(380);
  await page.waitForTimeout(400);

  // No reflow: every row kept. The frame panned to the bottom, so the newest
  // screen row is still on-screen above where the keyboard would be.
  expect(await gridRowCount(page)).toBe(rowsBefore);
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-10");

  // Toggle open/close/open/close — the churn that used to reflow every time.
  for (const px of [0, 380, 0, 380]) {
    await setInset(px);
    await page.waitForTimeout(200);
  }
  await setInset(0);
  await page.waitForTimeout(400);

  // Geometry restored identically; history intact and single-copy.
  expect(await gridRowCount(page)).toBe(rowsBefore);
  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -3000);
  await page.waitForTimeout(300);
  expect(await countInLiveBuffer(page, "commit-000")).toBe(1);
});

test("jump-to-latest button appears when scrolled up and returns to the live edge", async ({
  page,
}) => {
  await openUnifiedTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  const jump = page.getByTestId("terminal-jump-to-latest");

  // At the live edge on connect: the button is not rendered at all.
  await expect(jump).toHaveCount(0);

  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(200);
  await expect(live.locator(".xterm-rows")).toContainText("commit-");
  await expect(jump).toBeVisible();

  // Tapping it snaps back to the live screen and the button hides again.
  await jump.click();
  await page.waitForTimeout(200);
  await expect(jump).toHaveCount(0);
  await expect(live.locator(".xterm-rows")).toContainText("SCREEN-ROW-10");
});

// Column-garble repro (#43): wide-authored committed history, re-wrapped to a
// phone width, rendered each word's first char stranded at the last column.
// The signature is a rendered row of "content … spaces … single trailing
// char". Assert no history row looks like that.
async function columnGarbledRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll<HTMLElement>(
      '[data-testid="terminal-live-host"] .xterm-rows > div',
    );
    const out: string[] = [];
    for (const row of rows) {
      const text = (row.textContent ?? "").replace(/\s+$/, "");
      if (/\S {6,}\S$/.test(text)) out.push(text);
    }
    return out;
  });
}

test("wide-authored history does not column-garble at phone width", async ({ page }) => {
  const SENTENCE =
    "capture for the duplicate content width histogram want me to pick up number forty two next or keep shaking out terminal issues first";
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: `${V2_MARKER}${V2_SENTINEL}${SENTENCE}\r\ncommit-000\r\n${V2_MARKER}\x1b[Hlive$ `,
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
  const live = page.getByTestId("terminal-live-host");
  const revealHistory = async () => {
    await live.locator(".xterm").hover();
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(350);
  };

  // Author wide (seed at a desktop width), then step down through the widths
  // the real session took (≈165 → 126 → 48 cols) so xterm reflows the
  // wide-authored history repeatedly, as it did on the phone.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  await expect(live.locator(".xterm-rows")).toContainText("live$");
  await revealHistory();
  expect(await columnGarbledRows(page)).toEqual([]);

  for (const width of [1000, 640, 390]) {
    await page.setViewportSize({ width, height: 780 });
    await page.waitForTimeout(500);
  }
  await revealHistory();
  expect(await columnGarbledRows(page)).toEqual([]);

  // And a direct open at phone width (write-path), for completeness.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.reload();
  await expect(live.locator(".xterm-rows")).toContainText("live$");
  await revealHistory();
  expect(await columnGarbledRows(page)).toEqual([]);
});

// History width integrity (the geometry-policy guarantee): committed history
// is stored as flowing logical lines, so viewing it at a narrow width wraps it
// for display only — the logical content is never lost or truncated, and it
// un-wraps when the width grows again. This is why desktop-generated history
// viewed on a phone is not permanently narrowed: the reseed re-wraps from the
// same logical lines. (The server log's append-only, read-only-on-view nature
// guarantees the other half — viewing never rewrites the stored history.)
test("history reflows across width changes without loss or duplication", async ({ page }) => {
  const LONG = `LONGLINE-${"x".repeat(200)}-END`;
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: `${V2_MARKER}${V2_SENTINEL}${LONG}\r\ncommit-000\r\n${V2_MARKER}\x1b[Hlive$ `,
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
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm-rows")).toContainText("live$");

  const fullLineOnce = async () => {
    // Concatenate the buffer with wraps joined, so a soft-wrapped long line
    // reads as one logical line regardless of width.
    await live.locator(".xterm").hover();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(300);
    const joined = await countInLiveBuffer(page, "LONGLINE-");
    return joined;
  };

  // Wide: the long line is present exactly once.
  expect(await fullLineOnce()).toBe(1);

  // Shrink to a phone width: it wraps for display but is still there once.
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(600);
  expect(await fullLineOnce()).toBe(1);

  // Grow back to desktop: it un-wraps, still present exactly once — viewing
  // narrow did not permanently narrow it.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(600);
  expect(await fullLineOnce()).toBe(1);
});
