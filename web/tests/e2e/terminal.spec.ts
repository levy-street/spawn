import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
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

test("terminal renders ANSI color and sends keystrokes without refresh", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page);

  await expect(page.locator(".xterm-rows")).toContainText("RED");
  const redColor = await page.locator(".xterm-rows span", { hasText: "RED" }).evaluate((node) => {
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

test("terminal sends resize and file upload frames over the agent socket", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page);

  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "resize"))
    .toBe(true);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "upload"))
    .toMatchObject({
      type: "upload",
      destination: "cwd",
      name: "note.txt",
      mime_type: "text/plain",
      bytes_b64: Buffer.from("hello file").toString("base64"),
      paste: false,
    });
});

test("terminal reconnect restores a fresh terminal history snapshot", async ({ page }) => {
  const { sockets } = await openTerminalWithMockSocket(page, { reconnect: true });

  await expect(page.locator(".xterm-rows")).toContainText("RED");
  await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".xterm-rows")).toContainText("after reconnect");
});
