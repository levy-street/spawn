import { test } from "@playwright/test";

const OUT = process.env.SHOT_DIR ?? "/tmp/press-shots";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

test.use({ userAgent: MAC_UA, viewport: { width: 1440, height: 1000 } });

for (const [name, path] of [
  ["landing", "/"],
  ["security", "/security"],
  ["download", "/download"],
] as const) {
  test(`shot ${name}`, async ({ page }) => {
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await page.goto(path);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${name}-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${name}-390.png`, fullPage: true });
  });
}
