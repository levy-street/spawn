import { expect, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// The in-session agent switcher: a header button opens a searchable bottom
// sheet of live agents, and picking one switches in place (a route push — the
// warm pool keeps it instant). Swipe on the header does the same for the
// adjacent recent agent; swipe feel itself needs a real device, so this pins
// the button + sheet + navigation contract.

// The switcher rail is coarse-pointer-only, so drive this spec as a touch
// device (Chromium's isMobile makes CSS `pointer: coarse` match).
test.use({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });

const SECOND_AGENT_ID = "00000000-0000-4000-8000-000000000005";
const V2_MARKER = "\x1b[8;12;80t";
const V2_SENTINEL = "\x1b_sp:h1\x1b\\";

function v2Replay() {
  return `${V2_MARKER}${V2_SENTINEL}commit-000\r\n${V2_MARKER}\x1b[Hlive$ `;
}

test("header switcher opens a sheet and switches agents in place", async ({ page }) => {
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: v2Replay(),
    control: { owner: true, cols: 80, rows: 12, viewers: 1 },
    autoSnapshot: true,
  });
  await mockAuthenticatedApi(page, {
    agents: [agent(), agent({ id: SECOND_AGENT_ID, name: "second-agent" })],
  });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    ws.onMessage((message) => handleAgentRtcSignal(ws, message));
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
  await expect(page.getByLabel("Agent terminal")).toBeVisible();

  // The switch button carries the position counter (2 live agents).
  const switchBtn = page.getByRole("button", { name: "Switch agent" });
  await expect(switchBtn).toContainText("/2");

  // Open the sheet; it lists both agents including the one we're not on.
  await switchBtn.click();
  const sheet = page.getByRole("dialog", { name: "Switch agent" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("second-agent")).toBeVisible();

  // Picking the other agent switches the route in place.
  await sheet.getByText("second-agent").click();
  await page.waitForURL(new RegExp(`/agents/${SECOND_AGENT_ID}$`));
});
