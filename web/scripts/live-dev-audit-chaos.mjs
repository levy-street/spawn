// Chaos gauntlet: actively try to break the terminal pipeline. Each phase
// ends with a responsiveness probe (typed marker must echo) and the run ends
// with a scrollback integrity sweep and a daemon-journal check.
// Run from web/:  bun scripts/live-dev-audit-chaos.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-chaos";
const RESTART_DAEMON = process.env.SPAWN_CHAOS_RESTART_DAEMON === "1";
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
    name: "chaos-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};
const term = () => page.getByLabel("Agent terminal");
async function wheelScroll(dy) {
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  const target = (await overlay.isVisible().catch(() => false))
    ? overlay
    : page.getByTestId("terminal-live-host").locator(".xterm");
  await target.hover();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(600);
}
async function run(cmd) {
  await term().click();
  await page.keyboard.type(cmd, { delay: 3 });
  await page.keyboard.press("Enter");
}
let probeN = 0;
async function probeResponsive(label) {
  probeN += 1;
  const marker = `PROBE-${String(probeN).padStart(2, "0")}-OK`;
  await term().click();
  await page.keyboard.type(`echo ${marker}`, { delay: 8 });
  await page.keyboard.press("Enter");
  const rows = page.getByTestId("terminal-live-host").locator(".xterm-rows");
  try {
    await rows.getByText(marker, { exact: false }).first().waitFor({ timeout: 8000 });
    console.log(`responsive after ${label}`);
  } catch {
    problems.push(`${label}: terminal unresponsive (no ${marker})`);
    await shot(`FAIL-${label}`);
  }
}

try {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  await page.goto(`${BASE}/agents/${agent.id}`);
  await term().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2000);

  // Anchor tokens we can verify reach scrollback intact at the very end.
  await run("i=0; while [ $i -lt 60 ]; do printf 'ANCHOR-%03d|start-of-session\\n' $i; i=$((i+1)); done");
  await page.waitForTimeout(1200);

  // ---- Phase 1: binary garbage.
  await run("head -c 2000000 /dev/urandom; echo; echo URANDOM-DONE");
  await page.waitForTimeout(8000);
  await run("reset");
  await page.waitForTimeout(1500);
  await probeResponsive("urandom");
  await shot("01-after-urandom");

  // ---- Phase 2: unterminated giant OSC (checkpoint defer-cap territory),
  // then terminate it and keep going.
  await run(
    "printf '\\033]0;'; head -c 120000 /dev/zero | tr '\\0' 'x'; sleep 1; printf '\\007'; echo OSC-DONE",
  );
  await page.waitForTimeout(5000);
  await probeResponsive("giant-osc");

  // ---- Phase 3: one 500KB line, no newlines, then wrap-heavy output.
  await run("head -c 500000 /dev/zero | tr '\\0' 'w'; echo; echo BIGLINE-DONE");
  await page.waitForTimeout(6000);
  await probeResponsive("bigline");
  await wheelScroll(-2000);
  await shot("02-scroll-after-bigline");
  await wheelScroll(9000);

  // ---- Phase 4: emoji + CJK flood across rotations.
  await run(
    "i=0; while [ $i -lt 500 ]; do printf 'E%03d|\\xF0\\x9F\\x98\\x80\\xE4\\xBD\\xA0\\xE5\\xA5\\xBD\\xF0\\x9F\\x91\\xA9\\xE2\\x80\\x8D\\xF0\\x9F\\x92\\xBB-end\\n' $i; i=$((i+1)); done; echo EMOJI-DONE",
  );
  await page.waitForTimeout(4000);
  await probeResponsive("emoji");
  await wheelScroll(-1500);
  await shot("03-scroll-emoji");
  await wheelScroll(9000);

  // ---- Phase 5: scroll region app with churn.
  await run(
    "printf '\\033[5;20r'; i=0; while [ $i -lt 3000 ]; do printf 'R%04d|region-line\\n' $i; i=$((i+1)); done; printf '\\033[r'; echo REGION-DONE",
  );
  await page.waitForTimeout(5000);
  await probeResponsive("scroll-region");

  // ---- Phase 6: alt-screen app churn + reload mid-app.
  await run("man bash || less /etc/services");
  await page.waitForTimeout(2000);
  for (let i = 0; i < 30; i += 1) await page.keyboard.press("PageDown");
  await page.reload();
  await term().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot("04-reload-mid-pager");
  await term().click();
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("PageDown");
  await page.keyboard.press("q");
  await page.waitForTimeout(1000);
  await probeResponsive("pager-alt-screen");
  await shot("05-after-pager-quit");

  // ---- Phase 7: daemon restart mid-stream (worker survivability).
  if (RESTART_DAEMON) {
    await run(
      "i=0; while [ $i -lt 600 ]; do printf 'D%04d|during-daemon-restart\\n' $i; i=$((i+1)); sleep 0.02; done; echo RESTART-STREAM-DONE",
    );
    await page.waitForTimeout(1500);
    execSync("systemctl --user restart spawnd-dev.service");
    console.log("daemon restarted mid-stream");
    await page.waitForTimeout(12000);
    await probeResponsive("daemon-restart");
    await wheelScroll(-1500);
    await shot("06-scroll-after-daemon-restart");
    // The stream that crossed the restart must be gapless in scrollback.
    const text = await page
      .getByTestId("terminal-scrollback-overlay")
      .locator(".xterm-rows")
      .innerText()
      .catch(() => "");
    const tokens = [...text.matchAll(/D(\d{4})\|/g)].map((m) => Number(m[1]));
    for (let i = 1; i < tokens.length; i += 1) {
      if (tokens[i] !== tokens[i - 1] + 1 && tokens[i] > tokens[i - 1]) {
        problems.push(`daemon-restart: gap in stream D${tokens[i - 1]} -> D${tokens[i]}`);
      }
    }
    await wheelScroll(9000);
  }

  // ---- Phase 8: network flapping while streaming.
  await run(
    "i=0; while [ $i -lt 400 ]; do printf 'N%04d|during-net-flaps\\n' $i; i=$((i+1)); sleep 0.02; done; echo NET-STREAM-DONE",
  );
  for (let i = 0; i < 3; i += 1) {
    await context.setOffline(true);
    await page.waitForTimeout(1200);
    await context.setOffline(false);
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(4000);
  await probeResponsive("net-flaps");
  await shot("07-after-net-flaps");

  // ---- Phase 9: second window fights for control.
  const page2 = await context.newPage();
  await page2.setViewportSize({ width: 900, height: 650 });
  await page2.goto(`${BASE}/agents/${agent.id}`);
  await page2.getByLabel("Agent terminal").waitFor({ state: "visible", timeout: 15000 });
  await page2.waitForTimeout(2500);
  await page2.getByLabel("Agent terminal").click();
  await page2.keyboard.type("echo FROM-WINDOW-TWO", { delay: 8 });
  await page2.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("08-window-one-as-viewer");
  // Window one reclaims by clicking and typing.
  await page.bringToFront();
  await term().click();
  await page.waitForTimeout(1500);
  await probeResponsive("control-fight");
  await page2.close();
  await page.waitForTimeout(2000);
  await shot("09-after-window-two-closed");

  // ---- Final integrity sweep: anchors still reachable, no duplicate tokens.
  await wheelScroll(-30000);
  const seenAnchors = new Set();
  let dupes = 0;
  for (let step = 0; step < 30; step += 1) {
    const text = await page
      .getByTestId("terminal-scrollback-overlay")
      .locator(".xterm-rows")
      .innerText()
      .catch(() => "");
    const counts = {};
    for (const m of text.matchAll(/(ANCHOR-\d{3}|E\d{3}|R\d{4}|N\d{4}|D\d{4})\|/g)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
      if (m[1].startsWith("ANCHOR")) seenAnchors.add(m[1]);
    }
    for (const [tok, c] of Object.entries(counts)) {
      if (c > 1) {
        dupes += 1;
        if (dupes < 5) problems.push(`sweep: ${tok} x${c} in one screen (step ${step})`);
      }
    }
    await wheelScroll(900);
  }
  console.log(`sweep: anchors-visible=${seenAnchors.size}`);
  await shot("10-final");
} finally {
  console.log("=== problems ===");
  if (problems.length === 0) console.log("(none)");
  for (const p of [...new Set(problems)].slice(0, 30)) console.log(p);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
