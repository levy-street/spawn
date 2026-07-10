import { devices, expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

async function openTerminalWithMockSocket(
  page: Page,
  options: {
    control?: { owner: boolean; cols: number; rows: number; viewers: number };
    history?: string;
    reconnect?: boolean;
    secondHistory?: string;
    rtc?: boolean;
  } = {},
) {
  await mockAuthenticatedApi(page, { agents: [agent()] });
  const messages: Array<string | Buffer> = [];
  const sockets: WebSocketRoute[] = [];

  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    const index = sockets.length;
    ws.onMessage((message) => {
      messages.push(message);
    });
    ws.send(
      JSON.stringify({
        type: "display.control",
        ...(options.control ?? { owner: true, cols: 100, rows: 30, viewers: 1 }),
      }),
    );
    if (options.rtc) {
      ws.send(JSON.stringify({ type: "rtc.config", enabled: true, ice_servers: [] }));
    }
    ws.send(
      JSON.stringify({
        type: "history",
        bytes_b64: b64(
          index === 1
            ? (options.history ?? "\x1b[31mRED\x1b[0m\n")
            : (options.secondHistory ?? "after reconnect\n"),
        ),
      }),
    );
    ws.send(JSON.stringify({ type: "agent.status", status: "running" }));
    if (options.reconnect && index === 1) {
      setTimeout(() => {
        void ws.close({ code: 1001, reason: "test reconnect" });
      }, 100);
    }
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  return { messages, sockets };
}

function binaryText(messages: Array<string | Buffer>) {
  return messages
    .filter(Buffer.isBuffer)
    .map((message) => (message as Buffer).toString("utf8"))
    .join("");
}

function jsonMessages(messages: Array<string | Buffer>) {
  return messages
    .filter((message): message is string => typeof message === "string")
    .map((message) => {
      try {
        return JSON.parse(message);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function liveTerminal(page: Page) {
  return page.getByTestId("terminal-live-host").locator(".xterm");
}

function liveTerminalRows(page: Page) {
  return page.getByTestId("terminal-live-host").locator(".xterm-rows");
}

async function scrollbackOverlayMetrics(page: Page) {
  return page
    .getByTestId("terminal-scrollback-overlay")
    .locator(".xterm-viewport")
    .evaluate((el) => {
      return {
        scrollTop: el.scrollTop,
        maxTop: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    });
}

async function dragTouchInTerminal(page: Page, startYRatio: number, endYRatio: number) {
  const box = await liveTerminal(page).boundingBox();
  if (!box) throw new Error("terminal is not visible");
  const x = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + box.height * startYRatio);
  const endY = Math.round(box.y + box.height * endYRatio);
  const client = await page.context().newCDPSession(page);

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY, id: 1 }],
  });
  for (let i = 1; i <= 10; i += 1) {
    const y = Math.round(startY + ((endY - startY) * i) / 10);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

function longHistory(lines: number) {
  return `${Array.from({ length: lines }, (_, i) => {
    return `history-${String(i).padStart(3, "0")}`;
  }).join("\n")}\n`;
}

test("terminal renders ANSI color and sends keystrokes without refresh", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page);

  await expect(liveTerminalRows(page)).toContainText("RED");
  const redColor = await liveTerminalRows(page)
    .locator("span", { hasText: "RED" })
    .evaluate((node) => {
      return window.getComputedStyle(node).color;
    });
  expect(redColor).not.toBe("rgb(229, 229, 229)");

  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("hello");

  await expect.poll(() => binaryText(messages)).toContain("hello");
});

test("terminal sends control keys without waiting for a refresh", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });

  await page.getByLabel("Agent terminal").click();
  await page.keyboard.press("Control+C");
  await page.keyboard.press("Enter");

  await expect.poll(() => binaryText(messages)).toContain("\x03");
  await expect.poll(() => binaryText(messages)).toContain("\r");
});

test("terminal attempts direct WebRTC transport when advertised", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n", rtc: true });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "rtc.offer"))
    .toMatchObject({
      type: "rtc.offer",
      session_id: expect.any(String),
      sdp: expect.stringContaining("v=0"),
    });
});

test("viewer can take display control and sends shared geometry", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, {
    control: { owner: false, cols: 156, rows: 38, viewers: 2 },
    history: "viewer\n",
  });

  await expect(page.getByText("Viewer · 156x38")).toBeVisible();
  await page.getByRole("button", { name: "Take control" }).click();

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
    .toMatchObject({
      type: "take_control",
      cols: expect.any(Number),
      rows: expect.any(Number),
    });
});

test("owner sees additional viewer count", async ({ page }) => {
  await openTerminalWithMockSocket(page, {
    control: { owner: true, cols: 120, rows: 32, viewers: 3 },
    history: "owner\n",
  });

  await expect(page.getByText("2 viewers")).toBeVisible();
});

test("terminal sends resize frames and uploads files over REST", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page);
  const uploads: Array<Record<string, unknown>> = [];
  await page.route(`**/api/agents/${AGENT_ID}/upload`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    uploads.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        agent_id: AGENT_ID,
        path: "/Users/tester/projects/spawn/note.txt",
        client_id: String(body.client_id ?? ""),
        pasted: false,
      },
    });
  });

  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "resize"))
    .toBe(true);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") });

  await expect.poll(() => uploads.at(-1)).toMatchObject({
    destination: "cwd",
    name: "note.txt",
    mime_type: "text/plain",
    bytes_b64: Buffer.from("hello file").toString("base64"),
    paste: false,
  });
  await expect(page.getByText("Uploaded /Users/tester/projects/spawn/note.txt")).toBeVisible();
});

test("terminal reconnect restores a fresh terminal history snapshot", async ({ page }) => {
  const { sockets } = await openTerminalWithMockSocket(page, { reconnect: true });

  await expect(liveTerminalRows(page)).toContainText("RED");
  await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
  await expect(liveTerminalRows(page)).toContainText("after reconnect");
});

test("terminal scrollback opens from cached snapshots without waiting for a round trip", async ({
  page,
}) => {
  const { messages, sockets } = await openTerminalWithMockSocket(page, {
    history: longHistory(160),
  });
  const terminal = page.getByLabel("Agent terminal");
  await expect(terminal).toBeVisible();

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -30);

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("history-");
  expect(jsonMessages(messages).some((message) => message?.type === "scroll")).toBe(false);

  sockets[0]?.send(Buffer.from("\x1b[2A\rLIVE-WHILE-SCROLLED"));
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("LIVE-WHILE-SCROLLED");

  const beforeStreamingScroll = await scrollbackOverlayMetrics(page);
  sockets[0]?.send(
    Buffer.from(
      Array.from({ length: 80 }, (_, i) => `STREAMING-${String(i).padStart(2, "0")}`).join("\n") +
        "\n",
    ),
  );
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () => {
      const metrics = await scrollbackOverlayMetrics(page);
      return metrics.scrollTop < beforeStreamingScroll.scrollTop - 100;
    })
    .toBe(true);
  const afterStreamingScroll = await scrollbackOverlayMetrics(page);
  await page.waitForTimeout(200);
  await expect
    .poll(async () => {
      const metrics = await scrollbackOverlayMetrics(page);
      return metrics.scrollTop <= afterStreamingScroll.scrollTop + 20;
    })
    .toBe(true);

  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
  await expect(liveTerminalRows(page)).toContainText("STREAMING-79");
  await terminal.click();
  await page.keyboard.type("z");
  await expect.poll(() => binaryText(messages)).toContain("z");
});

test("terminal reconciles stale live content when returning from a fresh scrollback snapshot", async ({
  page,
}) => {
  const { messages, sockets } = await openTerminalWithMockSocket(page, {
    history: `${longHistory(160)}WRONG-LIVE-BOTTOM\n`,
  });
  const terminal = page.getByLabel("Agent terminal");
  await expect(terminal).toBeVisible();
  await expect(liveTerminalRows(page)).toContainText("WRONG-LIVE-BOTTOM");

  sockets[0]?.send(Buffer.from("\r\nDIRTY-LIVE-BYTE\n"));
  await expect(liveTerminalRows(page)).toContainText("DIRTY-LIVE-BYTE");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "snapshot").length)
    .toBeGreaterThanOrEqual(1);

  const freshSnapshot = `${Array.from({ length: 160 }, (_, i) => {
    return `RIGHT-SNAPSHOT-${String(i).padStart(3, "0")}`;
  }).join("\n")}\nRIGHT-SNAPSHOT-BOTTOM\n`;
  sockets[0]?.send(
    JSON.stringify({
      type: "snapshot",
      bytes_b64: b64(freshSnapshot),
      plain: false,
    }),
  );

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("RIGHT-SNAPSHOT-");

  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
  await expect(liveTerminalRows(page)).toContainText("RIGHT-SNAPSHOT-BOTTOM");
  // After a local rewrite the browser asks tmux to repaint the true screen.
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "redraw"))
    .toBe(true);
});

test("returning from scrollback over an alternate-screen app leaves the live terminal untouched", async ({
  page,
}) => {
  const { messages, sockets } = await openTerminalWithMockSocket(page, {
    history: `\x1b[?1049h${longHistory(160).replaceAll("\n", "\r\n")}ALT-SCREEN-LIVE\r\n`,
  });

  await expect(liveTerminalRows(page)).toContainText("ALT-SCREEN-LIVE");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "snapshot").length)
    .toBeGreaterThanOrEqual(1);
  sockets[0]?.send(
    JSON.stringify({
      type: "snapshot",
      bytes_b64: b64(`${longHistory(160)}FLAT-SNAPSHOT-BOTTOM\n`),
      plain: false,
    }),
  );

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("history-");

  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
  // The TUI owns the alternate screen: no snapshot rewrite, no redraw nudge.
  await expect(liveTerminalRows(page)).toContainText("ALT-SCREEN-LIVE");
  await expect(liveTerminalRows(page)).not.toContainText("FLAT-SNAPSHOT-BOTTOM");
  expect(jsonMessages(messages).some((message) => message?.type === "redraw")).toBe(false);
});

test("resizing invalidates cached scrollback so history re-wraps at the new width", async ({
  page,
}) => {
  const { messages, sockets } = await openTerminalWithMockSocket(page, {
    history: longHistory(160),
  });
  await expect(liveTerminalRows(page)).toContainText("history-159");
  const snapshotCount = () =>
    jsonMessages(messages).filter((message) => message?.type === "snapshot").length;
  const baseline = snapshotCount();

  // Resize re-wraps the tmux pane; the cached capture is now stale-width and
  // must be re-fetched in the background.
  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(snapshotCount).toBeGreaterThan(baseline);

  const rewrapped = `${Array.from({ length: 160 }, (_, i) => {
    return `REWRAPPED-${String(i).padStart(3, "0")}`;
  }).join("\n")}\n`;
  sockets[0]?.send(JSON.stringify({ type: "snapshot", bytes_b64: b64(rewrapped), plain: false }));

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("REWRAPPED-");
  await expect(overlay.locator(".xterm-rows")).not.toContainText("history-");
});

test("scrollback overlay supports mouse text selection and still closes at bottom", async ({
  page,
}) => {
  await openTerminalWithMockSocket(page, {
    history: longHistory(160),
  });
  await expect(liveTerminalRows(page)).toContainText("history-159");

  // The history snapshot is cached clean, so scrollback opens locally
  // without a snapshot round trip.
  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("history-");

  // Drag across a row: the overlay terminal (not the live one) should own
  // the selection now that it receives pointer events.
  const box = await overlay.boundingBox();
  if (!box) throw new Error("overlay is not visible");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await overlay.locator(".xterm-selection div").count()) > 0)
    .toBe(true);

  // Wheel-down at the bottom still exits scrollback mode.
  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
});

test("terminal wheel in alternate screen scrolls locally instead of sending prompt arrows", async ({
  page,
}) => {
  const { messages, sockets } = await openTerminalWithMockSocket(page, {
    history: `\x1b[?1049h${longHistory(160).replaceAll("\n", "\r\n")}ALT SCREEN\r\n`,
  });

  await expect(liveTerminalRows(page)).toContainText("ALT SCREEN");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -900);

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "snapshot"))
    .toMatchObject({
      type: "snapshot",
      lines: 10000,
      plain: false,
    });
  sockets[0]?.send(
    JSON.stringify({
      type: "snapshot",
      bytes_b64: b64(`${longHistory(160)}ALT SCREEN\n`),
      plain: false,
    }),
  );

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("history-");
  await expect
    .poll(async () => {
      const metrics = await scrollbackOverlayMetrics(page);
      return metrics.maxTop > 0 && metrics.scrollTop < metrics.maxTop - 1;
    })
    .toBe(true);
  expect(binaryText(messages)).not.toContain("\x1b[A");
  expect(binaryText(messages)).not.toContain("\x1b[B");
  expect(jsonMessages(messages).some((message) => message?.type === "scroll")).toBe(false);
});

test.describe("mobile terminal touch", () => {
  const mobile = devices["iPhone 14 Pro"];
  test.use({
    deviceScaleFactor: mobile.deviceScaleFactor,
    hasTouch: mobile.hasTouch,
    isMobile: mobile.isMobile,
    userAgent: mobile.userAgent,
    viewport: mobile.viewport,
  });

  test("touch scrollback opens, stays live, and returns to live input", async ({ page }) => {
    const { messages, sockets } = await openTerminalWithMockSocket(page, {
      history: longHistory(240),
    });
    await expect(page.getByLabel("Agent terminal")).toBeVisible();

    await dragTouchInTerminal(page, 0.52, 0.6);

    const overlay = page.getByTestId("terminal-scrollback-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".xterm-rows")).toContainText("history-");
    await expect
      .poll(async () => {
        const metrics = await scrollbackOverlayMetrics(page);
        return metrics.maxTop > 0 && metrics.scrollTop < metrics.maxTop - 1;
      })
      .toBe(true);
    expect(jsonMessages(messages).some((message) => message?.type === "scroll")).toBe(false);

    sockets[0]?.send(Buffer.from("\x1b[2A\rMOBILE-LIVE-WHILE-SCROLLED"));
    await expect(overlay.locator(".xterm-rows")).toContainText("MOBILE-LIVE-WHILE-SCROLLED");

    await dragTouchInTerminal(page, 0.6, 0.35);
    await expect(overlay).not.toBeVisible();
    await expect(liveTerminalRows(page)).toContainText("MOBILE-LIVE-WHILE-SCROLLED");
  });
});
