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
  const ordinary = fixtures.slice(0, 3);
  for (const [index, fixture] of [...ordinary, ...ordinary].entries()) {
    const link = page.locator(`a[href="/w/${fixture.workspace_id}"]`).first();
    await expect(link).toBeVisible();
    await link.evaluate((node, sessionId) => {
      node.addEventListener("pointerdown", () => {
        const start = performance.now();
        const result = { start, sessionId, rendererMs: null, contentMs: null, readyMs: null, inputMs: null, connecting: false };
        globalThis.__spawnOpenTiming = result;
        const observe = () => {
          if (globalThis.__spawnOpenTiming !== result) return;
          const terminal = document.querySelector(`[data-session-id="${sessionId}"]`);
          if (terminal && getComputedStyle(terminal).visibility !== "hidden") {
            if (terminal.querySelector(".xterm") && result.rendererMs === null) result.rendererMs = performance.now() - start;
            if (terminal.querySelector(".xterm-rows")?.textContent.includes("browser-live-ready") && result.contentMs === null) result.contentMs = performance.now() - start;
            if (terminal.getAttribute("aria-busy") === "false" && result.readyMs === null) result.readyMs = performance.now() - start;
            if (terminal.getAttribute("data-input-ready") === "true" && result.inputMs === null) result.inputMs = performance.now() - start;
            if (terminal.querySelector('[data-testid="terminal-connecting"]')) result.connecting = true;
          }
          if ((result.contentMs === null || result.inputMs === null) && performance.now() - start < 20_000) requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      }, { once: true });
    }, fixture.session_id);
    await link.click();
    const terminal = page.locator(`[data-session-id="${fixture.session_id}"]`);
    await expect(terminal).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => {
      const result = globalThis.__spawnOpenTiming;
      return Boolean(result && result.contentMs !== null && result.inputMs !== null);
    }), { timeout: 20_000 }).toBe(true);
    const observed = await page.evaluate(() => {
      const result = globalThis.__spawnOpenTiming;
      const channels = globalThis.__spawnRtcEvents.filter((event) => event.label?.includes(result.sessionId) && event.at >= result.start);
      return {
        renderer_ms: result.rendererMs,
        first_content_ms: result.contentMs,
        transport_ready_ms: result.readyMs,
        input_ready_ms: result.inputMs,
        connecting_shown: result.connecting,
        channels: channels.map((event) => ({ type: event.type, channel: event.label.split("/")[0], elapsed_ms: event.at - result.start, ...(event.operation ? { operation: event.operation } : {}), ...(event.event ? { event: event.event } : {}) })),
      };
    });
    // A healthy first attachment must finish without the ten-second retry.
    // Leave headroom for a busy CI renderer; channel count detects even a fast retry.
    expect(observed.channels.filter((event) => event.type === "dc.created")).toHaveLength(
      index < ordinary.length ? 2 : 0,
    );
    expect(observed.first_content_ms).toBeLessThan(5_000);
    expect(observed.input_ready_ms).toBeLessThan(5_000);
    expect(observed.connecting_shown).toBe(false);
    await terminal.click();
    const marker = `latency-proof-${index}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(`browser-live:${marker}`);
    observations.push({ kind: index < ordinary.length ? "first-open" : "repeat-open", ...observed });
  }
  await slowAttachment(page, fixtures[3]);
  expect(await peerCounts()).toEqual(before);
  expect(before.peers).toBe(1);
  console.log(`session-open-timing: ${JSON.stringify({ network: "loopback API and real WebRTC; observations have no injected delay", build: "Next development server; route already compiled", unchanged_peer: true, observations, slow_case: { native_open_callback_delay_ms: 650, no_fullscreen: true, input_verified: true } })}`);
}

/** Exercise a slow attachment separately from the latency observations. Delay
 * only the native ctl-open callback, retaining actual channels/data/readiness. */
async function slowAttachment(page, fixture) {
  await page.evaluate((sessionId) => {
    const prototype = globalThis.RTCPeerConnection.prototype;
    const create = prototype.createDataChannel;
    prototype.createDataChannel = function (label, options) {
      const channel = create.call(this, label, options);
      if (label.startsWith(`spawn.ctl/${sessionId}/`)) {
        channel.addEventListener("open", (event) => {
          event.stopImmediatePropagation();
          setTimeout(() => channel.dispatchEvent(new Event("open")), 650);
        }, { capture: true, once: true });
      }
      return channel;
    };
    globalThis.__spawnSlowOpeningHadCard = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(`[data-session-id="${sessionId}"] [data-testid="terminal-connecting"]`)) globalThis.__spawnSlowOpeningHadCard = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    globalThis.__spawnRestoreOpenObservation = () => {
      prototype.createDataChannel = create;
      observer.disconnect();
    };
  }, fixture.session_id);
  try {
    await page.locator(`a[href="/w/${fixture.workspace_id}"]`).first().click();
    const terminal = page.locator(`[data-session-id="${fixture.session_id}"]`);
    await expect(terminal.getByTestId("terminal-opening-status")).toBeVisible();
    await expect(terminal).toHaveAttribute("data-input-ready", "false");
    await expect(terminal).toHaveAttribute("data-input-ready", "true", { timeout: 5_000 });
    await expect(terminal.getByTestId("terminal-opening-status")).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.__spawnSlowOpeningHadCard)).toBe(false);
    expect(await page.evaluate((id) => globalThis.__spawnRtcEvents.filter(
      (event) => event.type === "dc.created" && event.label.includes(id),
    ).length, fixture.session_id)).toBe(2);
    await terminal.click();
    await page.keyboard.type("slow-opening-proof");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("browser-live:slow-opening-proof");
  } finally {
    await page.evaluate(() => globalThis.__spawnRestoreOpenObservation());
  }
}
