import { expect, test } from "@playwright/test";

test("login and signup render enabled provider buttons", async ({ page }) => {
  await page.route("**/api/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        providers: [
          { id: "google", name: "Google" },
          { id: "microsoft", name: "Microsoft" },
          { id: "github", name: "GitHub" },
        ],
      },
    });
  });

  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveAttribute(
    "href",
    "/api/auth/oauth/google/start?return_to=%2F",
  );
  await expect(page.getByRole("link", { name: "Continue with Microsoft" })).toHaveAttribute(
    "href",
    "/api/auth/oauth/microsoft/start?return_to=%2F",
  );
  await expect(page.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
    "href",
    "/api/auth/oauth/github/start?return_to=%2F",
  );

  await page.goto("/signup");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("or use email")).toBeVisible();
});

test("provider section stays hidden when no providers are enabled", async ({ page }) => {
  await page.route("**/api/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { providers: [] },
    });
  });

  await page.goto("/login");
  await expect(page.getByRole("link", { name: /Continue with/ })).toHaveCount(0);
  await expect(page.getByText("or use email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a refused provider sign-in explains itself on the login page", async ({ page }) => {
  await page.route("**/api/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { providers: [{ id: "google", name: "Google" }] },
    });
  });

  // What the callback redirects to when a provider identity resolves onto an
  // account it has not proven it owns.
  const message =
    "An account already exists for person@example.com. Sign in with your password to continue.";
  await page.goto(`/login?error=${encodeURIComponent(message)}`);

  // Scoped to the form: Next's route announcer is also role="alert".
  const formAlert = page.locator("form").getByRole("alert");
  await expect(formAlert).toHaveText(message);
  // Still a working sign-in page, not a dead end.
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();

  // Submitting clears it rather than leaving it under every later attempt.
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "invalid email or password" }),
    });
  });
  await page.getByLabel("Email").fill("person@example.com");
  await page.getByLabel("Password").fill("passpasspass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(formAlert).toHaveText("invalid email or password");
});
