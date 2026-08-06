import { expect, test } from "@playwright/test";

// Account recovery from the outside: the request page never reveals whether
// an address has an account, and the reset page refuses to submit anything
// the server would reject anyway.

test("requesting a reset says the same thing for any address", async ({ page }) => {
  const requested: Array<Record<string, unknown>> = [];
  await page.route("**/api/auth/password-reset/request", async (route) => {
    requested.push((await route.request().postDataJSON()) as Record<string, unknown>);
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();

  await expect(page.getByRole("status")).toContainText("If an account exists");
  await expect(page.getByRole("status")).toContainText("someone@example.com");
  expect(requested).toEqual([{ email: "someone@example.com" }]);
});

test("a failed request is indistinguishable from a successful one", async ({ page }) => {
  // Even when the backend errors, the page must not leak that difference:
  // an attacker probing addresses learns nothing either way.
  await page.route("**/api/auth/password-reset/request", async (route) => {
    await route.fulfill({ status: 500, json: { detail: "smtp exploded" } });
  });

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("probe@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();

  await expect(page.getByRole("status")).toContainText("If an account exists");
  await expect(page.getByText("smtp exploded")).toHaveCount(0);
});

test("the reset form enforces length and confirmation before submitting", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/auth/password-reset/confirm", async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 200,
      json: {
        access_token: "token",
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "tester@example.com",
          created_at: "2026-05-24T00:00:00Z",
          email_verified_at: "2026-05-24T00:00:00Z",
        },
      },
    });
  });

  await page.goto("/reset-password?token=abcdefghijklmnopqrstuvwx");
  const submit = page.getByRole("button", { name: "Set new password" });
  await expect(submit).toBeDisabled();

  await page.locator("#new-password").fill("short");
  await page.locator("#confirm-password").fill("short");
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.locator("#new-password").fill("a-long-enough-password");
  await page.locator("#confirm-password").fill("a-long-enough-passwerd");
  await expect(page.getByText("Both passwords must match.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.locator("#confirm-password").fill("a-long-enough-password");
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/reset-password"), { timeout: 15_000 });
  expect(submissions).toBe(1);
});

test("a reset link with no token sends the user back to request one", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByText(/missing its token/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a reset link" })).toBeVisible();
});
