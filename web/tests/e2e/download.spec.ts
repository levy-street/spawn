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

/**
 * Pick a host OS. The radio itself is `sr-only`, so its hit box sits under
 * the label text — click the label, which is what a person does anyway.
 */
function selectOs(page: Page, name: RegExp) {
  return page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name }) })
    .click();
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

const SIGNED_IN_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "tester@example.com",
  created_at: "2026-05-24T00:00:00Z",
  email_verified_at: null,
  is_admin: false,
};

test("the lander carries the pairing step, not just the command", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });

  await page.goto("/download");

  // Two ordered steps, not one command block and unrelated buttons.
  const steps = page.getByRole("listitem").filter({ has: page.getByRole("heading") });
  await expect(steps.first().getByRole("heading", { name: "Install on this Mac" })).toBeVisible();
  await expect(steps.nth(1).getByRole("heading", { name: "Approve the host" })).toBeVisible();

  // The fingerprint reminder lives on the step where the ceremony happens.
  await expect(steps.nth(1)).toContainText("verification code in the browser matches");

  await page.getByRole("link", { name: "Enter code" }).click();
  await expect(page).toHaveURL(/\/device/u);

  await context.close();
});

test("Enter code from the lander survives the sign-in it is gated behind", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });
  // /download is a public lander; /device is not. A logged-out visitor must
  // come back to the pairing page after signing in, not be dumped elsewhere.
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "not authenticated" }),
    });
  });

  await page.goto("/download");
  await page.getByRole("link", { name: "Enter code" }).click();

  await expect(page).toHaveURL(/\/login\?next=%2Fdevice$/u);
  await expect(page.getByText("Sign in to spawn")).toBeVisible();

  // Signing in lands back on /device.
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "token",
        user: SIGNED_IN_USER,
      }),
    });
  });
  await page.unroute("**/api/me");
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: SIGNED_IN_USER,
      }),
    });
  });
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel("Password").fill("passpasspass");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/device$/u);

  await context.close();
});

test("a hostile next= is not honored", async ({ browser, baseURL }) => {
  const baseUrl = baseURL ?? "http://127.0.0.1:3302";
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "token",
        user: SIGNED_IN_USER,
      }),
    });
  });
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: SIGNED_IN_USER,
      }),
    });
  });

  await page.goto("/login?next=https%3A%2F%2Fevil.example.com%2Fphish");
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel("Password").fill("passpasspass");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Home, not the attacker's origin. Polled, because the assertion would
  // otherwise be satisfied by /login before the redirect even runs.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).host).toBe(new URL(baseUrl).host);

  await context.close();
});

test("detection picks the default tab, and the reader can leave it", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });

  await page.goto("/download");
  const panel = page.locator("section").first();

  // Detected wins on arrival, and says so.
  await expect(panel.getByRole("radio", { name: /macOS/u })).toBeChecked();
  await expect(page.getByText("Detected browser OS")).toBeVisible();

  // The host I want to possess is a Linux box. Switching swaps the heading,
  // the service line, the prose and the notes.
  await selectOs(page, /Linux/u);
  await expect(panel.getByRole("heading", { name: "Linux" })).toBeVisible();
  await expect(page.getByText("systemd user service: spawnd.service")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Install on this Linux host" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Remote hosts" })).toBeVisible();
  await expect(page.getByText("LaunchAgent: app.spawn.spawnd")).toHaveCount(0);

  // And it still tells you what it detected, so the nicety is not lost.
  await expect(page.getByText("Showing Linux · detected macOS")).toBeVisible();
  await expect(panel.getByRole("radio", { name: /macOS/u })).not.toBeChecked();

  await selectOs(page, /macOS/u);
  await expect(panel.getByRole("heading", { name: "macOS" })).toBeVisible();
  await expect(page.getByText("Detected browser OS")).toBeVisible();

  await context.close();
});

test("the Windows tab is reachable and honest from any browser", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });

  await page.goto("/download");
  await selectOs(page, /Windows/u);

  await expect(
    page.locator("section").first().getByRole("heading", { name: "Windows" }),
  ).toBeVisible();
  await expect(page.getByText("no native Windows daemon build")).toBeVisible();
  await expect(page.getByText("Windows service support is not available yet.")).toBeVisible();
  // Reachable and explanatory, pointing at WSL2 rather than dead-ending.
  await expect(page.getByRole("heading", { name: "WSL2 is the way in" })).toBeVisible();
  await expect(
    page.getByText("Use this command from a supported macOS or Linux terminal"),
  ).toBeVisible();

  await context.close();
});

test("the OS selector is a keyboard-navigable radio group", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
  });

  await page.goto("/download");
  await page.getByRole("radio", { name: /macOS/u }).focus();
  // Arrow keys inside a radiogroup — free from the fieldset pattern.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /Linux/u })).toBeChecked();
  await expect(
    page.locator("section").first().getByRole("heading", { name: "Linux" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /Windows/u })).toBeChecked();

  await context.close();
});

test("an unknown OS preselects nothing and still explains itself", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "FreeBSD amd64",
    userAgent: UNKNOWN_USER_AGENT,
  });

  await page.goto("/download");

  // Nothing is claimed that is not known — but every tab is one click away.
  for (const name of [/macOS/u, /Linux/u, /Windows/u]) {
    await expect(page.getByRole("radio", { name })).not.toBeChecked();
  }
  await expect(page.getByText("will detect the actual host when it runs")).toBeVisible();

  await selectOs(page, /Linux/u);
  await expect(page.getByRole("heading", { name: "Install on this Linux host" })).toBeVisible();

  await context.close();
});

test("switching tabs does not overflow on mobile", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "MacIntel",
    userAgent: MAC_USER_AGENT,
    viewport: { width: 390, height: 844 },
  });

  await page.goto("/download");
  for (const name of [/Linux/u, /Windows/u, /macOS/u]) {
    await selectOs(page, name);
    await expectNoHorizontalOverflow(page);
  }

  await context.close();
});
