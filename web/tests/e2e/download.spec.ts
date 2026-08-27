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

  const detectedPlate = page.getByRole("figure", { name: "Detected browser OS" });
  await expect(detectedPlate).toBeVisible();
  await expect(detectedPlate.getByRole("heading", { name: "macOS" })).toBeVisible();
  await expect(page.getByText("LaunchAgent: app.spawn.spawnd")).toBeVisible();
  await expect(page.locator("code").first()).toHaveText(command);

  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect.poll(() => page.evaluate(() => window.navigator.clipboard.readText())).toBe(command);

  await context.close();
});

test("Linux detection recommends the user systemd service", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Linux x86_64",
    userAgent: LINUX_USER_AGENT,
  });

  await page.goto("/download");

  const detectedPlate = page.getByRole("figure", { name: "Detected browser OS" });
  await expect(detectedPlate.getByRole("heading", { name: "Linux" })).toBeVisible();
  await expect(page.getByText("systemd user service: spawnd.service")).toBeVisible();
  await expect(page.getByText("Install on this Linux host")).toBeVisible();

  await context.close();
});

test("Windows without native artifacts defaults to the truthful WSL plate", async ({ browser }) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
  });

  await page.route("**/api/release", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  );

  await page.goto("/download");
  const origin = new URL(page.url()).origin;

  const detectedPlate = page.getByRole("figure", { name: "Detected browser OS" });
  await expect(detectedPlate.getByRole("heading", { name: "Windows" })).toBeVisible();
  await expect(page.getByText("Run SPAWN D through WSL")).toBeVisible();
  await expect(
    page.getByText(
      "Native Windows support is not available yet. Install WSL2 and a Linux distribution, enable systemd, then run the Windows (WSL) command.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Windows (WSL)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("code").filter({ hasText: "wsl -- bash" }).first()).toHaveText(
    `wsl -- bash -c "curl -fsSL ${origin}/install.sh | sh"`,
  );
  await expect(page.getByText("Enable the service manager")).toBeVisible();
  await expect(page.getByText("systemd=true")).toBeVisible();
  await expect(page.getByText("Keep it online after sign-in")).toBeVisible();
  await expect(page.getByText("wsl -d <distro> --exec true")).toBeVisible();

  await context.close();
});

test("a verified Windows daemon keeps native setup when the desktop EXE is absent", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
  });
  await page.route("**/api/release", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ daemon: { targets: { "windows-x86_64": {} } }, desktop: null }),
    }),
  );

  await page.goto("/download");
  const origin = new URL(page.url()).origin;
  await expect(page.getByText("Install on this Windows PC")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Windows", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("code").filter({ hasText: "install.ps1" }).first()).toHaveText(
    `irm ${origin}/install.ps1 | iex`,
  );
  await expect(page.getByText("Windows desktop build not published yet").first()).toBeVisible();
  await expect(page.getByTestId("windows-download")).toHaveCount(0);

  await context.close();
});

test("Windows with complete release metadata exposes native PowerShell and the EXE", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
  });
  const payload = {
    daemon: { targets: { "windows-x86_64": {} } },
    desktop: {
      version: "9.9.9",
      tree: "a".repeat(40),
      platforms: ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
    },
  };
  await page.route("**/api/release", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }),
  );
  await page.route("**/desktop/*-setup.exe", (route) =>
    route.fulfill({ status: 200, contentType: "application/octet-stream", body: "setup" }),
  );

  await page.goto("/download");
  const origin = new URL(page.url()).origin;

  await expect(page.getByText("Install on this Windows PC")).toBeVisible();
  await expect(page.getByText("Scheduled task: SPAWN D, runs at sign-in")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Windows", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("code").filter({ hasText: "install.ps1" }).first()).toHaveText(
    `irm ${origin}/install.ps1 | iex`,
  );
  await expect(page.getByText("Desktop · Windows")).toBeVisible();
  await expect(page.getByText("Desktop · macOS")).toBeVisible();
  await expect(page.getByText("iPhone and iPad")).toBeVisible();
  await expect(page.getByText("Android")).toBeVisible();
  await expect(page.getByRole("link", { name: "Windows x64" })).toHaveAttribute(
    "href",
    `${origin}/desktop/SPAWN-D_9.9.9_windows-x86_64-setup.exe`,
  );

  const started = page.waitForEvent("download");
  await page.getByTestId("windows-download").click();
  expect((await started).suggestedFilename()).toContain("SPAWN-D_9.9.9_windows-x86_64-setup.exe");

  await page.getByRole("tab", { name: "Windows (WSL)" }).click();
  await expect(page.getByText("Enable the service manager")).toBeVisible();
  await context.close();
});

test("a deferred Windows press stays stamped after the install tab changes", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
  });
  const gate = { open: () => {} };
  const answered = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  await page.route("**/api/release", async (route) => {
    await answered;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        daemon: { targets: { "windows-x86_64": {} } },
        desktop: {
          version: "9.9.9",
          tree: "a".repeat(40),
          platforms: ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
        },
      }),
    });
  });
  await page.route("**/desktop/*-setup.exe", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="SPAWN-D_9.9.9_windows-x86_64-setup.exe"',
      },
      body: "setup",
    }),
  );

  await page.goto("/download");
  const slab = page.getByTestId("windows-download");
  await slab.click();
  await expect(slab).toHaveText(/Preparing download/i);
  await page.getByRole("tab", { name: "macOS / Linux" }).click();

  const started = page.waitForEvent("download");
  gate.open();
  expect((await started).suggestedFilename()).toContain("SPAWN-D_9.9.9_windows-x86_64-setup.exe");
  await expect(page.getByRole("tab", { name: "macOS / Linux" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await context.close();
});

test("Windows landing page uses a quiet WSL action when native artifacts are absent", async ({
  browser,
}) => {
  const { context, page } = await newPlatformPage(browser, {
    platform: "Win32",
    userAgent: WINDOWS_USER_AGENT,
    viewport: { width: 390, height: 844 },
  });
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/release", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Windows setup through WSL →" })).toBeVisible();
  await expect(page.getByTestId("windows-download")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "More download options" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
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

  const detectedPlate = page.getByRole("figure", { name: "Detected browser OS" });
  await expect(detectedPlate.getByRole("heading", { name: "Unknown OS" })).toBeVisible();
  await expect(page.getByText("Choose the host platform")).toBeVisible();
  await expect(page.getByText("Choose macOS / Linux or Windows (WSL) below.")).toBeVisible();

  await context.close();
});

test("landing page download CTA opens the download page", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "not authenticated" }),
    });
  });
  await page.goto("/");

  const closingPoster = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Bring a host online." }),
  });
  await closingPoster.getByRole("link", { name: "Download", exact: true }).click();

  await expect(page).toHaveURL(/\/download$/);
  await expect(
    page.getByRole("heading", { name: "Take it with you. Every screen." }),
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
      page.getByRole("heading", { name: "Take it with you. Every screen." }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/download-${name}.png`, fullPage: true });
    await context.close();
  }
});

/**
 * The hero slab is painted before `/api/release` names the build, and a press
 * in that window used to be spent walking to /download. It now waits, then
 * fetches the file and reports on it — see `DesktopDownloadButton`.
 */
const A_BUILD = {
  desktop: { version: "9.9.9", tree: "a".repeat(40), platforms: ["darwin-aarch64"] },
};

async function serveTheImage(page: Page): Promise<void> {
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
}

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
  // The dev server really does serve a locally built disk image through
  // /desktop-build; pin it so each test states the situation it is testing.
  await page.route("**/desktop-build", (route) => route.fulfill({ status: 404, body: "" }));
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
  await serveTheImage(page);
  await page.goto("/");
  return { context, page, answer: () => gate.open() };
}

test("the Mac slab holds a press made before the build is named, then downloads it", async ({
  browser,
}) => {
  const { context, page, answer } = await landingWithHeldRelease(browser, A_BUILD);

  const slab = page.getByTestId("mac-download").first();
  await expect(slab).toHaveText(/Download for macOS/i);
  await slab.click();
  await expect(slab).toHaveText(/Preparing download/i);

  const started = page.waitForEvent("download");
  answer();
  // The bytes come through fetch, so what lands is a blob under the build's
  // own name — the slab could not report progress on a plain navigation.
  expect((await started).suggestedFilename()).toContain("SPAWN-D_9.9.9_darwin-aarch64.dmg");
  // The file came to the reader; the reader did not go to a page about it,
  // and the slab — not the browser's shelf in the far corner — says so.
  await expect(page).toHaveURL(/\/$/);
  await expect(slab).toHaveText(/Downloaded/i);

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

/** A lander whose build is named by whatever `/desktop-build` reports. */
async function landingWithLocalBuild(
  browser: Browser,
  build: string,
): Promise<{ context: Awaited<ReturnType<Browser["newContext"]>>; page: Page }> {
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
  // A checkout with uncommitted work in desktop/ — the ordinary development
  // machine — cannot prove a desktop version, so the manifest names none.
  await page.route("**/api/release", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/desktop-build", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "9.9.9", platforms: ["darwin-aarch64"], build }),
    }),
  );
  await serveTheImage(page);
  await page.goto("/");
  return { context, page };
}

test("with no manifest to name it, the slab hands over the build on disk", async ({ browser }) => {
  const { context, page } = await landingWithLocalBuild(browser, "abc123");

  const started = page.waitForEvent("download");
  await page.getByTestId("mac-download").first().click();
  expect((await started).suggestedFilename()).toContain("SPAWN-D_9.9.9_darwin-aarch64.dmg");
  await expect(page).toHaveURL(/\/$/);

  await context.close();
});

test("the slab knows the build this browser already has, and when it is replaced", async ({
  browser,
}) => {
  const { context, page } = await landingWithLocalBuild(browser, "abc123");

  const slab = page.getByTestId("mac-download").first();
  await expect(slab).toHaveText(/Download for macOS/i);
  const started = page.waitForEvent("download");
  await slab.click();
  await started;
  await expect(slab).toHaveText(/Downloaded/i);

  // Come back to it: this browser has that build, and the slab says so rather
  // than offering it as though nothing happened.
  await page.reload();
  await expect(page.getByTestId("mac-download").first()).toHaveText(/Download again/i);

  // `npm run dev` rebuilds the same version — a new build of 9.9.9, which is
  // not the one this browser has. The offer comes back.
  await page.unroute("**/desktop-build");
  await page.route("**/desktop-build", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "9.9.9", platforms: ["darwin-aarch64"], build: "def456" }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("mac-download").first()).toHaveText(/Download for macOS/i);

  await context.close();
});

test("changing install targets deliberately cancels a held desktop press", async ({ browser }) => {
  const { context, page, answer } = await landingWithHeldRelease(browser, {
    desktop: { version: "9.9.9", tree: "a".repeat(40), platforms: ["darwin-aarch64"] },
  });
  const desktopRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/desktop/")) desktopRequests.push(request.url());
  });

  await page.getByTestId("mac-download").first().click();
  await expect(page.getByTestId("mac-download").first()).toHaveText(/Preparing download/i);
  const hero = page.locator("section").filter({
    has: page.getByRole("heading", { name: "A daemon on every host you own.", level: 1 }),
  });
  await hero.getByRole("tab", { name: "Windows (WSL)" }).click();
  await expect(hero.getByRole("link", { name: "Windows setup through WSL →" })).toBeVisible();

  answer();
  await expect(hero.getByRole("link", { name: "Windows setup through WSL →" })).toBeVisible();
  expect(desktopRequests).toEqual([]);

  await context.close();
});
