import { expect, type Page, test } from "@playwright/test";
import { mockApp, SESSION_ID, session } from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock, sendPty } from "./session-rtc-mock";

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
  await installSessionRtcMock(page, messages, {
    history: `${Array.from({ length: 60 }, (_, i) => `gpu-history-${i}`).join("\n")}\nready\n$ `,
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
  await expect(page.getByLabel("Session terminal")).toBeVisible();
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

test("GPU live writes do not expose a cursor position from the middle of a redraw", async ({
  page,
}) => {
  await openGpuTerminal(page);
  const live = page.getByTestId("terminal-live-host");
  const textarea = live.locator(".xterm-helper-textarea");
  await sendPty(page, "\x1b[30;1H");
  await expect.poll(() => textarea.evaluate((element) => element.style.top)).not.toBe("");
  const settledTop = await textarea.evaluate((element) => element.style.top);
  await page.waitForTimeout(100);

  const observedTops = await page.evaluate(async () => {
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="terminal-live-host"] .xterm-helper-textarea',
    );
    if (!input) return [];
    const tops: string[] = [];
    const sampler = setInterval(() => tops.push(input.style.top), 1);
    const rtc = (
      window as unknown as {
        __spawnRtcTest: { sendPty: (text: string) => boolean };
      }
    ).__spawnRtcTest;
    rtc.sendPty("\x1b[?2026h\x1b[2;1H");
    // A synchronized repaint can contain quiet gaps much longer than the
    // normal live-write debounce. Its intermediate row must remain hidden
    // until the explicit closing marker arrives.
    await new Promise((resolve) => setTimeout(resolve, 60));
    rtc.sendPty("\x1b[30;1H\x1b[?2026l");
    await new Promise((resolve) => setTimeout(resolve, 40));
    clearInterval(sampler);
    return tops;
  });

  expect(observedTops.length).toBeGreaterThan(0);
  expect(new Set(observedTops)).toEqual(new Set([settledTop]));
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
