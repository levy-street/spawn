// Validate the warm pool across CLIENT-SIDE navigation (the only kind that
// preserves it). Full page loads remount the provider, so we navigate by
// clicking in-app links and assert the SPA never reloaded.
import { chromium } from "@playwright/test";

const BASE = "http://125.236.228.41:8330";
const TOKEN = process.env.TOK;
const HOST_ID = "e7660bae-7522-47c8-bd91-7cdb2c5e8c5a";
if (!TOKEN) { console.error("set TOK"); process.exit(1); }
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: `spawn_session=${TOKEN}`, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const mk = (n) => api("/api/agents", { method: "POST", body: JSON.stringify({ host_id: HOST_ID, cwd: "/tmp", argv: ["bash"], name: n }) });
const A = await mk("pool-A");
const B = await mk("pool-B");
console.log("A:", A.id.slice(0, 8), "B:", B.id.slice(0, 8));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  const W = window.WebSocket;
  window.__wsByAgent = {};
  window.__errs = [];
  window.WebSocket = new Proxy(W, { construct(t, args) {
    const id = (String(args[0] || "").match(/agent_id=([0-9a-f-]+)/) || [])[1] || "?";
    const s = new t(...args);
    s.addEventListener("open", () => { (window.__wsByAgent[id] ||= []).push(1); });
    return s;
  }});
});
await context.addCookies([{ name: "spawn_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
page.on("pageerror", (e) => page.evaluate((t) => window.__errs?.push("PAGEERROR " + t), e.message).catch(() => {}));
page.on("console", (m) => { if (m.type() === "error") page.evaluate((t) => window.__errs?.push(t), m.text()).catch(() => {}); });

const wsCount = (id) => page.evaluate((a) => (window.__wsByAgent[a] || []).length, id);
// Client-side navigate by clicking the sidebar link for an agent's href.
const navTo = async (id) => {
  const link = page.locator(`a[href="/agents/${id}"]`).first();
  await link.waitFor({ state: "visible", timeout: 10000 });
  await link.click();
  await page.waitForFunction((u) => location.pathname === u, `/agents/${id}`, { timeout: 10000 });
  await page.waitForTimeout(2500);
};

try {
  await page.goto(`${BASE}/agents/${A.id}`);
  await page.getByLabel("Agent terminal").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => { window.__spa = "alive"; }); // survives only if no full reload
  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("echo POOL_MARKER_A_UNIQUE", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  console.log(`A first load: wsOpens(A)=${await wsCount(A.id)}`);

  await navTo(B.id);
  console.log(`nav->B: spa=${await page.evaluate(() => window.__spa)} wsOpens(B)=${await wsCount(B.id)} wsOpens(A)=${await wsCount(A.id)}`);

  await navTo(A.id);
  const spa = await page.evaluate(() => window.__spa);
  const aWs = await wsCount(A.id);
  const marker = (await page.getByTestId("terminal-live-host").first().innerText()).includes("POOL_MARKER_A_UNIQUE");
  const errs = await page.evaluate(() => window.__errs || []);
  const loop = errs.filter((e) => /Maximum update depth|Too many re-renders/i.test(e));
  console.log(`nav->A(return): spa=${spa} wsOpens(A)=${aWs} marker=${marker}`);
  console.log("--- RESULT ---");
  console.log(`  stayed SPA (no reload): ${spa === "alive" ? "YES [OK]" : "NO [FAIL - test invalid]"}`);
  console.log(`  A warm (1 WS, no reconnect on return): ${aWs === 1 ? "YES [OK]" : `NO [FAIL] (${aWs})`}`);
  console.log(`  buffer preserved live: ${marker ? "YES [OK]" : "NO [FAIL]"}`);
  console.log(`  render loop: ${loop.length ? "FOUND [FAIL] " + loop[0] : "none [OK]"}`);
  console.log(`  console errors: ${errs.length}`);
  for (const e of errs.slice(0, 5)) console.log("    err:", String(e).slice(0, 140));
} catch (e) { console.error("ERR", e); } finally {
  await browser.close();
  await api(`/api/agents/${A.id}`, { method: "DELETE" }).catch(() => {});
  await api(`/api/agents/${B.id}`, { method: "DELETE" }).catch(() => {});
  console.log("cleaned up");
}
