import { expect, test } from "@playwright/test";
import { mockApp, WORKSPACE_ID } from "./app-mocks";

const OUT =
  "/private/tmp/claude-501/-Users-charliesaxton-dev-spawn/6d00294e-752a-4198-ba96-a9f38a5d11ef/scratchpad";

test("brand lockup shots", async ({ page }) => {
  await mockApp(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  const header = page.locator("aside .pt-3").first();
  await expect(header).toBeVisible();
  await header.screenshot({ path: `${OUT}/brand-final.png`, scale: "device" });

  // the wordmark is a live target: hovering it lights the trident's plate
  await page.locator("aside a[href='/'][aria-hidden='true']").hover();
  await header.screenshot({ path: `${OUT}/brand-hover-word.png`, scale: "device" });

  // collapsed: hovering anywhere on the rail swaps the mark for the control
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.waitForTimeout(400);
  const rail = page.locator("aside");
  await rail.screenshot({ path: `${OUT}/rail-rest.png`, scale: "device" });
  await page.getByRole("button", { name: "Account menu" }).hover();
  await page.waitForTimeout(250);
  await rail.screenshot({ path: `${OUT}/rail-hover.png`, scale: "device" });
});
