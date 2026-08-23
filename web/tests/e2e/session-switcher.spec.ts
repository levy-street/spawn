import { expect, test } from "@playwright/test";
import { mockApp, SESSION_B_ID, SESSION_ID, session } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock } from "./session-rtc-mock";

test.fixme("full-screen session view can switch to another live session", async ({ page }) => {
  // Product bug: SessionView has no switcher control or session-list query.
  // Keep this contract executable so removing fixme is the implementation handoff.
  await installSessionRtcMock(page, [], { autoSnapshot: true });
  await mockApp(page, {
    sessions: [session(), session({ id: SESSION_B_ID, name: "second session" })],
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
  await expect(page.getByLabel("Session terminal")).toBeVisible();
  await page.getByRole("button", { name: "Switch session" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch session" });
  await dialog.getByText("second session").click();
  await page.waitForURL(new RegExp(`/sessions/${SESSION_B_ID}$`));
});
