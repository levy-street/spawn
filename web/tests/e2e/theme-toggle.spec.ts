import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedApi } from "./app-mocks";

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

// Both instances are always in the DOM — the header is hidden by a container
// query, not unmounted — so every lookup is scoped to its chrome.
const railToggle = (page: Page) => page.locator("aside").getByTestId("theme-toggle");
const headerToggle = (page: Page) => page.locator("header").getByTestId("theme-toggle");

function resolvedTheme(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

function storedPreference(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("spawn.theme"));
}

/**
 * Seed the starting preference without pinning it: init scripts re-run on
 * every navigation, so writing unconditionally would silently undo whatever
 * the toggle stored and make the reload assertion prove nothing.
 */
function seedTheme(page: Page, preference: "light" | "dark") {
  return page.addInitScript((value) => {
    if (window.localStorage.getItem("spawn.theme") === null) {
      window.localStorage.setItem("spawn.theme", value);
    }
  }, preference);
}

test("the sidebar toggle flips the theme in one click and survives a reload", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mockAuthenticatedApi(page);
  await seedTheme(page, "dark");

  await page.goto("/hosts");
  const toggle = railToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
  expect(await resolvedTheme(page)).toBe("dark");

  await toggle.click();
  await expect.poll(() => resolvedTheme(page)).toBe("light");
  // The control now offers the way back, and says so.
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
  expect(await storedPreference(page)).toBe("light");

  await page.reload();
  expect(await resolvedTheme(page)).toBe("light");
  await expect(railToggle(page)).toHaveAttribute("aria-label", "Switch to dark theme");

  await railToggle(page).click();
  await expect.poll(() => resolvedTheme(page)).toBe("dark");
});

test("the mobile top bar carries the same toggle", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await mockAuthenticatedApi(page);
  await seedTheme(page, "light");

  await page.goto("/hosts");
  const toggle = headerToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
  // The rail is the one that is hidden at this width.
  await expect(railToggle(page)).toBeHidden();

  await toggle.click();
  await expect.poll(() => resolvedTheme(page)).toBe("dark");
  // Settings is still reachable next to it.
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
});

test("the toggle is keyboard reachable and operable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mockAuthenticatedApi(page);
  await seedTheme(page, "dark");

  await page.goto("/hosts");
  await railToggle(page).focus();
  await expect(railToggle(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => resolvedTheme(page)).toBe("light");

  // ArrowDown opens the menu that holds the three-way choice.
  await railToggle(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "System" }).click();
  await expect.poll(() => storedPreference(page)).toBe("system");
});

test("System keeps tracking the OS after the toggle has been used", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "dark" });
  await mockAuthenticatedApi(page);

  await page.goto("/hosts");
  // Default preference is "system", so the OS decides.
  expect(await storedPreference(page)).toBeNull();
  expect(await resolvedTheme(page)).toBe("dark");

  await railToggle(page).click();
  await expect.poll(() => resolvedTheme(page)).toBe("light");
  expect(await storedPreference(page)).toBe("light");

  // Back to System via the menu, and the OS is authoritative again — live,
  // without a reload.
  await railToggle(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "System" }).click();
  await expect.poll(() => resolvedTheme(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => resolvedTheme(page)).toBe("light");
});

test("Settings reflects whatever the toggle set", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mockAuthenticatedApi(page);
  await seedTheme(page, "dark");

  await page.goto("/hosts");
  await railToggle(page).click();
  await expect.poll(() => resolvedTheme(page)).toBe("light");

  await page.goto("/settings?tab=appearance");
  await expect(page.getByRole("radio", { name: "Light" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Dark" })).not.toBeChecked();

  // And the other direction: Settings drives the toggle's label. The radio
  // itself is sr-only, so click the label the way a person does.
  await page
    .locator("label")
    .filter({ has: page.getByRole("radio", { name: "Dark" }) })
    .click();
  await expect.poll(() => resolvedTheme(page)).toBe("dark");
  await expect(railToggle(page)).toHaveAttribute("aria-label", "Switch to light theme");
});

test("the collapsed rail keeps the toggle reachable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mockAuthenticatedApi(page);
  await seedTheme(page, "dark");

  await page.goto("/hosts");
  const toggle = railToggle(page);
  await expect(toggle).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  // The rail animates to its collapsed width; measure once it has settled.
  await expect
    .poll(async () => (await page.locator("aside").boundingBox())?.width)
    .toBeLessThanOrEqual(56);
  const box = await toggle.boundingBox();
  // Inside the rail, so it did not overflow or get clipped away.
  expect(box?.width ?? 0).toBeLessThanOrEqual(56);
  // And the label is faded out rather than wrapping the row.
  expect(box?.height ?? 0).toBeLessThanOrEqual(40);
  await toggle.click();
  await expect.poll(() => resolvedTheme(page)).toBe("light");
});
