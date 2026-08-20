import { test } from "@playwright/test";
import { mockApp, user } from "./app-mocks";

const OUT = process.env.SHOT_DIR ?? "/tmp/shots";

test("login stacked", async ({ page }) => {
  await mockApp(page, { me: null, config: { providers: [{ id: "google", name: "Google" }] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 40_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/login-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/login-390.png`, fullPage: true });
});

test("onboarding split unchanged", async ({ page }) => {
  await mockApp(page, { me: user, hosts: [], workspaces: [] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/onboarding");
  await page.getByRole("heading", { name: "Connect your first host" }).waitFor({ timeout: 40_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/host-1440x900.png` });
});
