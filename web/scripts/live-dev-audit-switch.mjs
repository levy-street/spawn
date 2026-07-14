// Repro: switching agents via the sidebar (client-side navigation) leaves
// the terminal wrapping at a stale width until a container resize. Measures
// the PTY's belief ($COLUMNS), the visual wrap width of a ruler line, and
// the fitted geometry after every switch.
// Run from web/:  bun scripts/live-dev-audit-switch.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-switch";
if (!EMAIL || !PASSWORD || !HOST_ID) {
  console.error("set env");
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
const mk = (name) =>
  api(token, "/api/agents", {
    method: "POST",
    body: JSON.stringify({
      host_id: HOST_ID,
      cwd: "/tmp",
      argv: ["bash", "--norc", "--noprofile"],
      name,
    }),
  });
const agentA = await mk("switch-a");
const agentB = await mk("switch-b");
console.log("agents:", agentA.id, agentB.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
const term = () => page.getByLabel("Agent terminal");
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

async function measure(label) {
  await term().click();
  await page.keyboard.type('printf "R%.0s" $(seq 1 400); echo; echo "COLS=$COLUMNS"', {
    delay: 3,
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const rows = [
      ...(document.querySelector('[data-testid="terminal-live-host"] .xterm-rows')?.children ??
        []),
    ];
    let ruler = 0;
    let cols = null;
    for (const row of rows) {
      const t = row.textContent ?? "";
      const m = t.match(/^R+$/) || t.match(/^(R+)\s*$/);
      if (m) ruler = Math.max(ruler, (m[1] ?? m[0]).length);
      const c = t.match(/COLS=(\d+)/);
      if (c) cols = Number(c[1]);
    }
    const host = document
      .querySelector('[data-testid="terminal-live-host"]')
      ?.getBoundingClientRect();
    const screen = document
      .querySelector('[data-testid="terminal-live-host"] .xterm-screen')
      ?.getBoundingClientRect();
    return {
      ruler,
      cols,
      hostW: Math.round(host?.width ?? 0),
      screenW: Math.round(screen?.width ?? 0),
    };
  });
  console.log(
    `${label}: visual-wrap=${info.ruler} pty-cols=${info.cols} host=${info.hostW}px screen=${info.screenW}px`,
  );
  if (info.cols !== null && info.ruler !== 0 && info.cols !== info.ruler) {
    problems.push(`${label}: PTY cols ${info.cols} != visual wrap ${info.ruler}`);
  }
  if (info.hostW - info.screenW > 30) {
    problems.push(`${label}: screen ${info.screenW}px leaves ${info.hostW - info.screenW}px slack`);
  }
  return info;
}

async function switchTo(name) {
  // Client-side navigation via the sidebar entry.
  await page.getByRole("link", { name: new RegExp(name) }).first().click();
  await term().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(1800);
}

try {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });

  await page.goto(`${BASE}/agents/${agentA.id}`);
  await term().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2000);
  await measure("A-fresh");

  // Prime B once so both have shells ready.
  await switchTo("switch-b");
  await measure("B-first-switch");
  await shot("01-B-first-switch");

  // Seed-width scenario: B's PTY is resized by "another window" to 90 cols
  // and paints a 200-char ruler at that width. Switching to B seeds the
  // terminal with 90-col content inside this window's 128-col terminal; the
  // reseed must rewrap it within a few seconds without any local resize.
  const maxRulerRun = () =>
    page.evaluate(() => {
      const rows = [
        ...(document.querySelector('[data-testid="terminal-live-host"] .xterm-rows')?.children ??
          []),
      ];
      let max = 0;
      for (const row of rows) {
        for (const m of (row.textContent ?? "").matchAll(/S+/g)) {
          max = Math.max(max, m[0].length);
        }
      }
      return max;
    });
  for (let k = 0; k < 3; k += 1) {
    await switchTo("switch-a");
    await measure(`A-switch-${k}`);
    await api(token, `/api/agents/${agentB.id}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols: 90, rows: 25 }),
    });
    await page.waitForTimeout(500);
    await api(token, `/api/agents/${agentB.id}/input`, {
      method: "POST",
      body: JSON.stringify({ text: 'printf "S%.0s" $(seq 1 200); echo\n' }),
    });
    await page.waitForTimeout(800);
    await switchTo("switch-b");
    const seeded = await maxRulerRun();
    await shot(`03-B-switch-${k}-seeded`);
    await page.waitForTimeout(4500);
    const healed = await maxRulerRun();
    await shot(`04-B-switch-${k}-healed`);
    console.log(`B-switch-${k}: seeded-ruler=${seeded} healed-ruler=${healed}`);
    if (healed <= 90 && healed !== 0) {
      problems.push(`B-switch-${k}: seeded 90-col content never rewrapped (still ${healed})`);
    }
  }
} finally {
  console.log("=== problems ===");
  if (problems.length === 0) console.log("(none)");
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(p);
  await browser.close();
  for (const a of [agentA, agentB]) {
    await api(token, `/api/agents/${a.id}`, { method: "DELETE" }).catch(() => {});
  }
  console.log("agents deleted");
}
