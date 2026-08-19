import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedApi } from "./app-mocks";

/**
 * Terminal palette and typography, driven from Settings → Appearance.
 *
 * The interesting property is not that a colour changed — it is that changing
 * *cell metrics* mid-session goes through the same fit/reseed a resize does,
 * so the terminal stays usable rather than ending up misfitted.
 */

const SAMPLE = "terminal-appearance-sample";

async function openAppearanceSettings(page: Page) {
  await mockAuthenticatedApi(page);
  // Reached by clicking rather than `?tab=appearance`: the route shim's
  // TAB_KEYS omits "appearance" on master, which #13 fixes separately.
  await page.goto("/settings");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByTestId(SAMPLE)).toBeVisible();
}

function sampleStyle(page: Page) {
  return page.getByTestId(SAMPLE).evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      background: style.backgroundColor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    };
  });
}

function storedAppearance(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("spawn.terminal.appearance");
    return raw ? JSON.parse(raw) : null;
  });
}

function pickTheme(page: Page, name: string) {
  return page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name, exact: true }) })
    .click();
}

test("picking a terminal theme repaints the preview and persists", async ({ page }) => {
  await openAppearanceSettings(page);

  // Default is "Match app", so the sample follows the app theme.
  await expect(page.getByRole("radio", { name: "Match app", exact: true })).toBeChecked();

  await pickTheme(page, "Nord");
  await expect.poll(async () => (await sampleStyle(page)).background).toBe("rgb(46, 52, 64)");
  await expect.poll(() => storedAppearance(page)).toMatchObject({ themeId: "nord" });

  // Reopen after a reload: the choice is stored, not just in React state.
  await page.reload();
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByRole("radio", { name: "Nord", exact: true })).toBeChecked();
  expect((await sampleStyle(page)).background).toBe("rgb(46, 52, 64)");
});

test("a light terminal theme is available regardless of the app theme", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("spawn.theme", "dark"));
  await openAppearanceSettings(page);

  await pickTheme(page, "Solarized light");
  await expect.poll(async () => (await sampleStyle(page)).background).toBe("rgb(253, 246, 227)");
  // The app stays dark; the terminal palette is its own choice.
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});

test("font size and line height are adjustable and bounded", async ({ page }) => {
  await openAppearanceSettings(page);

  const size = page.getByRole("slider", { name: "Size" });
  const lineHeight = page.getByRole("slider", { name: "Line height" });
  expect(await size.getAttribute("min")).toBe("9");
  expect(await size.getAttribute("max")).toBe("24");

  await size.fill("18");
  await expect.poll(async () => (await sampleStyle(page)).fontSize).toBe("18px");

  await lineHeight.fill("1.6");
  // 18px * 1.6
  await expect.poll(async () => (await sampleStyle(page)).lineHeight).toBe("28.8px");

  await expect
    .poll(() => storedAppearance(page))
    .toMatchObject({
      fontSize: 18,
      lineHeight: 1.6,
    });
});

test("stored junk falls back to a readable terminal rather than a broken one", async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem(
      "spawn.terminal.appearance",
      JSON.stringify({
        themeId: "a-theme-this-build-does-not-have",
        fontId: "not-a-font",
        fontSize: 9999,
        lineHeight: -4,
      }),
    ),
  );
  await openAppearanceSettings(page);

  await expect(page.getByRole("radio", { name: "Match app", exact: true })).toBeChecked();
  const style = await sampleStyle(page);
  // Clamped to the top of the offered range, not 9999px.
  expect(style.fontSize).toBe("24px");
  expect(Number.parseFloat(style.lineHeight)).toBeGreaterThan(0);
});

test("Reset returns everything to the shipped defaults", async ({ page }) => {
  await openAppearanceSettings(page);

  await pickTheme(page, "Gruvbox dark");
  await page.getByRole("slider", { name: "Size" }).fill("20");
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("radio", { name: "Match app", exact: true })).toBeChecked();
  await expect.poll(async () => (await sampleStyle(page)).fontSize).toBe("13px");
  // Nothing to reset any more, so the affordance withdraws.
  await expect(page.getByRole("button", { name: "Reset" })).toHaveCount(0);
});

test("a device with no patched fonts is offered none of them", async ({ page }) => {
  // Nothing is downloaded, so offering a face the viewer lacks would select a
  // font without the glyphs it was chosen for. This browser has none.
  await openAppearanceSettings(page);

  const options = page.getByRole("combobox").first().locator("option");
  await expect(options.filter({ hasText: "System monospace" })).toHaveCount(1);
  await expect(options).toHaveCount(1);
  await expect(page.getByText(/5 patched fonts not installed on this device/u)).toBeVisible();
});

test("an installed patched font is offered", async ({ page }) => {
  // Detection is metric comparison, not `document.fonts.check()` — which
  // reports every locally-installed family as available whether or not it
  // exists. Stub the measurement so one family measures differently.
  await page.addInitScript(() => {
    // A plain stub, not a Proxy: the native `font` setter throws
    // "Illegal invocation" when reached through one. The probe only ever
    // sets `font` and calls `measureText`.
    // biome-ignore lint/suspicious/noExplicitAny: matching a DOM overload set
    HTMLCanvasElement.prototype.getContext = ((type: any) => {
      if (type !== "2d") return null;
      let font = "";
      return {
        get font() {
          return font;
        },
        set font(value: string) {
          font = value;
        },
        measureText: () => ({ width: font.includes("Hack Nerd Font") ? 500 : 400 }),
        // biome-ignore lint/suspicious/noExplicitAny: stub stands in for the 2D context
      } as any;
      // biome-ignore lint/suspicious/noExplicitAny: stub stands in for the 2D context
    }) as any;
  });
  await openAppearanceSettings(page);

  const options = page.getByRole("combobox").first().locator("option");
  await expect(options.filter({ hasText: "Hack Nerd Font" })).toHaveCount(1);
  await expect(options.filter({ hasText: "JetBrainsMono Nerd Font" })).toHaveCount(0);

  await page.getByRole("combobox").first().selectOption({ label: "Hack Nerd Font" });
  await expect.poll(async () => (await sampleStyle(page)).fontFamily).toContain("Hack Nerd Font");
});
