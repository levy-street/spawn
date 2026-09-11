import { expect, test } from "@playwright/test";

// While signup is closed the site asks for an address instead of turning
// people away: on the signup page, the landing page, and every SEO page's
// Start block. The invite code stays one tap away for the people who have one.

type Page = import("@playwright/test").Page;

async function authConfig(page: Page, inviteOnly: boolean) {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({
      status: 200,
      json: { providers: [], email_verification_required: false, invite_only: inviteOnly },
    }),
  );
}

async function captureJoins(page: Page, status = 200) {
  const joins: unknown[] = [];
  await page.route("**/api/waitlist", async (route) => {
    joins.push(route.request().postDataJSON());
    await route.fulfill({
      status,
      json: status === 200 ? { ok: true } : { detail: "too many requests; slow down" },
    });
  });
  return joins;
}

test("a closed signup page leads with the waitlist", async ({ page }) => {
  await authConfig(page, true);
  const joins = await captureJoins(page);
  await page.goto("/signup");

  await expect(page.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByRole("button", { name: "Join the waitlist" }).click();

  await expect(page.getByTestId("waitlist-joined")).toContainText(
    "We’ll email someone@example.com when there’s room.",
  );
  expect(joins).toEqual([{ email: "someone@example.com", source: "signup" }]);
});

test("the invite code is one tap away, and the way back is too", async ({ page }) => {
  await authConfig(page, true);
  await page.goto("/signup");

  await page.getByRole("button", { name: "Have an invite code?" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Invite code")).toBeVisible();

  await page.getByRole("button", { name: "Back to the waitlist" }).click();
  await expect(page.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
});

test("an invite link skips the waitlist", async ({ page }) => {
  await authConfig(page, true);
  await page.goto("/signup?invite=abc123xyz");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Invite code")).toHaveValue("abc123xyz");
});

test("an SEO page's Start block takes an address and says where it was left", async ({ page }) => {
  await authConfig(page, true);
  const joins = await captureJoins(page);
  await page.goto("/claude-code-remote");

  const form = page.getByTestId("waitlist-form");
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel("Email").fill("reader@example.com");
  await form.getByRole("button", { name: "Join the waitlist" }).click();

  await expect(page.getByTestId("waitlist-joined")).toContainText("reader@example.com");
  expect(joins).toEqual([{ email: "reader@example.com", source: "/claude-code-remote" }]);
});

test("the landing page's ask is the same form", async ({ page }) => {
  await authConfig(page, true);
  const joins = await captureJoins(page);
  await page.goto("/");

  const form = page.getByTestId("waitlist-form");
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel("Email").fill("visitor@example.com");
  await form.getByRole("button", { name: "Join the waitlist" }).click();

  await expect(page.getByTestId("waitlist-joined")).toBeVisible();
  expect(joins).toEqual([{ email: "visitor@example.com", source: "/" }]);
});

test("a slip is caught before the server, and a rate limit is named", async ({ page }) => {
  await authConfig(page, true);
  const joins = await captureJoins(page, 429);
  await page.goto("/claude-code-remote");

  const form = page.getByTestId("waitlist-form");
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel("Email").fill("not-an-address");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter a valid email address.");
  expect(joins).toEqual([]);

  await form.getByLabel("Email").fill("real@example.com");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Too many tries from this network. Try again later.",
  );
});

test("an open deployment shows the door instead", async ({ page }) => {
  await authConfig(page, false);
  await page.goto("/claude-code-remote");

  const start = page.locator("#start");
  await start.scrollIntoViewIfNeeded();
  await expect(start.getByRole("link", { name: "Sign up free" })).toBeVisible();
  await expect(page.getByTestId("waitlist-form")).toHaveCount(0);
});
