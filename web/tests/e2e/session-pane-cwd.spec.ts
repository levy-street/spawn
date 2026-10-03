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

/** The pane's where chip, then "Choose a folder…": a folder on the same host. */
async function chooseFolder(page: Page) {
  await page.getByRole("button", { name: /Change where it runs/ }).click();
  await page
    .getByRole("menu", { name: "Where this runs" })
    .getByRole("menuitem", { name: /Choose a folder/ })
    .click();
}

async function openPaneFolderPicker(page: Page, foreground: string) {
  const messages: Array<string | Buffer> = [];
  await installSessionRtcMock(page, messages, { history: "ready\r\n$ ", autoSnapshot: true });
  const store = await mockApp(page, {
    sessions: [session({ foreground_command: foreground })],
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
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
  await chooseFolder(page);
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  // Miller columns can show the same folder name in several columns; pick it
  // from the home column explicitly.
  await dialog
    .getByRole("listbox", { name: "Folders in /Users/tester", exact: true })
    .getByRole("option", { name: "projects" })
    .click();
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

  await chooseFolder(page);
  const dialog = page.getByRole("dialog", { name: "Select a folder on Mac" });
  // Miller columns can show the same folder name in several columns; pick it
  // from the home column explicitly.
  await dialog
    .getByRole("listbox", { name: "Folders in /Users/tester", exact: true })
    .getByRole("option", { name: "projects" })
    .click();
  await dialog.getByRole("button", { name: "Select this folder" }).click();
  await page.getByRole("button", { name: "Stop Claude Code" }).click();

  // Ctrl-C, then nothing typed until the daemon reports the shell again.
  await expect.poll(() => ptyText(messages)).toContain("\u0003");
  expect(ptyText(messages)).not.toContain("cd ");

  const running = store.sessions[0] as { foreground_command: string };
  running.foreground_command = "zsh";
  await expect.poll(() => ptyText(messages)).toContain("clear\ncd /Users/tester/projects\n");
});

test("the where chip says host and folder, and a narrow pane keeps just the folder", async ({
  page,
}) => {
  await mockApp(page, {
    sessions: [session()],
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
    files: () => listing,
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const chip = page.getByRole("button", { name: /Change where it runs/ });
  await expect(chip).toHaveAccessibleName("Runs in ~/projects/spawn on Mac. Change where it runs");
  await expect(chip.getByText("~/projects/spawn")).toBeVisible();
  await expect(chip.getByText("Mac", { exact: true })).toBeVisible();

  // Squeezed to a thin header, the folder's own name is what stays: the
  // control is still there to click, and its title still spells the path out.
  await page.setViewportSize({ width: 520, height: 800 });
  await expect(chip.getByText("Mac", { exact: true })).toBeHidden();
  await expect(chip.getByText("spawn", { exact: true })).toBeVisible();
  await expect(chip).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(chip.getByText("~/projects/spawn")).toBeVisible();
});

test("the where chip's menu is called Where this runs, on a desktop and on a phone", async ({
  page,
}) => {
  await mockApp(page, {
    sessions: [session()],
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
    files: () => listing,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/w/${WORKSPACE_ID}`);
  const chip = page.getByRole("button", { name: /Change where it runs/ });

  // The same words as the phone app's sheet, said above the places.
  await chip.click();
  const menu = page.getByRole("menu", { name: "Where this runs" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Where this runs", { exact: true })).toBeVisible();
  await expect(page.getByText("Where?", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // At phone width the menu is a bottom sheet, and its title says it once.
  await page.setViewportSize({ width: 390, height: 844 });
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Where this runs" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("menu", { name: "Where this runs" })).toBeVisible();
  await expect(sheet.getByText("Where this runs", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Where?", { exact: true })).toHaveCount(0);
});
