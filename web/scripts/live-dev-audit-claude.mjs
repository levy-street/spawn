// Real-workload audit: drives an actual `claude` CLI agent (Ink renderer,
// DECSC/DECRC frames, constant redraws) on the deployed dev stack. Types into
// the input box without submitting (no API spend), reloads mid-session,
// scrolls, and resizes. Run from web/:  bun scripts/live-dev-audit-claude.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-claude";
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
    name: "claude-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLines = [];
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));
const shot = async (name) => {
  await page.waitForTimeout(500);
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
  await page.waitForTimeout(6000); // claude startup render
  await shot("01-claude-started");

  await term.click();
  await page.keyboard.type("first line of a draft prompt that is not submitted", { delay: 15 });
  await shot("02-typed-in-box");

  // Reload mid-session: seed must reproduce the box with the typed text.
  await page.reload();
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(3000);
  await shot("03-after-reload");
  await term.click();
  await page.keyboard.type(" plus more typed after reload", { delay: 15 });
  await shot("04-typed-after-reload");

  // Window resize: Ink re-renders; layout must stay coherent.
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.waitForTimeout(1500);
  await shot("05-after-resize");
  await page.keyboard.type(" and after resize", { delay: 15 });
  await shot("06-typed-after-resize");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1500);
  await shot("07-resized-back");

  // Second reload after the resize churn.
  await page.reload();
  await term.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(3000);
  await shot("08-second-reload");

  // Wheel scrollback over the claude UI.
  await page.getByTestId("terminal-live-host").locator(".xterm").hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1000);
  await shot("09-scrolled");
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(800);
  await shot("10-back-live");
  await term.click();
  await page.keyboard.type(" final typing check", { delay: 15 });
  await shot("11-final-typing");

  const tail = await page.getByTestId("terminal-live-host").locator(".xterm-rows").innerText();
  console.log("=== visible tail ===");
  console.log(tail.split("\n").slice(-14).join("\n"));
} finally {
  console.log("=== console (errors only) ===");
  for (const line of consoleLines.filter((l) => !l.startsWith("[log]")).slice(-20))
    console.log(line);
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
