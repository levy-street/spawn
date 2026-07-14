// Live validation against the deployed dev stack: real login, real agent on
// a real worker, typing / scrolling / resizing, with screenshots and console
// capture. Run from web/:  bun scripts/live-dev-audit.mjs
// Screenshots land in /tmp/live-dev-audit/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit";
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
      ...(init.headers ?? {}),
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
    name: "live-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};

try {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });

  await page.goto(`${BASE}/agents/${agent.id}`);
  const term = page.getByLabel("Agent terminal");
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot("01-connected");

  // Typing at the prompt.
  await term.click();
  await page.keyboard.type("echo first-line-marker", { delay: 30 });
  await shot("02-typed-command");
  await page.keyboard.press("Enter");
  await page.keyboard.type("for i in $(seq 1 200); do printf 'audit-%03d\\n' $i; done", {
    delay: 5,
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("03-after-flood");

  // Type again after the flood — the user's "inputting causes layout issues".
  await page.keyboard.type("echo second-marker-after-flood", { delay: 30 });
  await shot("04-typing-after-flood");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await shot("05-after-second-echo");

  // Wheel scrollback up, hold, scroll further, return to bottom.
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(800);
  await shot("06-scrolled-up");
  await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(800);
  await shot("07-scrolled-more");
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(800);
  await shot("08-back-to-bottom");

  // Resize the window, then type again.
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.waitForTimeout(1200);
  await shot("09-after-resize");
  await page.keyboard.type("echo after-resize-marker", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await shot("10-typed-after-resize");

  // Resize back and scroll again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1200);
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(800);
  await shot("11-scroll-after-resizes");
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(500);
  await shot("12-final-bottom");

  // Page reload mid-session: exercises the onHistory seed path (where the
  // 80x24 bogus-resize regression lived).
  await page.reload();
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot("13-after-reload");
  await term.click();
  await page.keyboard.type("echo after-reload-marker", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await shot("14-typed-after-reload");

  // Full-screen TUI simulating a claude-style bottom-anchored redraw loop:
  // transcript above, a box redrawn at the bottom on every tick.
  const tui = [
    "i=0; while [ $i -lt 400 ]; do",
    "  printf '\\033[2K\\rtranscript-%03d\\n' $i;",
    "  printf '\\033[s\\033[999;1H\\033[2K+----------------+\\033[u';",
    "  i=$((i+1)); sleep 0.01;",
    "done; printf '\\nTUI-DONE\\n'",
  ].join(" ");
  await page.keyboard.type(tui, { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await shot("15-tui-running");
  // Reload while the TUI floods (worst case for seed correctness).
  await page.reload();
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot("16-reload-during-tui");
  await page.waitForTimeout(3500);
  await shot("17-tui-done");
  await term.click();
  await page.keyboard.type("echo final-marker", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await shot("18-typed-after-tui");

  // Scroll through the TUI transcript history.
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(800);
  await shot("19-scroll-tui-history");
  await page.mouse.wheel(0, 9000);
  await page.waitForTimeout(500);
  await shot("20-final");

  // Surface the terminal's visible text tail for quick sanity in the log.
  const tail = await page
    .getByTestId("terminal-live-host")
    .locator(".xterm-rows")
    .innerText();
  console.log("=== visible tail ===");
  console.log(tail.split("\n").slice(-12).join("\n"));
} finally {
  console.log("=== console ===");
  for (const line of consoleLines.slice(-60)) console.log(line);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
