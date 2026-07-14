// Screens UX survey: create agents + a screen, capture the states that
// matter for the integration review (tabs, panes, focus, zoom, empty state,
// narrow stack, agent-page contrast). Run from web/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPAWN_DEV_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SPAWN_DEV_EMAIL;
const PASSWORD = process.env.SPAWN_DEV_PASSWORD;
const HOST_ID = process.env.SPAWN_DEV_HOST_ID;
const OUT = process.env.SPAWN_AUDIT_OUT ?? "/tmp/live-dev-audit-screens";
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
const mk = (name, cmd) =>
  api(token, "/api/agents", {
    method: "POST",
    body: JSON.stringify({ host_id: HOST_ID, cwd: "/tmp", argv: ["bash", "--norc", "-c", cmd], name }),
  });
const a1 = await mk("ux-alpha", "for i in $(seq 1 40); do echo alpha-line-$i; done; exec bash --norc");
const a2 = await mk("ux-beta", "for i in $(seq 1 40); do echo beta-line-$i; done; exec bash --norc");
const a3 = await mk("ux-gamma", "for i in $(seq 1 40); do echo gamma-line-$i; done; exec bash --norc");
const screen = await api(token, "/api/screens", {
  method: "POST",
  body: JSON.stringify({
    name: "ux-review",
    layout: {
      root: {
        type: "split",
        direction: "row",
        ratio: 0.6,
        a: { type: "pane", agent_id: a1.id },
        b: {
          type: "split",
          direction: "column",
          ratio: 0.5,
          a: { type: "pane", agent_id: a2.id },
          b: { type: "pane", agent_id: a3.id },
        },
      },
    },
  }),
});
console.log("screen:", screen.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};
try {
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });

  await page.goto(`${BASE}/screens`);
  await shot("01-screens-index");
  await page.goto(`${BASE}/screens/${screen.id}`);
  await page.waitForTimeout(3500);
  await shot("02-screen-three-panes");

  // Focus the second pane.
  await page.getByRole("region", { name: "ux-beta" }).click({ position: { x: 200, y: 200 } });
  await shot("03-focused-beta");

  // Zoom beta.
  await page.getByLabel("Zoom pane").nth(1).click();
  await page.waitForTimeout(800);
  await shot("04-zoomed-beta");
  await page.getByLabel("Restore pane").click();
  await page.waitForTimeout(600);

  // Narrow container: stacked panes.
  await page.setViewportSize({ width: 640, height: 860 });
  await page.waitForTimeout(1000);
  await shot("05-narrow-stacked");
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.waitForTimeout(800);

  // Files panel for focused pane.
  await page.getByLabel("Toggle files panel").click();
  await shot("06-files-panel");
  await page.getByLabel("Toggle files panel").click();

  // Agent page for chrome contrast.
  await page.goto(`${BASE}/agents/${a1.id}`);
  await page.waitForTimeout(2500);
  await shot("07-agent-page-contrast");

  // Agents list for nav contrast.
  await page.goto(`${BASE}/agents`);
  await page.waitForTimeout(1200);
  await shot("08-agents-list");
} finally {
  await browser.close();
  await api(token, `/api/screens/${screen.id}`, { method: "DELETE" }).catch(() => {});
  for (const a of [a1, a2, a3])
    await api(token, `/api/agents/${a.id}`, { method: "DELETE" }).catch(() => {});
  console.log("cleaned up");
}
