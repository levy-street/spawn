// Scroll-integrity audit against real claude frames: grow the input box with
// shift+enter draft lines (no API spend), resize through several widths so
// scrollback holds Ink frames painted at different geometries, then scroll
// through history after each trigger the user reported (resize, refocus,
// reconnect). Screenshots are the evidence; eyeball for broken/shifted boxes.
// Run from web/:  bun scripts/live-dev-audit-scroll-claude.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-scroll-claude";
if (!EMAIL || !PASSWORD || !HOST_ID) {
  console.error("set SPAWN_DEV_URL, SPAWN_DEV_EMAIL, SPAWN_DEV_PASSWORD, SPAWN_DEV_HOST_ID");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const api = async (token, path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const login = await api(null, "/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const token = login.access_token;
const agent = await api(token, "/api/agents", {
  method: "POST",
  body: JSON.stringify({
    host_id: HOST_ID,
    cwd: "/tmp",
    argv: ["claude", "--dangerously-skip-permissions"],
    name: "scroll-claude-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};
async function wheelScroll(dy) {
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  const target = (await overlay.isVisible().catch(() => false))
    ? overlay
    : page.getByTestId("terminal-live-host").locator(".xterm");
  await target.hover();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(800);
}

try {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  await page.goto(`${BASE}/agents/${agent.id}`);
  const term = page.getByLabel("Agent terminal");
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(6000);
  await term.click();
  await page.keyboard.press("Enter"); // trust dialog
  await page.waitForTimeout(4000);
  await shot("01-main-ui");

  // Grow the input box: 30 draft lines via shift+enter pushes the welcome
  // box and earlier frame rows into scrollback, all claude-rendered.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.type(`draft line ${String(i).padStart(2, "0")} of the tall unsubmitted prompt`, { delay: 4 });
    await page.keyboard.press("Shift+Enter");
  }
  await page.keyboard.type("last draft line", { delay: 4 });
  await shot("02-tall-box");

  // Width churn: claude re-renders the tall frame at each width.
  for (const [w, h, name] of [
    [1000, 760, "03-width-1000"],
    [1180, 700, "04-width-1180"],
    [900, 800, "05-width-900"],
    [1280, 800, "06-width-1280"],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    await shot(name);
  }

  // Scroll through the width-varied history.
  await wheelScroll(-800);
  await shot("07-scroll-1");
  await wheelScroll(-800);
  await shot("08-scroll-2");
  await wheelScroll(-1600);
  await shot("09-scroll-3");
  await wheelScroll(12000);
  await shot("10-back-live");

  // Refocus trigger: hidden -> output-ish activity -> visible -> scroll.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1000);
  await wheelScroll(-1200);
  await shot("11-scroll-after-refocus");
  await wheelScroll(12000);

  // Reconnect trigger, then scroll and type.
  await page.context().setOffline(true);
  await page.waitForTimeout(2500);
  await page.context().setOffline(false);
  await page.waitForTimeout(4000);
  await shot("12-after-reconnect");
  await wheelScroll(-1200);
  await shot("13-scroll-after-reconnect");
  await wheelScroll(-2400);
  await shot("14-deep-after-reconnect");
  await wheelScroll(12000);
  await term.click();
  await page.keyboard.type(" typed at the end", { delay: 10 });
  await shot("15-typing-at-end");
} finally {
  console.log("=== console (non-log) ===");
  for (const l of consoleLines.filter((x) => !x.startsWith("[log]")).slice(-15)) console.log(l);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
