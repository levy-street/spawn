import { expect, type Page, test } from "@playwright/test";
import { AGENT_ID, agent, HOST_ID, mockApp, SESSION_ID, session } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

function ptyText(messages: Array<string | Buffer>): string {
  return messages
    .filter((message): message is Buffer => Buffer.isBuffer(message))
    .map((message) => message.toString("utf8"))
    .join("");
}

async function openShortcutSession(
  page: Page,
  options: {
    foreground?: string | null;
    history?: string;
    installed?: boolean;
    definition?: ReturnType<typeof agent>;
  } = {},
) {
  const messages: Array<string | Buffer> = [];
  const definition = options.definition ?? agent();
  await installSessionRtcMock(page, messages, {
    history: options.history ?? "ready\r\n$ ",
    autoSnapshot: true,
  });
  await mockApp(page, {
    sessions: [session({ foreground_command: options.foreground ?? "zsh" })],
    agents: [definition],
    hostAgents: {
      [HOST_ID]: [
        {
          agent_id: definition.id,
          agent_name: definition.name,
          agent_kind: definition.kind,
          command: definition.command,
          install: definition.install,
          installed: options.installed ?? true,
          path: options.installed === false ? null : "/usr/local/bin/codex",
          version: "1.0.0",
          update_available: false,
          auto_update: false,
        },
      ],
    },
  });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    ws.onMessage((message) => handleSessionRtcSignal(ws, message));
    ws.send(
      JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        binding_nonce_required: true,
      }),
    );
    ws.send(JSON.stringify({ type: "session.status", status: "running" }));
  });
  await page.goto(`/sessions/${SESSION_ID}`);
  const terminal = page.getByLabel("Session terminal");
  await expect(terminal).toBeVisible();
  return { messages, terminal, bar: page.getByRole("toolbar", { name: "Agent shortcuts" }) };
}

test("appears below an empty shell cursor, hides while typing, and returns after Enter", async ({
  page,
}) => {
  const { terminal, bar } = await openShortcutSession(page);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-flipped", "false");
  const cursorRow = terminal.locator(".xterm-rows > div").nth(1);
  const [barBox, rowBox] = await Promise.all([bar.boundingBox(), cursorRow.boundingBox()]);
  expect(barBox && rowBox && barBox.y >= rowBox.y + rowBox.height).toBe(true);

  await terminal.click();
  await page.keyboard.type("x");
  await expect(bar).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(bar).toBeVisible();
});

test("stays hidden while a non-shell foreground command is reported", async ({ page }) => {
  const { bar } = await openShortcutSession(page, { foreground: "claude" });
  await expect(bar).toHaveCount(0);
});

test("hides when the prompt cursor is scrolled out of view", async ({ page }) => {
  const history = `${Array.from({ length: 120 }, (_, index) => `line-${index}`).join("\r\n")}\r\n$ `;
  const { terminal, bar } = await openShortcutSession(page, { history });
  await expect(bar).toBeVisible();
  await terminal.locator(".xterm").hover();
  await page.mouse.wheel(0, -2_000);
  await expect(bar).toBeHidden();
});

test("flips above the cursor near the bottom of the pane", async ({ page }) => {
  const history = `${Array.from({ length: 40 }, (_, index) => `bottom-${index}`).join("\r\n")}\r\n$ `;
  const { bar } = await openShortcutSession(page, { history });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-flipped", "true");
});

test("installed agents type env prefixes plus command and preserve terminal focus", async ({
  page,
}) => {
  const definition = agent({
    id: AGENT_ID,
    name: "Codex",
    command: "codex --quiet",
    env: { FOO: "bar", TOKEN: "two words" },
  });
  const { messages, terminal, bar } = await openShortcutSession(page, { definition });
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await bar.getByRole("button", { name: "Run Codex" }).click();
  await expect.poll(() => ptyText(messages)).toBe("FOO=bar TOKEN='two words' codex --quiet\n");
  await expect(input).toBeFocused();
});

test("a missing agent types install && command visibly", async ({ page }) => {
  const definition = agent({
    name: "Codex",
    command: "codex",
    env: {},
    install: "npm install -g codex",
  });
  const { messages, bar } = await openShortcutSession(page, {
    definition,
    installed: false,
  });
  await bar.getByRole("button", { name: "Install and run Codex" }).click();
  await expect.poll(() => ptyText(messages)).toBe("npm install -g codex && codex\n");
});
