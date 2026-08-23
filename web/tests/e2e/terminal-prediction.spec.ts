import { expect, type Page, test } from "@playwright/test";
import { mockApp, SESSION_ID, session } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock, sendPty } from "./session-rtc-mock";

// Predictive local echo: printable keystrokes paint immediately in the
// prediction overlay and are confirmed (removed) by the authoritative echo.
// The mock never echoes on its own, so overlay states are deterministic.

async function openTerminal(page: Page, { predict = true } = {}) {
  // Prediction is opt-in; most specs exercise the enabled path.
  if (predict) {
    await page.addInitScript(() => {
      window.localStorage.setItem("spawnPredictEcho", "on");
    });
  }
  const messages: Array<string | Buffer> = [];
  await installSessionRtcMock(page, messages, {
    history: "ready\n$ ",
    control: { owner: true, cols: 120, rows: 36, viewers: 1 },
    autoSnapshot: true,
  });
  await mockApp(page, { sessions: [session()] });
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
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm")).toBeVisible();
  // Let the connect seed finish rendering: predictions are deliberately
  // suppressed while the seed rewrite is in flight.
  await expect(live.locator(".xterm-rows")).toContainText("$");
  await live.locator(".xterm").click();
  return live;
}

const overlay = (page: Page) => page.getByTestId("terminal-prediction-overlay");

test("keystrokes paint immediately and drain as the echo confirms them", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.type("hi");
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveText("hi");

  // Authoritative echo confirms the first char, then the second.
  await sendPty(page, "h");
  await expect(overlay(page)).toHaveText("i");
  await sendPty(page, "i");
  await expect(overlay(page)).toBeHidden();
});

test("a contradicting echo clears the prediction instead of showing wrong text", async ({
  page,
}) => {
  await openTerminal(page);
  await page.keyboard.type("a");
  await expect(overlay(page)).toHaveText("a");
  await sendPty(page, "z");
  await expect(overlay(page)).toBeHidden();
});

test("enter and control input never leave stale predictions behind", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.type("ok");
  await expect(overlay(page)).toHaveText("ok");
  await page.keyboard.press("Enter");
  await expect(overlay(page)).toBeHidden();
});

test("prediction stays dormant without the opt-in flag", async ({ page }) => {
  await openTerminal(page, { predict: false });
  await page.keyboard.type("quiet");
  await page.waitForTimeout(300);
  await expect(overlay(page)).toBeHidden();
});
