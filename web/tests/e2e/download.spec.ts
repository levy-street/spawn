import { type Browser, expect, type Page, test } from "@playwright/test";

type PlatformPageOptions = {
  platform: string;
  userAgent: string;
  viewport?: { width: number; height: number };
};

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
const LINUX_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
const WINDOWS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
const UNKNOWN_USER_AGENT =
  "Mozilla/5.0 (X11; FreeBSD amd64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

async function newPlatformPage(
  browser: Browser,
  { platform, userAgent, viewport = { width: 1280, height: 900 } }: PlatformPageOptions,
) {
  const context = await browser.newContext({ userAgent, viewport });
  await context.addInitScript((value) => {
    Object.defineProperty(window.navigator, "platform", {
      get: () => value,
    });
  }, platform);
  const page = await context.newPage();
  return { context, page };
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
}

test("macOS detection recommends LaunchAgent and copies the current-origin command", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });

  await page.goto("/download");
  const origin = new URL(page.url()).origin;
  const command = `curl -fsSL ${origin}/install.sh | sh`;

  await expect(page.getByText("Detected browser OS")).toBeVisible();
  await expect(
    page.locator("section").first().getByRole("heading", { name: "macOS" }),
  ).toBeVisible();
  await expect(page.getByText("LaunchAgent: app.spawn.spawnd")).toBeVisible();
  await expect(page.locator("code").first()).toHaveText(command);

  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByRole("button", { name: "Copy command" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.navigator.clipboard.readText())).toBe(command);

  await context.close();
});

test("Linux detection recommends the user systemd service", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Linux x86_64",
    userAgent: LINUX_USER_AGENT,
  });

  await page.goto("/download");

  await expect(
    page.locator("section").first().getByRole("heading", { name: "Linux" }),
  ).toBeVisible();
  await expect(page.getByText("systemd user service: spawnd.service")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Install on this Linux host" })).toBeVisible();

  await context.close();
});

test("Windows detection points users to a supported host", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
  });

  await page.goto("/download");

  await expect(
    page.locator("section").first().getByRole("heading", { name: "Windows" }),
  ).toBeVisible();
  await expect(page.getByText("Use a macOS or Linux host")).toBeVisible();
  await expect(page.getByText("Windows service support is not available yet.")).toBeVisible();
  await expect(
    page.getByText("Use this command from a supported macOS or Linux terminal"),
  ).toBeVisible();

  await context.close();
});

test("unknown browser OS explains that the installer detects the actual host", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "FreeBSD amd64",
    userAgent: UNKNOWN_USER_AGENT,
  });

  await page.goto("/download");

  await expect(
    page.locator("section").first().getByRole("heading", { name: "Unknown OS" }),
  ).toBeVisible();
  await expect(page.getByText("will detect the actual host when it runs")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run from a host terminal" })).toBeVisible();

  await context.close();
});

test("landing page install CTA opens the download page", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "not authenticated" }),
    });
  });
  await page.goto("/");

  await page.getByRole("link", { name: "Install daemon" }).click();

  await expect(page).toHaveURL(/\/download$/);
  await expect(
    page.getByRole("heading", { name: "Download the right daemon for this host." }),
  ).toBeVisible();
});

test("download page does not overflow on desktop or mobile", async ({ browser }) => {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    const { context, page } = await newPlatformPage(browser, {
      platform: "MacIntel",
      userAgent: MAC_USER_AGENT,
      viewport,
    });
    await page.goto("/download");
    await expect(
      page.getByRole("heading", { name: "Download the right daemon for this host." }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/download-${name}.png`, fullPage: true });
    await context.close();
  }
});
