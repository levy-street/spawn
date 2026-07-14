// Flash detector: sample the terminal area rapidly while (a) holding the
// scrollback overlay open over a streaming agent and (b) repeatedly closing
// it by scrolling off the bottom. A visibly blank frame compresses far
// smaller than a text-filled one, so a sharp PNG-size dip flags a flash.
// Run from web/:  bun scripts/live-dev-audit-flash.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-flash";
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
    name: "flash-audit",
  }),
});
console.log("agent:", agent.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const term = () => page.getByLabel("Agent terminal");
async function wheelScroll(dy, settle = 500) {
  const overlay = page.getByTestId("terminal-scrollback-overlay");
  const target = (await overlay.isVisible().catch(() => false))
    ? overlay
    : page.getByTestId("terminal-live-host").locator(".xterm");
  await target.hover();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(settle);
}

// Sample the terminal region; return {sizes, dips} where a dip is a frame
// <45% of the rolling median of its neighbors.
async function sample(label, ms, everyMs = 90) {
  const clip = await page
    .getByTestId("terminal-live-host")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })
    .catch(() => null);
  if (!clip) return [];
  const sizes = [];
  const started = Date.now();
  while (Date.now() - started < ms) {
    const buf = await page.screenshot({ clip });
    sizes.push({ t: Date.now() - started, n: buf.length, buf });
    const wait = everyMs - ((Date.now() - started) % everyMs);
    if (wait > 5) await page.waitForTimeout(wait);
  }
  const dips = [];
  for (let i = 1; i < sizes.length - 1; i += 1) {
    const around = [sizes[i - 1].n, sizes[i + 1].n].sort((a, b) => a - b);
    const ref = around[1];
    if (sizes[i].n < ref * 0.45) {
      dips.push(sizes[i]);
      writeFileSync(`${OUT}/${label}-dip-${sizes[i].t}ms.png`, sizes[i].buf);
      if (i > 0) writeFileSync(`${OUT}/${label}-dip-${sizes[i].t}ms-before.png`, sizes[i - 1].buf);
    }
  }
  console.log(
    `${label}: frames=${sizes.length} median=${[...sizes.map((s) => s.n)].sort((a, b) => a - b)[Math.floor(sizes.length / 2)]} dips=${dips.length}${dips.length ? " at " + dips.map((d) => `${d.t}ms(${d.n}B)`).join(",") : ""}`,
  );
  return dips;
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

  // Backlog + slow continuous stream (fresh output every ~150ms for ~3min).
  await term().click();
  await page.keyboard.type(
    "i=0; while [ $i -lt 300 ]; do printf 'B%04d|backlog-content-line\\n' $i; i=$((i+1)); done; " +
      "i=0; while [ $i -lt 1200 ]; do printf 'S%04d|streamed-content-line\\n' $i; i=$((i+1)); sleep 0.15; done",
    { delay: 3 },
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  // A) Overlay held open over a streaming agent for 45s (periodic re-render
  // flash would show here).
  await wheelScroll(-900);
  const overlayVisible = await page.getByTestId("terminal-scrollback-overlay").isVisible();
  console.log("overlay open:", overlayVisible);
  const dipsOpen = await sample("held-open", 45000);

  // B) Ten open/close cycles: scroll up, then off the bottom, sampling
  // through each close transition.
  let closeDips = 0;
  for (let k = 0; k < 10; k += 1) {
    await wheelScroll(-800, 350);
    const clip = await page.getByTestId("terminal-live-host").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const frames = [];
    // Kick the close and sample tightly through the transition.
    const overlay = page.getByTestId("terminal-scrollback-overlay");
    await overlay.hover();
    await page.mouse.wheel(0, 4000);
    for (let i = 0; i < 14; i += 1) {
      const buf = await page.screenshot({ clip });
      frames.push(buf);
      await page.waitForTimeout(60);
    }
    for (let i = 1; i < frames.length - 1; i += 1) {
      const ref = Math.max(frames[i - 1].length, frames[i + 1].length);
      if (frames[i].length < ref * 0.45) {
        closeDips += 1;
        writeFileSync(`${OUT}/close-${k}-frame-${i}.png`, frames[i]);
        writeFileSync(`${OUT}/close-${k}-frame-${i}-before.png`, frames[i - 1]);
      }
    }
    await page.waitForTimeout(400);
  }
  console.log(`close-cycles: dips=${closeDips}`);
  console.log(`RESULT held-open-dips=${dipsOpen.length} close-dips=${closeDips}`);
} finally {
  await browser.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" }).catch(() => {});
  console.log("agent deleted");
}
