// Scroll-integrity audit: reproduces "misaligned history after resize or
// window come-back". Deterministic numbered lines make misalignment machine
// checkable: every content row must be a whole `L####|...` line (or a clean
// continuation), in ascending order within a screen.
// Run from web/:  bun scripts/live-dev-audit-scroll.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-scroll";
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
    argv: ["bash", "--norc", "--noprofile"],
    name: "scroll-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
const problems = [];
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

// Every visible row that contains an L#### token must START with it (a
// numbered line rendered mid-row = misalignment), tokens ascend, no dupes.
async function checkOverlayIntegrity(label) {
  const rowsText = await page
    .getByTestId("terminal-scrollback-overlay")
    .locator(".xterm-rows")
    .innerText()
    .catch(() => "");
  const rows = rowsText.split("\n");
  let last = -1;
  const seen = new Set();
  for (const row of rows) {
    const anywhere = row.match(/L(\d{4})\|/);
    if (!anywhere) continue;
    if (!/^L\d{4}\|/.test(row.trimEnd() === row ? row : row)) {
      if (row.indexOf(`L${anywhere[1]}|`) > 0) {
        problems.push(`${label}: token mid-row: ${JSON.stringify(row.slice(0, 90))}`);
      }
    }
    const n = Number(anywhere[1]);
    if (seen.has(n)) problems.push(`${label}: duplicate line L${anywhere[1]}`);
    seen.add(n);
    if (n < last) problems.push(`${label}: out of order L${anywhere[1]} after L${last}`);
    last = n;
  }
  return rows.length;
}

async function wheelScroll(dy) {
  // The overlay intercepts pointer events while open; wheel whatever is on
  // top, exactly like a user would.
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  const target = (await overlay.isVisible().catch(() => false))
    ? overlay
    : page.getByTestId("terminal-live-host").locator(".xterm");
  await target.hover();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(700);
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
  await page.waitForTimeout(2000);

  // Deterministic content: 500 numbered 70-col lines.
  await term.click();
  await page.keyboard.type(
    "i=0; while [ $i -lt 500 ]; do printf 'L%04d|%063d\\n' $i $i; i=$((i+1)); done; echo FLOOD-DONE",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await shot("01-flood-done");

  // Baseline scroll integrity before any geometry churn.
  await wheelScroll(-2000);
  await shot("02-baseline-scrolled");
  await checkOverlayIntegrity("baseline");
  await wheelScroll(9000);

  // Resize churn, then scroll.
  for (const [w, h] of [
    [1000, 640],
    [1180, 760],
    [900, 700],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
  }
  await shot("03-after-resizes");
  await wheelScroll(-2000);
  await shot("04-scrolled-after-resizes");
  await checkOverlayIntegrity("after-resizes");
  await wheelScroll(-3000);
  await shot("05-deeper-after-resizes");
  await checkOverlayIntegrity("deeper-after-resizes");
  await wheelScroll(9000);

  // Resize while scrolled up (overlay open), then keep scrolling.
  await wheelScroll(-2500);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(900);
  await shot("06-resized-while-scrolled");
  await checkOverlayIntegrity("resized-while-scrolled");
  await wheelScroll(-1500);
  await checkOverlayIntegrity("scroll-after-resize-while-open");
  await shot("07-scroll-after-resize-open");
  await wheelScroll(9000);

  // "Coming back to the window": hide the tab, produce output, show again.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDocumentCookieDisabled", { disabled: false }).catch(() => {});
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.keyboard.type("i=500; while [ $i -lt 560 ]; do printf 'L%04d|%063d\\n' $i $i; i=$((i+1)); done", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1000);
  await shot("08-back-from-hidden");
  await wheelScroll(-1500);
  await checkOverlayIntegrity("after-hidden-return");
  await shot("09-scroll-after-hidden");
  await wheelScroll(9000);

  // External geometry change: another window/tab resizes the PTY via the
  // server while THIS window's size stays put. Make this window (and its
  // overlay) NARROW, then widen the PTY externally and emit lines wider than
  // the overlay: bytes at the new width must not be appended into the
  // stale-geometry overlay buffer.
  await page.setViewportSize({ width: 900, height: 720 }); // ~100 cols
  await page.waitForTimeout(1200);
  await api(token, `/api/agents/${agent.id}/resize`, {
    method: "POST",
    body: JSON.stringify({ cols: 160, rows: 45 }),
  });
  await page.waitForTimeout(300);
  await term.click();
  await page.keyboard.type(
    "i=600; while [ $i -lt 680 ]; do printf 'L%04d|%0140d\\n' $i $i; i=$((i+1)); done",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("13-after-external-resize");
  await wheelScroll(-1500);
  await checkOverlayIntegrity("after-external-resize");
  await shot("14-scroll-after-external-resize");
  await wheelScroll(-2500);
  await checkOverlayIntegrity("deep-after-external-resize");
  await wheelScroll(9000);

  // Forced reconnect (network drop), then scroll.
  await page.context().setOffline(true);
  await page.waitForTimeout(2500);
  await page.context().setOffline(false);
  await page.waitForTimeout(4000);
  await shot("10-after-reconnect");
  await term.click();
  await page.keyboard.type("echo AFTER-RECONNECT", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await wheelScroll(-2000);
  await checkOverlayIntegrity("after-reconnect");
  await shot("11-scroll-after-reconnect");
  await wheelScroll(-4000);
  await checkOverlayIntegrity("deep-after-reconnect");
  await shot("12-deep-after-reconnect");
} finally {
  console.log("=== integrity problems ===");
  if (problems.length === 0) console.log("(none)");
  for (const p of problems.slice(0, 40)) console.log(p);
  console.log("=== console (non-log) ===");
  for (const l of consoleLines.filter((x) => !x.startsWith("[log]")).slice(-15)) console.log(l);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
