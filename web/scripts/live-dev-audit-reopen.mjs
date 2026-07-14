// Repro audit for three reports: (1) can't scroll after reopening an agent
// page, (2) stale content framing until the sidebar is toggled, (3) repeated
// lines when scrolling while output generates.
// Run from web/:  bun scripts/live-dev-audit-reopen.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-reopen";
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
    name: "reopen-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
const shot = async (name) => {
  await page.waitForTimeout(400);
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
  await page.waitForTimeout(700);
}
async function overlayText() {
  return page
    .getByTestId("terminal-scrollback-overlay")
    .locator(".xterm-rows")
    .innerText()
    .catch(() => "");
}
async function framingMetrics(label) {
  const m = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="terminal-live-host"]');
    const screen = host?.querySelector(".xterm-screen");
    if (!host || !screen) return null;
    const h = host.getBoundingClientRect();
    const s = screen.getBoundingClientRect();
    return { hostW: h.width, hostH: h.height, screenW: s.width, screenH: s.height };
  });
  if (!m) {
    problems.push(`${label}: no terminal DOM`);
    return;
  }
  const wSlack = m.hostW - m.screenW;
  const hSlack = m.hostH - m.screenH;
  console.log(
    `${label}: host=${m.hostW.toFixed(0)}x${m.hostH.toFixed(0)} screen=${m.screenW.toFixed(0)}x${m.screenH.toFixed(0)} slack=${wSlack.toFixed(0)},${hSlack.toFixed(0)}`,
  );
  if (wSlack > 30 || hSlack > 40 || wSlack < -1 || hSlack < -1) {
    problems.push(`${label}: framing slack ${wSlack.toFixed(0)}x${hSlack.toFixed(0)}`);
  }
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
  await framingMetrics("initial-load");

  // ---- Scenario 1: transcript, then heavy in-place churn, reopen, scroll.
  await term.click();
  await page.keyboard.type(
    "i=0; while [ $i -lt 400 ]; do printf 'T%04d|transcript-line\\n' $i; i=$((i+1)); done; echo T-DONE",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  // ~1.2MB of in-place status churn (no newlines): several segment rotations.
  await page.keyboard.type(
    "i=0; while [ $i -lt 40000 ]; do printf '\\rCHURN-%06d--------------------' $i; i=$((i+1)); done; echo; echo CHURN-DONE",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(15000);
  await shot("01-after-churn");

  // Reopen: navigate to the agents list and back.
  await page.getByRole("link", { name: "Agents" }).first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/agents/${agent.id}`);
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  await framingMetrics("after-reopen");
  await shot("02-reopened");
  await wheelScroll(-1200);
  await shot("03-scroll-after-reopen");
  const overlayVisible = await page
    .getByTestId("terminal-scrollback-overlay")
    .isVisible()
    .catch(() => false);
  const text1 = await overlayText();
  const hasTranscript = /T\d{4}\|transcript-line/.test(text1);
  console.log(`reopen-scroll: overlay=${overlayVisible} transcript-visible=${hasTranscript}`);
  if (!overlayVisible) problems.push("reopen: overlay did not reveal on wheel-up");
  await wheelScroll(-6000);
  const text2 = await overlayText();
  if (!/T\d{4}\|transcript-line/.test(text2)) {
    problems.push("reopen: transcript lines unreachable in scrollback");
  }
  await shot("04-deep-scroll-after-reopen");
  await wheelScroll(12000);

  // ---- Scenario 2: repeated cold navigations, check framing each time.
  for (let n = 0; n < 4; n += 1) {
    await page.goto(`${BASE}/agents`);
    await page.waitForTimeout(600);
    await page.goto(`${BASE}/agents/${agent.id}`);
    await term.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(1200);
    await framingMetrics(`nav-${n}`);
  }
  await shot("05-after-navs");

  // ---- Scenario 3: scroll while output generates; look for repeated lines.
  await term.click();
  await page.keyboard.type(
    "i=0; while [ $i -lt 400 ]; do printf 'G%04d|%050d\\n' $i $i; i=$((i+1)); sleep 0.05; done; echo GEN-DONE",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  // Wiggle-scroll for ~12s while it streams, including a resize mid-way and
  // a return-to-bottom (overlay close) mid-generation.
  for (let k = 0; k < 6; k += 1) {
    await wheelScroll(-700);
    await wheelScroll(-300);
    await wheelScroll(500);
    if (k === 2) {
      await page.setViewportSize({ width: 1100, height: 720 });
      await page.waitForTimeout(600);
    }
    if (k === 3) await wheelScroll(9000); // close overlay mid-generation
  }
  await page.waitForTimeout(9000); // let generation finish
  await wheelScroll(12000);
  await shot("06-generation-done");
  // Sweep the whole scrollback checking for duplicate G-tokens.
  const seen = new Map();
  await wheelScroll(-20000);
  for (let step = 0; step < 24; step += 1) {
    const text = await overlayText();
    for (const m of text.matchAll(/G(\d{4})\|/g)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    // Row-level duplicate detection within one screen: same token twice.
    const counts = {};
    for (const m of text.matchAll(/G(\d{4})\|/g)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    for (const [tok, c] of Object.entries(counts)) {
      if (c > 1) problems.push(`generation: G${tok} appears ${c}x in one screen (step ${step})`);
    }
    await wheelScroll(800);
  }
  await shot("07-sweep-done");
} finally {
  console.log("=== problems ===");
  if (problems.length === 0) console.log("(none)");
  for (const p of [...new Set(problems)].slice(0, 30)) console.log(p);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
