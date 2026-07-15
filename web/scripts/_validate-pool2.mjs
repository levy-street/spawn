// Validate agent-page <-> screen warm switch: the same agent is shared between
// the agent page and a pane, so navigating between them must not reconnect.
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
const A = await mk("pool2-A");
const B = await mk("pool2-B");
const screen = await api("/api/screens", { method: "POST", body: JSON.stringify({
  name: "pool2-screen",
  layout: { root: { type: "split", direction: "row", ratio: 0.4, a: { type: "pane", agent_id: A.id }, b: { type: "pane", agent_id: B.id } } },
}) });
console.log("A:", A.id.slice(0, 8), "screen:", screen.id.slice(0, 8));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  const W = window.WebSocket;
  window.__wsByAgent = {}; window.__errs = [];
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
const clickHref = async (href) => {
  const link = page.locator(`a[href="${href}"]`).first();
  await link.waitFor({ state: "visible", timeout: 10000 });
  await link.click();
};

try {
  await page.goto(`${BASE}/agents/${A.id}`);
  await page.getByLabel("Agent terminal").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => { window.__spa = "alive"; });
  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("echo POOL2_MARKER_XYZ", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  console.log(`agent A: wsOpens(A)=${await wsCount(A.id)}`);

  // -> screen (client-side)
  await clickHref(`/screens/${screen.id}`);
  await page.waitForFunction((u) => location.pathname === u, `/screens/${screen.id}`, { timeout: 10000 });
  await page.waitForTimeout(3500);
  const panesOnScreen = await page.getByTestId("terminal-live-host").count();
  const aRegion = page.getByRole("region", { name: "pool2-A" });
  const markerOnScreen = (await aRegion.innerText().catch(() => "")).includes("POOL2_MARKER_XYZ");
  console.log(`on screen: spa=${await page.evaluate(() => window.__spa)} panes=${panesOnScreen} wsOpens(A)=${await wsCount(A.id)} markerInApane=${markerOnScreen}`);

  // -> back to agent A page (client-side)
  await clickHref(`/agents/${A.id}`);
  await page.waitForFunction((u) => location.pathname === u, `/agents/${A.id}`, { timeout: 10000 });
  await page.waitForTimeout(3000);
  const aWs = await wsCount(A.id);
  const marker2 = (await page.getByTestId("terminal-live-host").first().innerText()).includes("POOL2_MARKER_XYZ");
  const errs = await page.evaluate(() => window.__errs || []);
  const loop = errs.filter((e) => /Maximum update depth|Too many re-renders/i.test(e));
  console.log("--- RESULT ---");
  console.log(`  stayed SPA: ${(await page.evaluate(() => window.__spa)) === "alive" ? "YES [OK]" : "NO [FAIL]"}`);
  console.log(`  screen rendered 2 panes: ${panesOnScreen === 2 ? "YES [OK]" : `NO [FAIL] (${panesOnScreen})`}`);
  console.log(`  marker in A's pane (warm): ${markerOnScreen ? "YES [OK]" : "NO [FAIL]"}`);
  console.log(`  A never reconnected (1 WS across A->screen->A): ${aWs === 1 ? "YES [OK]" : `NO [FAIL] (${aWs})`}`);
  console.log(`  marker after return: ${marker2 ? "YES [OK]" : "NO [FAIL]"}`);
  console.log(`  render loop: ${loop.length ? "FOUND [FAIL] " + loop[0] : "none [OK]"}`);
  console.log(`  console errors: ${errs.length}`);
  for (const e of errs.slice(0, 6)) console.log("    err:", String(e).slice(0, 140));
} catch (e) { console.error("ERR", e); } finally {
  await browser.close();
  await api(`/api/screens/${screen.id}`, { method: "DELETE" }).catch(() => {});
  await api(`/api/agents/${A.id}`, { method: "DELETE" }).catch(() => {});
  await api(`/api/agents/${B.id}`, { method: "DELETE" }).catch(() => {});
  console.log("cleaned up");
}
