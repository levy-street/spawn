import { devices, expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  handleAgentRtcSignal,
  installAgentRtcMock,
  replyReplay,
  sendPty,
  setDisplayControl,
} from "./agent-rtc-mock";
import { AGENT_B_ID, AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

async function openTerminalWithMockSocket(
  page: Page,
  options: {
    control?: { owner: boolean; cols: number; rows: number; viewers: number };
    history?: string;
    reconnect?: boolean;
    secondHistory?: string;
    noChannels?: boolean;
    noReady?: boolean;
    autoSnapshot?: boolean;
    uploadFinalAction?: "complete" | "disconnect" | "hold";
    stallUploadBackpressure?: boolean;
  } = {},
) {
  const messages: Array<string | Buffer> = [];
  const uploads: Array<{
    name: string;
    mimeType: string;
    destination: "attachments" | "cwd";
    bytes: Buffer;
  }> = [];
  await installAgentRtcMock(page, messages, {
    control: options.control,
    history: options.history,
    secondHistory: options.secondHistory,
    openChannels: !options.noChannels,
    sendReady: !options.noReady,
    autoSnapshot: options.autoSnapshot,
    uploadFinalAction: options.uploadFinalAction,
    stallUploadBackpressure: options.stallUploadBackpressure,
    onUpload: (upload) => {
      uploads.push(upload);
    },
  });
  await mockAuthenticatedApi(page, { agents: [agent()] });
  const sockets: WebSocketRoute[] = [];

  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    const index = sockets.length;
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
    if (options.reconnect && index === 1) {
      setTimeout(() => {
        void ws.close({ code: 1001, reason: "test reconnect" });
      }, 100);
    }
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  return { messages, sockets, uploads };
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
        const parsed = JSON.parse(message);
        return parsed?.kind === "request" && typeof parsed.operation === "string"
          ? { ...parsed, ...parsed.parameters, type: parsed.operation }
          : parsed;
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

test("shift+enter sends ESC CR exactly once (no trailing plain CR)", async ({ page }) => {
  // Claude-style TUIs bind ESC+CR to "insert newline"; a stray plain \r from
  // the same key press (keypress path) would submit the prompt instead.
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });
  await page.getByLabel("Agent terminal").click();
  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => binaryText(messages)).toContain("\x1b\r");
  await page.keyboard.type("x");
  await expect.poll(() => binaryText(messages)).toContain("x");
  const bytes = binaryText(messages);
  expect(bytes.replace("\x1b\r", "")).not.toContain("\r");
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
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "rtc.offer"))
    .toMatchObject({
      type: "rtc.offer",
      session_id: expect.any(String),
      agent_id: AGENT_ID,
      scope_type: "agent",
      scope_id: AGENT_ID,
      protocol: "spawn.pty",
      protocol_version: 2,
      sdp: expect.stringContaining("v=0"),
    });
});

test("opening a terminal as viewer claims control automatically", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, {
    control: { owner: false, cols: 156, rows: 38, viewers: 2 },
    history: "viewer\n",
  });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
    .toMatchObject({
      type: "take_control",
      cols: expect.any(Number),
      rows: expect.any(Number),
    });
  // Ownership is claimed optimistically, so no dimmed viewer overlay shows.
  await expect(page.getByRole("button", { name: "Take control" })).toHaveCount(0);
});

test("losing control dims the terminal and re-takes from the centered button", async ({ page }) => {
  // Opens as owner (default mock state) — the auto-claim never fires.
  const { messages } = await openTerminalWithMockSocket(page, { history: "owner\n" });
  await expect(liveTerminalRows(page)).toContainText("owner");
  expect(jsonMessages(messages).some((m) => m?.type === "take_control")).toBe(false);

  // Another session steals control: the pane dims with a centered button.
  await setDisplayControl(page, { owner: false, cols: 156, rows: 38, viewers: 2 });
  const button = page.getByRole("button", { name: "Take control" });
  await expect(button).toBeVisible();
  await expect(page.getByText("Another session has control · 156x38 · 2 viewers")).toBeVisible();

  await button.click();
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
    .toMatchObject({ type: "take_control", cols: expect.any(Number), rows: expect.any(Number) });
  await expect(button).toHaveCount(0);
});

test("owner sees additional viewer count", async ({ page }) => {
  await openTerminalWithMockSocket(page, {
    control: { owner: true, cols: 120, rows: 32, viewers: 3 },
    history: "owner\n",
  });

  await expect(page.getByText("2 viewers")).toBeVisible();
});

test("terminal sends resize and chunked uploads over direct DataChannels", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const test = (
          window as unknown as {
            __spawnRtcTest?: {
              channelReliability: (label: string) => {
                ordered: boolean;
                maxPacketLifeTime: number | null;
                maxRetransmits: number | null;
              } | null;
            };
          }
        ).__spawnRtcTest;
        return [test?.channelReliability("spawn.pty"), test?.channelReliability("spawn.ctl")];
      }),
    )
    .toEqual([
      { ordered: true, maxPacketLifeTime: null, maxRetransmits: null },
      { ordered: true, maxPacketLifeTime: null, maxRetransmits: null },
    ]);

  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "resize"))
    .toBe(true);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") });

  await expect
    .poll(() => uploads.at(-1))
    .toMatchObject({
      destination: "cwd",
      name: "note.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello file"),
    });
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "upload_start"))
    .toMatchObject({
      destination: "cwd",
      name: "note.txt",
      mime_type: "text/plain",
      total_bytes: 10,
      chunks: 1,
      capability: "00112233-4455-4677-8899-aabbccddeeff",
      agent_generation: 1,
    });
  await expect(page.getByText("Uploaded /Users/tester/projects/spawn/note.txt")).toBeVisible();
});

test("lost final upload acknowledgement is outcome_unknown and is never retried", async ({
  page,
}) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "disconnect",
  });

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "maybe.txt", mimeType: "text/plain", buffer: Buffer.from("published") });

  await expect.poll(() => uploads).toHaveLength(1);
  await expect(page.getByText(/may have been published/i)).toBeVisible();
  await page.waitForTimeout(250);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);
});

test("multi-chunk upload waits for real bufferedAmount drain", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    stallUploadBackpressure: true,
  });
  const bytes = Buffer.alloc(100_000, 0x5a);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "large.bin", mimeType: "application/octet-stream", buffer: bytes });
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "upload_start"))
    .toMatchObject({ name: "large.bin", total_bytes: bytes.length, chunks: 3 });
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);

  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { releaseUploadBackpressure: () => void } }
    ).__spawnRtcTest.releaseUploadBackpressure();
  });
  await expect.poll(() => uploads.at(-1)?.bytes.length).toBe(bytes.length);
  expect(uploads.at(-1)?.bytes.equals(bytes)).toBe(true);
});

test("removing an uploading attachment aborts it and sends upload_cancel", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    stallUploadBackpressure: true,
  });
  await page.getByLabel("Agent terminal").evaluate((terminal) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(100_000).fill(0x31)], "cancel.png", { type: "image/png" }),
    );
    terminal.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect(page.getByRole("button", { name: "Remove cancel.png" })).toBeVisible();
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "upload_start"))
    .toBe(true);
  await page.getByRole("button", { name: "Remove cancel.png" }).click();
  await expect(page.getByRole("button", { name: "Remove cancel.png" })).toHaveCount(0);
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "upload_cancel"))
    .toBe(true);
  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { releaseUploadBackpressure: () => void } }
    ).__spawnRtcTest.releaseUploadBackpressure();
  });
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);
});

test("spawn.v2 keeps keystrokes off the websocket until the DataChannel opens", async ({
  page,
}) => {
  const { messages } = await openTerminalWithMockSocket(page, { noChannels: true });

  // Viewport state belongs to spawn.ctl on v2 and must not be observable by
  // the application server. This mock deliberately never opens DataChannels.
  await page.waitForTimeout(300);
  expect(jsonMessages(messages).some((message) => message?.type === "resize")).toBe(false);
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "rtc.offer"))
    .toMatchObject({
      type: "rtc.offer",
      binding_nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("secret input");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // No DataChannel exists in the mock, so input is queued client-side; the
  // relay path must never carry it.
  expect(binaryText(messages)).toBe("");
});

test("spawn.v2 holds endpoint effects until the daemon readiness event", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { noReady: true });

  await page.waitForFunction(() => {
    return (
      window as unknown as {
        __spawnRtcTest?: { ptyReady: () => boolean };
      }
    ).__spawnRtcTest?.ptyReady();
  });
  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("queued until ready");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  expect(binaryText(messages)).toBe("");
  expect(jsonMessages(messages).some((message) => message?.kind === "request")).toBe(false);
});

test("terminal reconnect restores a fresh terminal history snapshot", async ({ page }) => {
  const { sockets } = await openTerminalWithMockSocket(page, { reconnect: true });

  await expect(liveTerminalRows(page)).toContainText("RED");
  await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
  await expect(liveTerminalRows(page)).toContainText("after reconnect");
});

test("previous-agent callbacks remain scoped to the previous terminal", async ({ page }) => {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: "FIRST-AGENT\n",
    secondHistory: "SECOND-AGENT\n",
  });
  await mockAuthenticatedApi(page, {
    agents: [agent(), agent({ id: AGENT_B_ID, name: "second" })],
  });
  const sockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    const agentId = new URL(ws.url()).searchParams.get("agent_id") ?? "unknown";
    sockets.set(agentId, ws);
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
  await expect(liveTerminalRows(page)).toContainText("FIRST-AGENT");
  expect(sockets.get(AGENT_ID)).toBeDefined();

  await page.getByRole("link", { name: /second/i }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_B_ID}$`));
  const secondAgentRows = page
    .locator('[data-testid="terminal-live-host"]:visible .xterm-rows')
    .last();
  await expect(secondAgentRows).toContainText("SECOND-AGENT");
  await sendPty(page, "STALE-FIRST-CALLBACK\n", 0);
  await page.waitForTimeout(100);

  await expect(secondAgentRows).not.toContainText("STALE-FIRST-CALLBACK");
  await expect(page.getByText("Another session has control · 222x88 · 9 viewers")).toBeHidden();
});

test("worker replay streams render exactly with geometry markers", async ({ page }) => {
  // Worker-backed agents ship history/snapshots as exact terminal byte
  // streams of geometry-tagged, self-contained chunks (CSI 8 ; rows ; cols t
  // + checkpoint repaint + output). The client must render them without the
  // transcript CR/LF reformatting — the lone-\r overwrite below would
  // split into two lines under it. The LIVE terminal seeds from the final
  // chunk alone and is never resized through historical geometries; the
  // overlay renders every chunk at its own geometry.
  const history =
    "\x1b[8;30;80t" +
    `${Array.from({ length: 40 }, (_, i) => `deep-${String(i).padStart(3, "0")}`).join("\r\n")}\r\n` +
    "progress:AAAA\rprogress:BBBB\r\n" +
    "\x1b[8;30;100t" +
    "repainted-screen-line\r\nprogress:BBBB\r\ntail-at-current-size\r\n$ ";
  await openTerminalWithMockSocket(page, { history });

  await expect(liveTerminalRows(page)).toContainText("tail-at-current-size");
  await expect(liveTerminalRows(page)).toContainText("progress:BBBB");
  await expect(liveTerminalRows(page)).not.toContainText("AAAA");
  // Last-chunk-only seeding: old-geometry content stays out of the live
  // terminal buffer entirely.
  await expect(liveTerminalRows(page)).not.toContainText("deep-039");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -600);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("deep-0");
  await expect(overlay.locator(".xterm-rows")).not.toContainText("AAAA");
});

test("terminal scrollback opens from cached snapshots without waiting for a round trip", async ({
  page,
}) => {
  const { messages } = await openTerminalWithMockSocket(page, {
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

  await sendPty(page, "\x1b[2A\rLIVE-WHILE-SCROLLED");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("LIVE-WHILE-SCROLLED");

  const beforeStreamingScroll = await scrollbackOverlayMetrics(page);
  await sendPty(
    page,
    `${Array.from({ length: 80 }, (_, i) => `STREAMING-${String(i).padStart(2, "0")}`).join("\n")}\n`,
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
  const { messages } = await openTerminalWithMockSocket(page, {
    history: `${longHistory(160)}WRONG-LIVE-BOTTOM\n`,
  });
  const terminal = page.getByLabel("Agent terminal");
  await expect(terminal).toBeVisible();
  await expect(liveTerminalRows(page)).toContainText("WRONG-LIVE-BOTTOM");

  // The live terminal has a separate endpoint-backed scrollback overlay, so
  // its native viewport must always follow the PTY tail. Reproduce the xterm
  // slow-frame failure deterministically: its scroll element can lag behind
  // the already-bottomed buffer while a live write is consumed.
  await page
    .getByTestId("terminal-live-host")
    .locator(".xterm-viewport")
    .evaluate((viewport) => {
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 40);
    });
  await sendPty(page, "\r\nDIRTY-LIVE-BYTE\n");
  await expect(liveTerminalRows(page)).toContainText("DIRTY-LIVE-BYTE");
  await expect
    .poll(async () => {
      const { scrollTop, scrollHeight, clientHeight } = await page
        .getByTestId("terminal-live-host")
        .locator(".xterm-viewport")
        .evaluate((viewport) => ({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
        }));
      const rowHeight = await liveTerminalRows(page)
        .locator("> div")
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);
      return Math.abs(scrollHeight - clientHeight - scrollTop) / Math.max(1, rowHeight);
    })
    .toBeLessThanOrEqual(1);

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "snapshot").length)
    .toBeGreaterThanOrEqual(1);

  const freshSnapshot = `${Array.from({ length: 160 }, (_, i) => {
    return `RIGHT-SNAPSHOT-${String(i).padStart(3, "0")}`;
  }).join("\n")}\nRIGHT-SNAPSHOT-BOTTOM\n`;
  await replyReplay(page, freshSnapshot);

  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".xterm-rows")).toContainText("RIGHT-SNAPSHOT-");

  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
  await expect(liveTerminalRows(page)).toContainText("RIGHT-SNAPSHOT-BOTTOM");
  // Worker checkpoints eliminate the old daemon redraw request.
  expect(jsonMessages(messages).some((message) => message?.type === "redraw")).toBe(false);
});

test("exact worker streams skip the live rewrite when closing scrollback", async ({ page }) => {
  // The live terminal consumes every byte even while the overlay is open, so
  // for worker replays there is nothing to reconcile on close — a rewrite
  // would replay recently-scrolled lines into a buffer that already has them
  // (the "repeated lines while output generates" bug).
  const history = `\x1b[8;30;100t${longHistory(60)}live-bottom\n$ `;
  const { messages } = await openTerminalWithMockSocket(page, { history });
  await expect(liveTerminalRows(page)).toContainText("live-bottom");

  await sendPty(page, "streamed-while-open-001\r\n");
  await expect(liveTerminalRows(page)).toContainText("streamed-while-open-001");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => jsonMessages(messages).filter((m) => m?.type === "snapshot").length)
    .toBeGreaterThanOrEqual(1);
  await replyReplay(page, `${history}streamed-while-open-001\r\n`);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();

  await page.mouse.wheel(0, 5000);
  await expect(overlay).not.toBeVisible();
  // No duplicate of the streamed line and no legacy redraw request.
  await page.waitForTimeout(400);
  const rows = await liveTerminalRows(page).innerText();
  expect(rows.match(/streamed-while-open-001/g)?.length ?? 0).toBe(1);
  expect(jsonMessages(messages).some((m) => m?.type === "redraw")).toBe(false);
});

test("returning from scrollback over an alternate-screen app leaves the live terminal untouched", async ({
  page,
}) => {
  const { messages } = await openTerminalWithMockSocket(page, {
    history: `\x1b[?1049h${longHistory(160).replaceAll("\n", "\r\n")}ALT-SCREEN-LIVE\r\n`,
  });

  await expect(liveTerminalRows(page)).toContainText("ALT-SCREEN-LIVE");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "snapshot").length)
    .toBeGreaterThanOrEqual(1);
  await replyReplay(page, `${longHistory(160)}FLAT-SNAPSHOT-BOTTOM\n`);

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
  const { messages } = await openTerminalWithMockSocket(page, {
    history: longHistory(160),
  });
  await expect(liveTerminalRows(page)).toContainText("history-159");
  const snapshotCount = () =>
    jsonMessages(messages).filter((message) => message?.type === "snapshot").length;
  const baseline = snapshotCount();

  // Resize changes the PTY geometry; the cached replay is now stale-width and
  // must be re-fetched in the background.
  await page.setViewportSize({ width: 700, height: 500 });
  await expect.poll(snapshotCount).toBeGreaterThan(baseline);

  // The resize invalidates the rendered overlay. Send a live chunk only
  // after its first replacement render has started: it must cross the
  // reset/write barrier exactly once instead of disappearing in that window.
  const liveDuringInitialRender = "\x1b[2A\rLIVE-DURING-INITIAL-OVERLAY-RENDER";
  await page.evaluate((text) => {
    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="terminal-scrollback-overlay"]',
    );
    const rtc = (
      window as unknown as {
        __spawnRtcTest: { sendPty: (value: string) => boolean };
      }
    ).__spawnRtcTest;
    if (!overlay) throw new Error("scrollback overlay is not mounted");
    const injectWhenBusy = () => {
      if (overlay.getAttribute("aria-busy") !== "true") return false;
      if (!rtc.sendPty(text)) throw new Error("RTC mock has no ready spawn.pty channel");
      overlay.dataset.liveInjectedDuringRender = "true";
      return true;
    };
    if (injectWhenBusy()) return;
    const observer = new MutationObserver(() => {
      if (!injectWhenBusy()) return;
      observer.disconnect();
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ["aria-busy"] });
  }, liveDuringInitialRender);
  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -30);
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-live-injected-during-render", "true");
  await expect(overlay).toHaveAttribute("aria-busy", "false");
  await expect(overlay.locator(".xterm-rows")).toContainText("LIVE-DURING-INITIAL-OVERLAY-RENDER");
  const initialRenderText = await overlay.locator(".xterm-rows").innerText();
  expect(initialRenderText.match(/LIVE-DURING-INITIAL-OVERLAY-RENDER/g)?.length ?? 0).toBe(1);

  const rewrapped = `${Array.from({ length: 160 }, (_, i) => {
    return `REWRAPPED-${String(i).padStart(3, "0")}`;
  }).join("\n")}\n`;
  await replyReplay(page, rewrapped);

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
  const { messages } = await openTerminalWithMockSocket(page, {
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
  await replyReplay(page, `${longHistory(160)}ALT SCREEN\n`);

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
    const { messages } = await openTerminalWithMockSocket(page, {
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

    await sendPty(page, "\x1b[2A\rMOBILE-LIVE-WHILE-SCROLLED");
    await expect(overlay).toBeVisible();
    await expect(liveTerminalRows(page)).toContainText("MOBILE-LIVE-WHILE-SCROLLED");
    await expect
      .poll(async () => {
        const text = await liveTerminalRows(page).innerText();
        return text.split("MOBILE-LIVE-WHILE-SCROLLED").length - 1;
      })
      .toBe(1);
    await expect(overlay).toHaveAttribute("aria-busy", "false");

    // Advance with bounded full-height touch gestures after the overlay's
    // render/drain barrier settles. A single flick's momentum is inherently
    // frame-rate-dependent; every gesture must instead either move the reader
    // toward the live edge or close the overlay there.
    for (let attempt = 0; attempt < 6 && (await overlay.isVisible()); attempt += 1) {
      const before = await scrollbackOverlayMetrics(page);
      await dragTouchInTerminal(page, 0.9, 0.1);
      await expect
        .poll(async () => {
          if (!(await overlay.isVisible())) return true;
          const after = await scrollbackOverlayMetrics(page);
          return after.scrollTop > before.scrollTop + 20;
        })
        .toBe(true);
    }
    await expect(overlay).not.toBeVisible();
    await expect
      .poll(async () => {
        const text = await liveTerminalRows(page).innerText();
        return text.split("MOBILE-LIVE-WHILE-SCROLLED").length - 1;
      })
      .toBe(1);
  });
});

test("connection chip opens a details popover", async ({ page }) => {
  await openTerminalWithMockSocket(page);

  const chip = page.getByRole("button", { name: /Connection details/ });
  await expect(chip).toHaveAttribute(
    "title",
    /terminal bytes and history are endpoint-to-endpoint/,
  );
  await chip.click();

  await expect(page.getByText("Path", { exact: true })).toBeVisible();
  await expect(page.getByText("Round trip", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/server receives signaling and disclosed activity only/),
  ).toBeVisible();
});

// Terminal emulation fidelity in the real renderer. Grid-level behavior is
// covered by tools/term-conformance/; these assert the browser-visible side
// of the same guarantees (shared config in xterm-config.mjs).

test("emoji occupy two cells (Unicode 11 width tables)", async ({ page }) => {
  await openTerminalWithMockSocket(page, { history: "\u{1F600}X\r\n" });
  const rows = liveTerminalRows(page);
  await expect(rows).toContainText("X");

  const widths = await rows.evaluate((rowsEl) => {
    const spans = Array.from(rowsEl.querySelectorAll("span"));
    const width = (text: string) =>
      spans.find((s) => s.textContent === text)?.getBoundingClientRect().width ?? 0;
    return { emoji: width("\u{1F600}"), x: width("X") };
  });
  expect(widths.x).toBeGreaterThan(0);
  // Under xterm's built-in Unicode 6 tables the emoji is one cell wide and
  // glyphs render overlapped; Unicode 11 gives it a two-cell lead.
  expect(widths.emoji / widths.x).toBeCloseTo(2, 1);
});

test("OSC 8 hyperlinks render underlined without leaking the URL", async ({ page }) => {
  await openTerminalWithMockSocket(page, {
    history: "\x1b]8;;https://example.com\x1b\\LINKTEXT\x1b]8;;\x1b\\ plain\r\n",
  });
  const rows = liveTerminalRows(page);
  await expect(rows).toContainText("LINKTEXT");
  await expect(rows).not.toContainText("example.com");

  const linkSpan = rows.locator("span", { hasText: "LINKTEXT" }).first();
  // xterm discovers/decorates links after the row itself paints. Poll the
  // computed style so parallel renderer pressure cannot sample the brief
  // undecorated frame while preserving the exact underline requirement.
  await expect
    .poll(() => linkSpan.evaluate((node) => getComputedStyle(node).textDecorationLine))
    .toContain("underline");
  const plainDecoration = await rows
    .locator("span", { hasText: "plain" })
    .first()
    .evaluate((node) => getComputedStyle(node).textDecorationLine);
  expect(plainDecoration).not.toContain("underline");
});

test("DECSCUSR switches the rendered cursor shape", async ({ page }) => {
  await openTerminalWithMockSocket(page, { history: "ready\r\n" });
  await page.getByLabel("Agent terminal").click();

  await sendPty(page, "\x1b[6 q");
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-cursor-bar")).toHaveCount(1);

  await sendPty(page, "\x1b[4 q");
  await expect(
    page.getByTestId("terminal-live-host").locator(".xterm-cursor-underline"),
  ).toHaveCount(1);

  await sendPty(page, "\x1b[2 q");
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-cursor-bar")).toHaveCount(0);
  await expect(
    page.getByTestId("terminal-live-host").locator(".xterm-cursor-underline"),
  ).toHaveCount(0);
});

test.describe("OSC 52 clipboard", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("agent writes to the system clipboard through OSC 52", async ({ page }) => {
    await openTerminalWithMockSocket(page, { history: "ready\r\n" });
    await page.getByLabel("Agent terminal").click();

    const payload = Buffer.from("hello clipboard", "utf8").toString("base64");
    await sendPty(page, `\x1b]52;c;${payload}\x07`);

    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText().catch(() => "")))
      .toBe("hello clipboard");
  });
});
