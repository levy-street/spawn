import { expect, type Page, test } from "@playwright/test";
import { NOTIFY_STORAGE_KEY } from "../../src/lib/notify-prefs";
import {
  HOST_ID,
  mockApp,
  openSettings,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";

const OTHER_SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

/**
 * Alerts, end to end through the real socket client.
 *
 * The server half is mocked at the WebSocket boundary rather than stubbed at
 * the module boundary, so what runs here is the shipped path: frame parsing,
 * the preference gate, the per-session mute, and the visible-tab toast.
 */

const RUNNING_AGENT = session({
  id: SESSION_ID,
  host_id: HOST_ID,
  name: "api",
  foreground_command: "claude",
});

/** Stand in for `/ws/alerts` and hand back a push function. */
async function mockAlertSocket(page: Page): Promise<(frame: unknown) => Promise<void>> {
  const sockets: Array<{ send: (data: string) => void }> = [];
  await page.routeWebSocket(/\/ws\/alerts/, (ws) => {
    // Never call connectToServer: this is the whole server for this test.
    sockets.push(ws);
  });
  return async (frame: unknown) => {
    const raw = JSON.stringify(frame);
    await expect
      .poll(() => sockets.length, { message: "alert socket never connected" })
      .toBeGreaterThan(0);
    for (const ws of sockets) ws.send(raw);
  };
}

function finishedFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "alert",
    event: "agent.finished",
    session_id: SESSION_ID,
    command: "claude",
    at: "2026-08-21T10:00:00+00:00",
    ...overrides,
  };
}

test("the Notifications panel explains each channel and persists a choice", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  await mockAlertSocket(page);
  await openSettings(page, "notifications");

  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();

  // Only the in-tab channel is on out of the box; nothing that leaves the tab
  // is enabled until it is asked for.
  await expect(page.getByRole("switch", { name: "In-app message" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const name of ["Sound", "System notification", "Vibration"]) {
    await expect(page.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
  }

  // A choice survives a reload, because it is stored per browser.
  await page.getByRole("switch", { name: "A session exits or is killed" }).click();
  await expect(page.getByRole("switch", { name: "A session exits or is killed" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await page.reload();
  await openSettings(page, "notifications");
  await expect(page.getByRole("switch", { name: "A session exits or is killed" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("an agent finishing raises exactly one toast, naming the agent and the session", async ({
  page,
}) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  // Nothing on load: the stream is push-only, so there is no history to
  // replay and no first-observation to suppress.
  await expect(page.getByRole("status")).toHaveCount(0);

  await push(finishedFrame());

  const toast = page.getByRole("status").filter({ hasText: "finished" });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Claude Code finished");
  await expect(toast).toContainText("api");

  // Top-right, not bottom: it sits in the upper half of the viewport.
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box && viewport) expect(box.y).toBeLessThan(viewport.height / 2);
});

test("toasts auto-dismiss without being touched", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push(finishedFrame());
  await expect(page.getByRole("status")).toHaveCount(1);
  // ALERT_TOAST_MS is 7 s; allow the exit animation on top of it.
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 12_000 });
});

test("the stack keeps the five most recent alerts, not the five oldest", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  for (let index = 0; index < 8; index += 1) {
    await push(
      finishedFrame({ at: `2026-08-21T10:0${index}:00+00:00`, command: `agent-${index}` }),
    );
  }
  // Five visible; the earliest three are gone rather than the latest three.
  await expect(page.getByRole("status")).toHaveCount(5);
  await expect(page.getByRole("status").filter({ hasText: "agent-7" })).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "agent-0" })).toHaveCount(0);
});

test("a repeated frame for the same event does not stack a second toast", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push(finishedFrame());
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(1);
  await push(finishedFrame());
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(1);
});

test("a quiet agent is reported as waiting, not as finished", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push(finishedFrame({ event: "agent.awaiting_input" }));

  const toast = page.getByRole("status").filter({ hasText: "waiting" });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Claude Code is waiting for you");
});

test("a session death is reported with its exit code", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push(finishedFrame({ event: "session.died", exit_code: 137 }));

  const toast = page.getByRole("status").filter({ hasText: "exited" });
  await expect(toast).toContainText("Claude Code exited");
  await expect(toast).toContainText("exit 137");
});

test("turning an event class off silences it", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await openSettings(page, "notifications");
  await page.getByRole("switch", { name: "An agent finishes" }).click();
  await page.keyboard.press("Escape");

  await push(finishedFrame());
  await page.waitForTimeout(250);
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(0);
});

test("a muted session is silenced and its neighbours are not", async ({ page }) => {
  const other = session({
    id: OTHER_SESSION_ID,
    host_id: HOST_ID,
    name: "worker",
    foreground_command: "claude",
  });
  await mockApp(page, { sessions: [RUNNING_AGENT, other] });
  // Seed the mute the way the pane menu writes it, so this covers the
  // suppression path without dragging a live terminal into the test.
  await page.addInitScript(
    ([key, id]) => {
      window.localStorage.setItem(key, JSON.stringify({ mutedSessions: [id] }));
    },
    [NOTIFY_STORAGE_KEY, SESSION_ID],
  );
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push(finishedFrame());
  await page.waitForTimeout(250);
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(0);

  await push(finishedFrame({ session_id: OTHER_SESSION_ID }));
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(1);
});

test("the pane menu mutes the session it belongs to", async ({ page }) => {
  await mockApp(page, {
    sessions: [RUNNING_AGENT],
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
  });
  // The pane opens its own session socket; leave it unanswered rather than
  // unmocked so the terminal never reaches the network.
  await page.routeWebSocket(/\/ws\/browser/, () => {});
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await page.getByRole("button", { name: "api options" }).click();
  await page.getByRole("menuitem", { name: "Mute alerts" }).click();

  // Muted *and* on screen; either alone would silence it, and the header
  // check below is what proves the mute actually took.
  await push(finishedFrame());
  await page.waitForTimeout(250);
  await expect(page.getByRole("status").filter({ hasText: "finished" })).toHaveCount(0);

  // The header says so without being opened: a bell-off mark beside the name,
  // and the whole label dimmed.
  await expect(page.getByRole("img", { name: "Alerts muted" })).toBeVisible();
  await expect(page.locator("header").filter({ hasText: "api" }).first()).toContainText("api");

  await page.screenshot({
    path: "test-results/muted-pane-header.png",
    clip: {
      x: 0,
      y: 0,
      width: 640,
      height: 120,
    },
  });

  // And it reads back as muted, so the menu can offer the way out.
  await page.getByRole("button", { name: "api options" }).click();
  await expect(page.getByRole("menuitem", { name: "Unmute alerts" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Unmute alerts" }).click();

  // Unmuting clears the mark again.
  await expect(page.getByRole("img", { name: "Alerts muted" })).toHaveCount(0);
});

test("a pane you are already looking at does not interrupt you", async ({ page }) => {
  await mockApp(page, {
    sessions: [RUNNING_AGENT],
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
  });
  await page.routeWebSocket(/\/ws\/browser/, () => {});
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  // Wait for the pane to claim its terminal — that is what "on screen" means.
  await expect(page.getByRole("button", { name: "api options" })).toBeVisible();

  await push(finishedFrame());
  await page.waitForTimeout(400);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("clicking an alert opens its session's tab and focuses the terminal", async ({ page }) => {
  // The session lives on a tab that is not the open one, so it is genuinely
  // off screen — which is both what makes an alert appropriate and what gives
  // the click somewhere to navigate to.
  await mockApp(page, {
    sessions: [RUNNING_AGENT],
    workspaces: [
      workspace({
        layout: {
          version: 3,
          active_tab: "tab-1",
          tabs: [
            {
              id: "tab-1",
              name: "Tab 1",
              host_id: null,
              cwd: null,
              layout: { version: 3, tiles: [] },
            },
            {
              id: "tab-2",
              name: "Tab 2",
              host_id: null,
              cwd: null,
              layout: {
                version: 3,
                tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }],
              },
            },
          ],
        },
      }),
    ],
  });
  await page.routeWebSocket(/\/ws\/browser/, () => {});
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  // The alert resolves its destination from the cached workspace list, so let
  // the workspace finish loading before pushing — otherwise the toast is built
  // against an empty cache and can only offer the standalone session page.
  await expect(page.getByRole("tab", { name: "Tab 2" })).toBeVisible();

  await push(finishedFrame());
  await page
    .getByRole("status")
    .getByRole("button", { name: /^Go to / })
    .click();

  await expect(page).toHaveURL(new RegExp(`tab=tab-2.*focus=${SESSION_ID}`));
  // The terminal, not just the pane: xterm puts focus on its own textarea.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused({ timeout: 15_000 });
});

test("a malformed or unknown frame is ignored rather than surfacing", async ({ page }) => {
  await mockApp(page, { sessions: [RUNNING_AGENT] });
  const push = await mockAlertSocket(page);
  await page.goto(`/w/${WORKSPACE_ID}`);

  await push({ type: "alerts.ping" });
  // An event class this build does not know about — a newer server talking.
  await push(finishedFrame({ event: "agent.gave_up" }));
  await push({ type: "alert" });
  await page.waitForTimeout(250);
  await expect(page.getByRole("status")).toHaveCount(0);
});
