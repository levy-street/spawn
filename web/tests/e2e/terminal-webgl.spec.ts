import { expect, type Page, test } from "@playwright/test";
import { handleAgentRtcSignal, installAgentRtcMock, sendPty } from "./agent-rtc-mock";
import { AGENT_ID, agent, mockAuthenticatedApi } from "./app-mocks";

// The live terminal defaults to the DOM renderer under automation
// (navigator.webdriver) so content assertions on .xterm-rows keep working.
// This spec forces the production default — the WebGL renderer — and smokes
// that it engages on the live terminal AND on the scrollback overlay while
// it is open (renderer parity: mixing GPU and DOM metrics makes scrolled
// content sit at visibly different font spacing than the live screen).
// Headless Chromium needs software GL opted in.
test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader"] } });

async function openGpuTerminal(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("spawnRenderer", "gpu");
  });
  const messages: Array<string | Buffer> = [];
  await installAgentRtcMock(page, messages, {
    history: `${Array.from({ length: 60 }, (_, i) => `gpu-history-${i}`).join("\n")}\nready\n$ `,
    control: { owner: true, cols: 120, rows: 36, viewers: 1 },
    autoSnapshot: true,
  });
  await mockAuthenticatedApi(page, { agents: [agent()] });
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
}

test("forced GPU renderer attaches a WebGL canvas to the live terminal", async ({ page }) => {
  await openGpuTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  await expect(live.locator(".xterm")).toBeVisible();
  // The WebGL addon renders into a canvas inside .xterm-screen; the DOM
  // renderer creates none. Headless Chromium provides WebGL via SwiftShader,
  // so absence here means the addon failed to engage.
  await expect(live.locator(".xterm-screen canvas").first()).toBeAttached({ timeout: 10_000 });
  // Live writes keep flowing without errors through the GPU path.
  await sendPty(page, "\r\ngpu-live-line\r\n$ ");
  await expect(live.locator(".xterm-screen canvas").first()).toBeAttached();
});

test("scrolled-back history renders through the same GPU canvas", async ({ page }) => {
  await openGpuTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  await live.locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  // One buffer, one renderer: scrolled-back history is the same WebGL canvas,
  // so there is no second context to leak and nothing to release on return.
  await expect(live.locator(".xterm-screen canvas").first()).toBeAttached({ timeout: 10_000 });
  await page.mouse.wheel(0, 40_000);
  await expect(live.locator(".xterm-screen canvas").first()).toBeAttached();
});
