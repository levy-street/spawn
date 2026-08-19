import { expect, type Page, test } from "@playwright/test";
import {
  fileEntry,
  fileListing,
  mockApp,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

function ptyText(messages: Array<string | Buffer>): string {
  return messages
    .filter((message): message is Buffer => Buffer.isBuffer(message))
    .map((message) => message.toString("utf8"))
    .join("");
}

const listing = fileListing({
  path: "/Users/tester",
  parent: "/Users",
  entries: [fileEntry({ name: "projects", path: "/Users/tester/projects", is_dir: true })],
});

async function openPaneFolderPicker(page: Page, foreground: string) {
  const messages: Array<string | Buffer> = [];
  await installSessionRtcMock(page, messages, { history: "ready\r\n$ ", autoSnapshot: true });
  const store = await mockApp(page, {
    sessions: [session({ foreground_command: foreground })],
    workspaces: [
      workspace({
        layout: { version: 2, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 12 }] },
      }),
    ],
    files: () => listing,
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
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "Change directory" }).click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  return { messages, store };
}

test("at a shell prompt the picked folder is cd'd straight away", async ({ page }) => {
  const { messages } = await openPaneFolderPicker(page, "zsh");
  await expect.poll(() => ptyText(messages)).toBe("cd /Users/tester/projects\n");
});

test("an agent in the foreground is stopped first, and only with permission", async ({ page }) => {
  const { messages, store } = await openPaneFolderPicker(page, "claude");

  const ask = page.getByRole("dialog", { name: "Stop Claude Code first?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(ptyText(messages)).toBe("");

  await page.getByRole("button", { name: "Change directory" }).click();
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  await dialog.getByRole("option", { name: "projects" }).click();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await page.getByRole("button", { name: "Stop Claude Code" }).click();

  // Ctrl-C, then nothing typed until the daemon reports the shell again.
  await expect.poll(() => ptyText(messages)).toContain("\u0003");
  expect(ptyText(messages)).not.toContain("cd ");

  const running = store.sessions[0] as { foreground_command: string };
  running.foreground_command = "zsh";
  await expect.poll(() => ptyText(messages)).toContain("clear\ncd /Users/tester/projects\n");
});
