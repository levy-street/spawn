import { expect, type Page, test } from "@playwright/test";
import { mockApp, WORKSPACE_ID } from "./app-mocks";

/**
 * `/` is the lander for everyone; `/app` is the door in. These cover the four
 * ways you cross between them: arriving signed out, arriving signed in,
 * leaving the app by its brand mark, and leaving it by signing out.
 */
// The lander's masthead sits inside <main>, so it is a plain <header> with no
// banner role — scoping by element keeps these off the colophon's links.
const masthead = (page: Page) => page.locator("header");

test("signed out, / is the lander with both doors in", async ({ page }) => {
  await mockApp(page, { me: null });
  await page.goto("/");
  await expect(masthead(page).getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(masthead(page).getByRole("link", { name: /Sign up/ })).toBeVisible();
  await expect(masthead(page).getByRole("link", { name: "Open SPAWN D" })).toHaveCount(0);
});

test("signed in, / stays on the lander and swaps the CTAs for Enter", async ({ page }) => {
  await mockApp(page);
  // The lander's masthead asks /api/me only once this browser has held a
  // session (lib/auth-hint.ts); a returning user's browser carries the hint.
  await page.addInitScript(() => window.localStorage.setItem("spawn.signed-in.v1", "1"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/u);
  const enter = masthead(page).getByRole("link", { name: "Open SPAWN D" });
  await expect(enter).toBeVisible();
  await expect(masthead(page).getByRole("link", { name: "Log in" })).toHaveCount(0);
  await expect(masthead(page).getByRole("link", { name: /Sign up/ })).toHaveCount(0);
  await enter.click();
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}$`, "u"));
});

test("the brand mark in the app chrome goes back to the lander", async ({ page }) => {
  await mockApp(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("link", { name: "SPAWN D home" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(masthead(page).getByRole("link", { name: "Open SPAWN D" })).toBeVisible();
});

test("signing out lands on the lander, not the login form", async ({ page }) => {
  await mockApp(page);
  await page.goto(`/w/${WORKSPACE_ID}`);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(masthead(page).getByRole("link", { name: "Log in" })).toBeVisible();
});
