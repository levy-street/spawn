import { expect, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// Reproduction: a TUI that has enabled mouse reporting (Claude Code, vim,
// tmux…) turns every click into terminal INPUT. While the reader is scrolled
// up, that input was being treated as "the user typed, jump to live" — so a
// right-click yanked them back to the bottom.

function longHistory(lines: number) {
  // The TUI enables SGR mouse reporting early, so the capture the overlay
  // renders puts the OVERLAY terminal into mouse-reporting mode too.
  return `\x1b[?1000h\x1b[?1006h${Array.from(
    { length: lines },
    (_, i) => `history-${String(i).padStart(3, "0")}`,
  ).join("\r\n")}\r\n`;
}

async function openScrolledUpTerminal(page: import("@playwright/test").Page) {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: longHistory(200),
    autoSnapshot: true,
  });
  await mockAuthenticatedApi(page, { agents: [agent()] });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    ws.onMessage((message) => {
      messages.push(message);
      handleAgentRtcSignal(ws, message);
    });
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
    "history-",
  );
  return messages;
}

function binaryText(messages: Array<string | Buffer>) {
  return messages
    .filter(Buffer.isBuffer)
    .map((message) => (message as Buffer).toString("utf8"))
    .join("");
}

test("right-clicking while scrolled up keeps the reader where they were", async ({ page }) => {
  const messages = await openScrolledUpTerminal(page);

  // The running program turns on SGR mouse reporting, as full-screen TUIs do.
  await sendPty(page, "\x1b[?1000h\x1b[?1006h");
  await page.waitForTimeout(200);

  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -600);

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  const before = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-viewport',
    );
    return element?.scrollTop ?? -1;
  });

  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(400);

  // The reader stays scrolled up: a click is not "take me to the bottom".
  await expect(overlay).toBeVisible();
  const after = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"] .xterm-viewport',
    );
    return element?.scrollTop ?? -1;
  });
  expect(after).toBe(before);
  // And nothing was typed on the user's behalf.
  expect(binaryText(messages)).not.toContain("\x1b[<");
});

test("typing while scrolled up still returns to live", async ({ page }) => {
  const messages = await openScrolledUpTerminal(page);

  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();

  // Actual input is still an unambiguous "bring me back". Typed without
  // clicking: a click would land on the overlay, which is its own terminal.
  await page.keyboard.type("x");

  await expect(overlay).not.toBeVisible();
  await expect.poll(() => binaryText(messages)).toContain("x");
});
