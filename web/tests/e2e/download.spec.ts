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
  await expect(page.getByText("Install on this Linux host")).toBeVisible();

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
  await expect(page.getByText("Run from a host terminal")).toBeVisible();

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

  await page.getByRole("link", { name: "Install the daemon" }).first().click();

  await expect(page).toHaveURL(/\/download$/);
  await expect(
    page.getByRole("heading", { name: "Install the daemon. Possess the host." }),
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
      page.getByRole("heading", { name: "Install the daemon. Possess the host." }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/download-${name}.png`, fullPage: true });
    await context.close();
  }
});

/**
 * The hero slab is painted before `/api/release` names the build, and a press
 * in that window used to be spent walking to /download. It now waits and then
 * hands the file over — see `MacDownloadButton`.
 */
async function landingWithHeldRelease(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<{
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
  answer: () => void;
}> {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "not authenticated" }),
    }),
  );
  const gate = { open: () => {} };
  const answered = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  await page.route("**/api/release", async (route) => {
    await answered;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
  await page.route("**/desktop/*.dmg", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="SPAWN-D_9.9.9_darwin-aarch64.dmg"',
      },
      body: "not really a disk image",
    }),
  );
  await page.goto("/");
  return { context, page, answer: () => gate.open() };
}

test("the Mac slab holds a press made before the build is named, then downloads it", async ({
  browser,
}) => {
  const { context, page, answer } = await landingWithHeldRelease(browser, {
    desktop: { version: "9.9.9", tree: "a".repeat(40), platforms: ["darwin-aarch64"] },
  });

  const slab = page.getByTestId("mac-download").first();
  await expect(slab).toHaveText(/Download for macOS/i);
  await slab.click();
  await expect(slab).toHaveText(/Preparing download/i);

  // The browser hands downloads to its own machinery rather than the page, so
  // the evidence that the press landed is the download event, not a request.
  const started = page.waitForEvent("download");
  answer();
  expect((await started).url()).toContain("/desktop/SPAWN-D_9.9.9_darwin-aarch64.dmg");
  // The file came to the reader; the reader did not go to a page about it.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("mac-download").first()).toHaveText(/Download for macOS/i);

  await context.close();
});

test("a held press falls through to the download page when there is no build", async ({
  browser,
}) => {
  const { context, page, answer } = await landingWithHeldRelease(browser, {});

  await page.getByTestId("mac-download").first().click();
  await expect(page.getByTestId("mac-download").first()).toHaveText(/Preparing download/i);
  answer();

  await expect(page).toHaveURL(/\/download$/);

  await context.close();
});
