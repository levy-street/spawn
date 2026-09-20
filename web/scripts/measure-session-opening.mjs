import { expect } from "@playwright/test";

/** Disposable fixture trust, including a real signed broadcast from this
 * browser. Workspace navigation remounts gossip and consumes this row again. */
export async function seedKnownHostGossip(page, accountId, deviceId) {
  await page.evaluate(async ({ accountId, deviceId }) => {
    const result = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const decode = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const encode = (value) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const hostResponse = await fetch("/api/hosts");
    if (!hostResponse.ok) throw new Error("Fixture host lookup failed");
    const [host] = await hostResponse.json();
    if (!host?.host_public_key) throw new Error("Fixture host identity missing");
    const identityDb = await result(indexedDB.open("spawn-browser-device-identity", 1));
    const identity = await result(identityDb.transaction("device-identities").objectStore("device-identities").get(accountId));
    identityDb.close();
    const hostKey = decode(host.host_public_key);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", hostKey));
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("host-pins", { keyPath: "recordId" });
    const pins = await result(request);
    const transaction = pins.transaction("host-pins", "readwrite");
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    const now = Date.now();
    transaction.objectStore("host-pins").put({
      accountId, origin: location.origin, hostPublicKey: host.host_public_key,
      hostFingerprint: `SHA256:${encode(digest.slice(0, 12))}`, hostIds: [host.id],
      state: "active", approvedAtMs: now, createdAtMs: now, revokedAtMs: null,
      version: 1, recordId: JSON.stringify([accountId, location.origin, host.host_public_key]),
    });
    await completed;
    pins.close();
    const fields = [new TextEncoder().encode("SPAWN-HOST-INTRO-BCAST-V1"), Uint8Array.of(1),
      Uint8Array.from(accountId.replaceAll("-", "").match(/../g), (hex) => Number.parseInt(hex, 16)),
      decode(identity.publicKeyWire), hostKey];
    const transcript = new Uint8Array(fields.reduce((length, field) => length + field.length, 0));
    let offset = 0;
    for (const field of fields) { transcript.set(field, offset); offset += field.length; }
    const signature = encode(new Uint8Array(await crypto.subtle.sign("Ed25519", identity.privateKey, transcript)));
    const published = await fetch("/api/trust/host-introductions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publisher_device_id: deviceId, host_id: host.id,
        host_name: host.name, host_public_key: host.host_public_key, signature }),
    });
    if (!published.ok) throw new Error(`Fixture gossip publication failed: ${published.status}`);
  }, { accountId, deviceId });
}

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
  const notice = page.getByRole("status").filter({ hasText: /Reconnecting to .*Terminal input is paused/ });
  await expect(notice).toHaveCount(0);
  const ordinary = fixtures.slice(0, 3);
  for (const [index, fixture] of [...ordinary, ...ordinary].entries()) {
    const link = page.locator(`a[href="/w/${fixture.workspace_id}"]`).first();
    await expect(link).toBeVisible();
    await link.evaluate((node, sessionId) => {
      node.addEventListener("pointerdown", () => {
        const start = performance.now();
        const result = { start, sessionId, rendererMs: null, contentMs: null, readyMs: null, inputMs: null, connecting: false, hostReconnecting: false };
        globalThis.__spawnOpenTiming = result;
        const observe = () => {
          if (globalThis.__spawnOpenTiming !== result) return;
          const terminal = document.querySelector(`[data-session-id="${sessionId}"]`);
          if ([...document.querySelectorAll('[role="status"]')].some((node) => /Reconnecting to .*Terminal input is paused/.test(node.textContent))) result.hostReconnecting = true;
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
        host_reconnecting_shown: result.hostReconnecting,
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
    expect(observed.host_reconnecting_shown).toBe(false);
    await terminal.click();
    const marker = `latency-proof-${index}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(`browser-live:${marker}`);
    await expect(notice).toHaveCount(0);
    expect(await peerCounts()).toEqual(before);
    observations.push({ kind: index < ordinary.length ? "first-open" : "repeat-open", ...observed });
  }
  await slowAttachment(page, fixtures[3]);
  expect(await peerCounts()).toEqual(before);
  expect(before.peers).toBe(1);
  console.log(`session-open-timing: ${JSON.stringify({ network: "loopback API and real WebRTC; observations have no injected delay", build: "Next development server; route already compiled", unchanged_peer: true, observations, slow_case: { minimum_open_observation_delay_ms: 650, no_fullscreen: true, input_verified: true } })}`);
}

/** Exercise a slow attachment separately from the latency observations. Delay
 * observation of ctl-open (event and readyState), retaining real RTC data. */
async function slowAttachment(page, fixture) {
  await page.evaluate((sessionId) => {
    const prototype = globalThis.RTCPeerConnection.prototype;
    const create = prototype.createDataChannel;
    prototype.createDataChannel = function (label, options) {
      const channel = create.call(this, label, options);
      if (label.startsWith(`spawn.ctl/${sessionId}/`)) {
        globalThis.__spawnSlowOpenTrace = ["created"];
        const readState = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "readyState").get;
        Object.defineProperty(channel, "readyState", {
          configurable: true,
          get() {
            const state = readState.call(channel);
            return state === "open" ? "connecting" : state;
          },
        });
        channel.addEventListener("open", (event) => {
          event.stopImmediatePropagation();
          globalThis.__spawnSlowOpenTrace.push("held");
          const openedAt = performance.now();
          globalThis.__spawnReleaseSlowOpen = () => {
            setTimeout(() => {
              delete channel.readyState;
              globalThis.__spawnSlowOpenTrace.push("released");
              if (channel.readyState === "open") channel.dispatchEvent(new Event("open"));
            }, Math.max(0, 650 - (performance.now() - openedAt)));
          };
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
    await page.evaluate(() => globalThis.__spawnReleaseSlowOpen());
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
  } catch (error) {
    console.log(`slow-opening-observation: ${JSON.stringify(await page.evaluate(() => ({ trace: globalThis.__spawnSlowOpenTrace })))}`);
    throw error;
  } finally {
    await page.evaluate(() => globalThis.__spawnRestoreOpenObservation());
  }
}
