import { test } from "@playwright/test";
import { HOST_ID, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

test("empty state", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("spawn.theme", "dark"));
  await mockApp(page, {
    workspaces: [workspace({ host_id: HOST_ID, cwd: "/Users/tester/Desktop" })],
    sessions: [],
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("toolbar", { name: "Add a window" }).waitFor();
  await page
    .locator("img[src*='empty-ink']")
    .evaluate((img: HTMLImageElement) => (img.complete ? null : img.decode()));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "/tmp/empty-dark.png" });
});
