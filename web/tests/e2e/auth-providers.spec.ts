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
