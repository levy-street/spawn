import { expect, type Page, test } from "@playwright/test";
import { AGENT_ID, agent, HOST_ID, mockApp, SESSION_ID, session } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

function ptyText(messages: Array<string | Buffer>): string {
  return messages
    .filter((message): message is Buffer => Buffer.isBuffer(message))
    .map((message) => message.toString("utf8"))
    .join("");
}

async function openSwitcherSession(
  page: Page,
  options: {
    foreground?: string | null;
    installed?: boolean;
    definition?: ReturnType<typeof agent>;
  } = {},
) {
  const messages: Array<string | Buffer> = [];
  const definition = options.definition ?? agent();
  await installSessionRtcMock(page, messages, { history: "ready\r\n$ ", autoSnapshot: true });
  const store = await mockApp(page, {
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
  return {
    messages,
    store,
    terminal,
    // The pane header is the hover group; its title is a safe thing to point at.
    title: page.getByRole("heading", { name: "palette" }),
    trigger: page.getByRole("button", { name: /^(Switch agent type|Agent types)/ }),
  };
}

test("the header icon grows a chevron on hover and collapses again", async ({ page }) => {
  const { title, trigger } = await openSwitcherSession(page);
  await expect(trigger).toBeVisible();
  const collapsed = await trigger.boundingBox();

  await title.hover();
  await expect
    .poll(async () => (await trigger.boundingBox())?.width ?? 0)
    .toBeGreaterThan(collapsed?.width ?? 0);

  // Away from the header, the row is the bare icon again.
  await page.getByLabel("Session terminal").hover();
  await expect.poll(async () => (await trigger.boundingBox())?.width ?? 0).toBe(collapsed?.width);
});

test("picking an installed agent types env prefix plus command and keeps terminal focus", async ({
  page,
}) => {
  const definition = agent({
    id: AGENT_ID,
    name: "Codex",
    command: "codex --quiet",
    env: { FOO: "bar", TOKEN: "two words" },
  });
  const { messages, terminal, trigger } = await openSwitcherSession(page, { definition });
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();

  await trigger.click();
  await page.getByRole("menuitem", { name: /Codex/ }).click();

  await expect.poll(() => ptyText(messages)).toBe("FOO=bar TOKEN='two words' codex --quiet\n");
  await expect(input).toBeFocused();
});

test("an agent missing from the host types its install command chained in front", async ({
  page,
}) => {
  const definition = agent({
    name: "Codex",
    command: "codex",
    env: {},
    install: "npm install -g codex",
  });
  const { messages, trigger } = await openSwitcherSession(page, { definition, installed: false });

  await trigger.click();
  const item = page.getByRole("menuitem", { name: /Codex/ });
  await expect(item).toContainText("install & run");
  await item.click();

  await expect.poll(() => ptyText(messages)).toBe("npm install -g codex && codex\n");
});

test("switching while an agent runs asks first, and declining types nothing", async ({ page }) => {
  const { messages, trigger } = await openSwitcherSession(page, { foreground: "claude" });
  await trigger.click();
  await expect(page.getByText("Stop Claude Code and run")).toBeVisible();
  await page.getByRole("menuitem", { name: /Codex/ }).click();

  const ask = page.getByRole("dialog", { name: "Stop Claude Code first?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(ptyText(messages)).toBe("");
});

test("confirming interrupts the agent, then types once the shell is back", async ({ page }) => {
  const { messages, store, trigger } = await openSwitcherSession(page, { foreground: "claude" });
  await trigger.click();
  await page.getByRole("menuitem", { name: /Codex/ }).click();
  await page.getByRole("button", { name: "Stop Claude Code" }).click();

  // Ctrl-C first, and nothing else until the daemon reports a shell again.
  await expect.poll(() => ptyText(messages)).toContain("\u0003");
  expect(ptyText(messages)).not.toContain("codex");

  const running = store.sessions[0] as { foreground_command: string };
  running.foreground_command = "zsh";
  await expect.poll(() => ptyText(messages)).toContain("clear\ncodex\n");
});
