import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  devices,
  expect,
  type Page,
  type TestInfo,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

type WireMessage = string | Buffer;

type SocketEvent =
  | { type: "binary"; bytes: number; textPreview: string }
  | { type: "json"; message: unknown }
  | { type: "command"; command: string }
  | { type: "control"; name: string };

type Observation = {
  label: string;
  terminalBox: Box | null;
  liveBox: Box | null;
  overlayVisible: boolean;
  overlayScroll: { scrollTop: number; maxTop: number } | null;
  activeElement: string;
  textTail: string;
};

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function longHistory(lines: number) {
  return `${Array.from({ length: lines }, (_, i) => {
    return `audit-history-${String(i).padStart(3, "0")}`;
  }).join("\n")}\n`;
}

function binaryText(messages: WireMessage[]) {
  return messages
    .filter(Buffer.isBuffer)
    .map((message) => (message as Buffer).toString("utf8"))
    .join("");
}

function jsonMessages(messages: WireMessage[]) {
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
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  const visible = await overlay.isVisible().catch(() => false);
  if (!visible) return null;
  return overlay.locator(".xterm-viewport").evaluate((el) => {
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

async function watchPageHealth(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
  });
  return { consoleErrors, pageErrors };
}

async function observeTerminal(page: Page, label: string): Promise<Observation> {
  const text = await liveTerminalRows(page)
    .innerText()
    .catch(() => "");
  const overlayVisible = await page
    .getByTestId("terminal-scrollback-overlay")
    .isVisible()
    .catch(() => false);

  return {
    label,
    terminalBox: normalizeBox(await page.getByLabel("Agent terminal").boundingBox()),
    liveBox: normalizeBox(await liveTerminal(page).boundingBox()),
    overlayVisible,
    overlayScroll: await scrollbackOverlayMetrics(page),
    activeElement: await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return "";
      return [
        active.tagName.toLowerCase(),
        active.getAttribute("aria-label"),
        active.getAttribute("data-testid"),
        active.getAttribute("class"),
      ]
        .filter(Boolean)
        .join(" ");
    }),
    textTail: text.slice(-2_000),
  };
}

function normalizeBox(box: Box | null): Box | null {
  if (!box) return null;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

async function attachAuditReport(
  testInfo: TestInfo,
  report: {
    observations: Observation[];
    socketEvents: SocketEvent[];
    messages: WireMessage[];
    consoleErrors: string[];
    pageErrors: string[];
  },
) {
  const body = Buffer.from(
    JSON.stringify(
      {
        observations: report.observations,
        socketEvents: report.socketEvents,
        frameSummary: {
          binaryBytes: Buffer.byteLength(binaryText(report.messages), "utf8"),
          resizeFrames: jsonMessages(report.messages).filter(
            (message) => message?.type === "resize",
          ).length,
          uploadFrames: jsonMessages(report.messages).filter(
            (message) => message?.type === "upload",
          ).length,
          snapshotFrames: jsonMessages(report.messages).filter(
            (message) => message?.type === "snapshot",
          ).length,
          takeControlFrames: jsonMessages(report.messages).filter(
            (message) => message?.type === "take_control",
          ).length,
        },
        consoleErrors: report.consoleErrors,
        pageErrors: report.pageErrors,
      },
      null,
      2,
    ),
  );
  const reportPath = testInfo.outputPath("terminal-usability-report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, body);
  await testInfo.attach("terminal-usability-report.json", {
    path: reportPath,
    contentType: "application/json",
  });
}

async function attachFinalScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function openAuditedTerminal(
  page: Page,
  options: {
    control?: { owner: boolean; cols: number; rows: number; viewers: number };
    history?: string;
    reconnectHistory?: string;
  } = {},
) {
  await mockAuthenticatedApi(page, { agents: [agent()] });
  const messages: WireMessage[] = [];
  const sockets: WebSocketRoute[] = [];
  const socketEvents: SocketEvent[] = [];

  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    let commandBuffer = "";
    const index = sockets.length;

    const write = (value: string) => ws.send(Buffer.from(value));
    const emitPrompt = () => write("\r\n$ ");
    const sendDisplayControl = (
      control = options.control ?? { owner: true, cols: 120, rows: 36, viewers: 1 },
    ) => {
      ws.send(JSON.stringify({ type: "display.control", ...control }));
    };

    const submitCommand = () => {
      const command = commandBuffer;
      commandBuffer = "";
      socketEvents.push({ type: "command", command });
      if (command.trim()) {
        write(`\r\naudit:${command.replaceAll("\t", "<TAB>")}\r\n$ `);
      } else {
        emitPrompt();
      }
    };

    const handleInput = (text: string) => {
      socketEvents.push({
        type: "binary",
        bytes: Buffer.byteLength(text),
        textPreview: text.slice(0, 80),
      });
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === "\x1b") {
          const sequence = text.slice(i, i + 3);
          if (sequence === "\x1b[A") {
            socketEvents.push({ type: "control", name: "ArrowUp" });
            write("\r\nhistory:previous-command\r\n$ ");
            i += 2;
            continue;
          }
          if (["\x1b[B", "\x1b[C", "\x1b[D"].includes(sequence)) {
            socketEvents.push({ type: "control", name: `Arrow${sequence.at(2) ?? ""}` });
            i += 2;
            continue;
          }
          socketEvents.push({ type: "control", name: "Escape" });
          continue;
        }
        if (char === "\x03") {
          socketEvents.push({ type: "control", name: "Ctrl-C" });
          commandBuffer = "";
          write("\r\n^C\r\n$ ");
          continue;
        }
        if (char === "\r" || char === "\n") {
          submitCommand();
          continue;
        }
        if (char === "\t") {
          socketEvents.push({ type: "control", name: "Tab" });
          commandBuffer += "\t";
          write("\t");
          continue;
        }
        commandBuffer += char;
        write(char);
      }
    };

    ws.onMessage((message) => {
      messages.push(message);
      if (typeof message === "string") {
        const parsed = JSON.parse(message);
        socketEvents.push({ type: "json", message: parsed });
        if (parsed.type === "upload") {
          write(`\r\nuploaded:${parsed.name}\r\n$ `);
        }
        if (parsed.type === "snapshot") {
          ws.send(
            JSON.stringify({
              type: "snapshot",
              bytes_b64: b64(`${longHistory(220)}snapshot-tail\n$ `),
              plain: false,
            }),
          );
        }
        if (parsed.type === "take_control") {
          sendDisplayControl({ owner: true, cols: parsed.cols, rows: parsed.rows, viewers: 2 });
        }
        return;
      }
      handleInput(message.toString("utf8"));
    });

    sendDisplayControl();
    ws.send(
      JSON.stringify({
        type: "history",
        bytes_b64: b64(
          index === 1
            ? (options.history ?? "audit-ready\n$ ")
            : (options.reconnectHistory ?? "audit-reconnected\n$ "),
        ),
      }),
    );
    ws.send(JSON.stringify({ type: "agent.status", status: "running" }));
  });

  await page.goto(`/agents/${AGENT_ID}`);
  await expect(page.getByLabel("Agent terminal")).toBeVisible();
  return { messages, sockets, socketEvents };
}

test.use({
  screenshot: "on",
  trace: "on",
  video: "on",
  viewport: { width: 1440, height: 900 },
});

test.describe("terminal usability audit", () => {
  test.skip(process.env.SPAWN_TERMINAL_AUDIT !== "1", "Run with `bun run audit:terminal`.");

  test("desktop common-use terminal session records artifacts and validates health", async ({
    page,
  }, testInfo) => {
    const health = await watchPageHealth(page);
    const observations: Observation[] = [];
    const { messages, sockets, socketEvents } = await openAuditedTerminal(page, {
      history: `${longHistory(180)}audit-ready\n$ `,
    });

    await expect(liveTerminalRows(page)).toBeVisible();
    observations.push(await observeTerminal(page, "loaded"));

    const terminalBox = await page.getByLabel("Agent terminal").boundingBox();
    expect(terminalBox?.width).toBeGreaterThan(800);
    expect(terminalBox?.height).toBeGreaterThan(400);

    await page.getByLabel("Agent terminal").click();
    await page.keyboard.type("whoami");
    await page.keyboard.press("Enter");
    await expect(liveTerminalRows(page)).toContainText("audit:whoami");
    await expect.poll(() => binaryText(messages)).toContain("whoami");
    observations.push(await observeTerminal(page, "raw command submitted"));

    await page.keyboard.type("long running command");
    await page.keyboard.press("Control+C");
    await expect(liveTerminalRows(page)).toContainText("^C");
    await expect.poll(() => binaryText(messages)).toContain("\x03");
    observations.push(await observeTerminal(page, "ctrl-c handled"));

    const resizeFramesBefore = jsonMessages(messages).filter(
      (message) => message?.type === "resize",
    ).length;
    await page.setViewportSize({ width: 1100, height: 720 });
    await expect
      .poll(() => jsonMessages(messages).filter((message) => message?.type === "resize").length)
      .toBeGreaterThan(resizeFramesBefore);
    const resizedBox = await page.getByLabel("Agent terminal").boundingBox();
    expect(resizedBox?.width).toBeGreaterThan(600);
    expect(resizedBox?.height).toBeGreaterThan(300);
    observations.push(await observeTerminal(page, "resized"));

    await page.locator('input[type="file"]').setInputFiles({
      name: "audit-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("uploaded from terminal usability audit\n"),
    });
    await expect
      .poll(() => jsonMessages(messages).find((message) => message?.type === "upload"))
      .toMatchObject({
        type: "upload",
        name: "audit-note.txt",
        mime_type: "text/plain",
        bytes_b64: Buffer.from("uploaded from terminal usability audit\n").toString("base64"),
      });
    await expect(liveTerminalRows(page)).toContainText("uploaded:audit-note.txt");
    observations.push(await observeTerminal(page, "file uploaded"));

    await liveTerminal(page).hover();
    await page.mouse.wheel(0, -900);
    const overlay = page.getByTestId("terminal-scrollback-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".xterm-rows")).toContainText("audit-history-");
    sockets[0]?.send(Buffer.from("\x1b[2A\rLIVE-AUDIT-WHILE-SCROLLED"));
    observations.push(await observeTerminal(page, "scrollback opened"));

    await page.mouse.wheel(0, 5000);
    await expect(overlay).not.toBeVisible();
    await expect(liveTerminalRows(page)).toContainText("LIVE-AUDIT-WHILE-SCROLLED");
    await page.getByLabel("Agent terminal").click();
    await page.keyboard.type("after scroll");
    await page.keyboard.press("Enter");
    await expect(liveTerminalRows(page)).toContainText("audit:after scroll");
    observations.push(await observeTerminal(page, "returned to live input"));

    sockets[0]?.close({ code: 1001, reason: "audit reconnect" });
    await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
    await expect(liveTerminalRows(page)).toContainText("audit-reconnected");
    await page.getByLabel("Agent terminal").click();
    await page.keyboard.type("after reconnect");
    await page.keyboard.press("Enter");
    await expect(liveTerminalRows(page)).toContainText("audit:after reconnect");
    observations.push(await observeTerminal(page, "reconnected input"));

    await attachFinalScreenshot(page, testInfo, "terminal-desktop-final.png");
    await attachAuditReport(testInfo, {
      observations,
      socketEvents,
      messages,
      consoleErrors: health.consoleErrors,
      pageErrors: health.pageErrors,
    });

    expect(health.consoleErrors).toEqual([]);
    expect(health.pageErrors).toEqual([]);
  });

  test("desktop viewer can take control and type", async ({ page }, testInfo) => {
    const health = await watchPageHealth(page);
    const observations: Observation[] = [];
    const { messages, socketEvents } = await openAuditedTerminal(page, {
      control: { owner: false, cols: 118, rows: 32, viewers: 2 },
      history: "viewer-ready\n$ ",
    });

    await expect(page.getByText("Viewer · 118x32")).toBeVisible();
    await page.getByRole("button", { name: "Take control" }).click();
    await expect
      .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
      .toMatchObject({
        type: "take_control",
        cols: expect.any(Number),
        rows: expect.any(Number),
      });
    observations.push(await observeTerminal(page, "viewer took control"));

    await page.getByLabel("Agent terminal").click();
    await page.keyboard.type("controlled input");
    await page.keyboard.press("Enter");
    await expect(liveTerminalRows(page)).toContainText("audit:controlled input");
    observations.push(await observeTerminal(page, "viewer typed"));

    await attachFinalScreenshot(page, testInfo, "terminal-viewer-final.png");
    await attachAuditReport(testInfo, {
      observations,
      socketEvents,
      messages,
      consoleErrors: health.consoleErrors,
      pageErrors: health.pageErrors,
    });

    expect(health.consoleErrors).toEqual([]);
    expect(health.pageErrors).toEqual([]);
  });

  test.describe("mobile terminal touch audit", () => {
    const mobile = devices["iPhone 14 Pro"];
    test.use({
      deviceScaleFactor: mobile.deviceScaleFactor,
      hasTouch: mobile.hasTouch,
      isMobile: mobile.isMobile,
      userAgent: mobile.userAgent,
      viewport: mobile.viewport,
    });

    test("mobile touch scrollback and modifier keys record artifacts", async ({
      page,
    }, testInfo) => {
      const health = await watchPageHealth(page);
      const observations: Observation[] = [];
      const { messages, sockets, socketEvents } = await openAuditedTerminal(page, {
        history: `${longHistory(240)}mobile-ready\n$ `,
      });

      await expect(page.getByLabel("Agent terminal")).toBeVisible();
      await expect(page.getByRole("button", { name: "Ctrl-C" })).toBeVisible();
      observations.push(await observeTerminal(page, "mobile loaded"));

      await dragTouchInTerminal(page, 0.52, 0.62);
      const overlay = page.getByTestId("terminal-scrollback-overlay");
      await expect(overlay).toBeVisible();
      await expect(overlay.locator(".xterm-rows")).toContainText("audit-history-");
      sockets[0]?.send(Buffer.from("\x1b[2A\rMOBILE-LIVE-WHILE-SCROLLED"));
      observations.push(await observeTerminal(page, "mobile scrollback"));

      await dragTouchInTerminal(page, 0.62, 0.35);
      await expect(overlay).not.toBeVisible();
      await expect(liveTerminalRows(page)).toContainText("MOBILE-LIVE-WHILE-SCROLLED");
      await page.getByRole("button", { name: "Tab" }).click();
      await page.getByRole("button", { name: "Ctrl-C" }).click();
      await page.getByRole("button", { name: "Send" }).click();
      await expect.poll(() => binaryText(messages)).toContain("\t");
      await expect.poll(() => binaryText(messages)).toContain("\x03");
      await expect.poll(() => binaryText(messages)).toContain("\r");
      observations.push(await observeTerminal(page, "mobile modifier keys"));

      await attachFinalScreenshot(page, testInfo, "terminal-mobile-final.png");
      await attachAuditReport(testInfo, {
        observations,
        socketEvents,
        messages,
        consoleErrors: health.consoleErrors,
        pageErrors: health.pageErrors,
      });

      expect(health.consoleErrors).toEqual([]);
      expect(health.pageErrors).toEqual([]);
    });
  });
});
