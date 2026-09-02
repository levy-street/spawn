import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockApp, WORKSPACE_ID, workspace } from "./app-mocks";

/**
 * The account row's "Get SPAWN D" menu: the one download surface inside the
 * app. Two things arrive after it is on screen — the build's version and the
 * download's own progress — and both used to move it, so the menu's measure
 * is part of the contract here, not only its words.
 */

const A_BUILD = {
  version: "9.9.9",
  tree: "a".repeat(40),
  platforms: ["darwin-aarch64", "windows-x86_64"],
};

/** The app with the release manifest held open until `answer()` is called. */
async function appWithHeldRelease(page: Page, desktop: Record<string, unknown> | null) {
  await mockApp(page, {
    sessions: [],
    workspaces: [workspace({ layout: { version: 3, tiles: [] } })],
  });
  const gate = { open: () => {} };
  const answered = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  // Registered after mockApp, so it is the handler that answers: Playwright
  // matches the most recently added route first.
  await page.route("**/api/release", async (route) => {
    await answered;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ desktop }),
    });
  });
  // A development checkout can answer this too; pin it so each test states
  // the situation it is testing.
  await page.route("**/desktop-build", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/desktop/*", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="SPAWN-D_9.9.9_darwin-aarch64.dmg"',
      },
      body: "not really a disk image",
    }),
  );
  await page.goto(`/w/${WORKSPACE_ID}`);
  return { answer: () => gate.open() };
}

async function openTheMenu(page: Page) {
  await page.getByRole("button", { name: "Get SPAWN D" }).click();
  return page.getByRole("menu");
}

/** The opening zoom, run out: a box measured mid-animation is a scaled box. */
async function settled(menu: ReturnType<Page["getByRole"]>) {
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((one) => one.finished)));
}

test("the menu holds its place when the build's version lands", async ({ page }) => {
  const { answer } = await appWithHeldRelease(page, A_BUILD);
  const menu = await openTheMenu(page);
  await expect(menu).toBeVisible();
  await settled(menu);
  const before = await menu.boundingBox();

  answer();
  await expect(menu.getByText(/v9\.9\.9/)).toBeVisible();

  // The version is content that arrives after placement. A menu measured
  // against the content it happened to have opened with is re-anchored to the
  // trigger's other edge when that content grows — which reads as the whole
  // menu sliding in from the far side of the window.
  await settled(menu);
  const after = await menu.boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.width).toBe(before?.width);
});

test("the desktop row holds a press made before the build is named, then downloads it", async ({
  page,
}) => {
  const { answer } = await appWithHeldRelease(page, A_BUILD);
  const menu = await openTheMenu(page);
  const row = page.getByTestId("menu-desktop-download");
  await expect(row).toHaveText(/Download for (macOS|Windows)/);

  await row.click();
  await expect(row).toHaveText(/Preparing download/i);
  const started = page.waitForEvent("download");
  answer();

  // The bytes come through fetch, so what lands is a blob under the build's
  // own name — the row could not report progress on a plain navigation.
  expect((await started).suggestedFilename()).toContain("SPAWN-D_9.9.9_");
  await expect(row).toHaveText(/Downloaded/i);
  // The menu is where that was reported, so it is still up to report it.
  await expect(menu).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}`));
});

test("with no build advertised, the row leads to the download page", async ({ page }) => {
  const { answer } = await appWithHeldRelease(page, null);
  await openTheMenu(page);
  answer();

  const row = page.getByRole("menuitem", { name: /Download for (macOS|Windows)/ });
  await expect(row).toHaveAttribute("href", "/download");
});

test("the download button says what it is on hover", async ({ page }) => {
  await appWithHeldRelease(page, A_BUILD);
  // The rest of the footer's rows carry their label beside them; this one is
  // an icon alone, so the label has to be somewhere.
  await page.getByRole("button", { name: "Get SPAWN D" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Get SPAWN D");
});

// A real Ed25519 key: the roster serves no fingerprint, so the UI derives one
// from the key and an arbitrary 32 bytes would be rejected as off-curve.
const KNOCKING_KEY = (() => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
})();
const KNOCKING_DEVICE_ID = "00000000-0000-4000-8000-000000000078";

/**
 * The layering rule, through the one modal that opens without anyone clicking:
 * a device knocks for approval while the menu happens to be up. Menus are
 * drawn above dialogs on purpose (a menu opened inside a dialog has to clear
 * it), so nothing but an explicit dismissal can put this the right way round.
 */
test("a modal that opens under the menu takes the window from it", async ({ page }) => {
  await mockApp(page, {
    hosts: [{ ...host, host_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw" }],
    sessions: [],
    workspaces: [workspace({ layout: { version: 3, tiles: [] } })],
    // This browser is trusted by a host, so it is one that can actually
    // approve — the knock renders as a dialog rather than a corner notice.
    hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] },
    extraBrowserDevices: [
      {
        id: KNOCKING_DEVICE_ID,
        key_algorithm: "ed25519",
        public_key: KNOCKING_KEY,
        label: "Pixel phone",
        created_at: "2026-08-01T00:00:00Z",
        revoked_at: null,
      },
    ],
  });
  // Held open until the menu is up: the knock has to arrive *after* it.
  const gate = { open: () => {} };
  const knocked = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  await page.route("**/api/trust/device-approvals", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await knocked;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-000000000900",
          browser_device_id: KNOCKING_DEVICE_ID,
          label: "Pixel phone",
          fingerprint: `SHA256:${createHash("sha256")
            .update(Buffer.from(KNOCKING_KEY, "base64url"))
            .digest()
            .subarray(0, 12)
            .toString("base64url")}`,
          status: "pending",
          created_at: "2026-08-01T00:00:00Z",
          expires_at: "2099-01-01T00:00:00Z",
        },
      ]),
    });
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  // This browser's identity is read once, at mount. A fresh context registers
  // during that first load, so the prompt cannot recognise "this browser" —
  // and could not tell whether it may approve — until a load that starts with
  // the key already stored.
  await page.waitForResponse((response) =>
    response.url().includes("/api/browser-devices/register"),
  );
  await page.reload();

  const menu = await openTheMenu(page);
  await expect(menu).toBeVisible();

  gate.open();
  await expect(page.getByTestId("device-approval-prompt")).toBeVisible({ timeout: 20_000 });
  // Gone from the page, not merely out of the accessibility tree: a modal
  // Radix dialog marks everything behind it aria-hidden, so a role query would
  // have said "no menu" about a menu still sitting over the scrim, clickable.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
});
