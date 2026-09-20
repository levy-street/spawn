import { expect } from "@playwright/test";

/** Real navigation, renderer, channels, replay and shell input. The fixture
 * sessions exist before login but have never had a terminal view opened. */
export async function measureSessionOpenings(page, fixtures) {
  await page.bringToFront();
  const observations = [];
  const peerCounts = () => page.evaluate(() => ({
    peers: globalThis.__spawnRtcEvents.filter((event) => event.type === "pc.created").length,
    offers: globalThis.__spawnRtcEvents.filter((event) => event.type === "pc.offer").length,
  }));
  const before = await peerCounts();
  for (const [index, fixture] of [...fixtures, ...fixtures].entries()) {
    const link = page.locator(`a[href="/w/${fixture.workspace_id}"]`).first();
    await expect(link).toBeVisible();
    await link.evaluate((node, sessionId) => {
      node.addEventListener("pointerdown", () => {
        const start = performance.now();
        const result = { start, sessionId, rendererMs: null, contentMs: null, readyMs: null, connecting: false };
        globalThis.__spawnOpenTiming = result;
        const observe = () => {
          if (globalThis.__spawnOpenTiming !== result) return;
          const terminal = document.querySelector(`[data-session-id="${sessionId}"]`);
          if (terminal && getComputedStyle(terminal).visibility !== "hidden") {
            if (terminal.querySelector(".xterm") && result.rendererMs === null) result.rendererMs = performance.now() - start;
            if (terminal.querySelector(".xterm-rows")?.textContent.includes("browser-live-ready") && result.contentMs === null) result.contentMs = performance.now() - start;
            if (terminal.getAttribute("aria-busy") === "false" && result.readyMs === null) result.readyMs = performance.now() - start;
            if (terminal.querySelector('[data-testid="terminal-connecting"]')) result.connecting = true;
          }
          if ((result.contentMs === null || result.readyMs === null) && performance.now() - start < 20_000) requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      }, { once: true });
    }, fixture.session_id);
    await link.click();
    const terminal = page.locator(`[data-session-id="${fixture.session_id}"]`);
    await expect(terminal).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => {
      const result = globalThis.__spawnOpenTiming;
      return Boolean(result && result.contentMs !== null && result.readyMs !== null);
    }), { timeout: 20_000 }).toBe(true);
    const observed = await page.evaluate(() => {
      const result = globalThis.__spawnOpenTiming;
      const channels = globalThis.__spawnRtcEvents.filter((event) => event.label?.includes(result.sessionId) && event.at >= result.start);
      return {
        renderer_ms: result.rendererMs,
        first_content_ms: result.contentMs,
        input_gate_ms: result.readyMs,
        connecting_shown: result.connecting,
        channels: channels.map((event) => ({ type: event.type, channel: event.label.split("/")[0], elapsed_ms: event.at - result.start, ...(event.operation ? { operation: event.operation } : {}), ...(event.event ? { event: event.event } : {}) })),
      };
    });
    // A healthy first attachment must finish without the ten-second retry.
    // Leave headroom for a busy CI renderer; channel count detects even a fast retry.
    expect(observed.channels.filter((event) => event.type === "dc.created")).toHaveLength(
      index < fixtures.length ? 2 : 0,
    );
    expect(observed.first_content_ms).toBeLessThan(5_000);
    expect(observed.input_gate_ms).toBeLessThan(5_000);
    expect(observed.connecting_shown).toBe(false);
    await terminal.click();
    const marker = `latency-proof-${index}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(`browser-live:${marker}`);
    observations.push({ kind: index < fixtures.length ? "first-open" : "repeat-open", ...observed });
  }
  expect(await peerCounts()).toEqual(before);
  expect(before.peers).toBe(1);
  console.log(`session-open-timing: ${JSON.stringify({ network: "loopback API and real WebRTC; no injected delay", build: "Next development server; route already compiled", unchanged_peer: true, observations })}`);
}
