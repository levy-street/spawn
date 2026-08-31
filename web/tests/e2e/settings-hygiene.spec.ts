import { expect, test } from "@playwright/test";
import { mockApp, openSettings } from "./app-mocks";

test("Settings signs out every other session and keeps this one signed in", async ({ page }) => {
  const store = await mockApp(page);
  await openSettings(page, "account");

  await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere?" });
  await expect(dialog).toContainText(
    "Every other browser and phone signed in to this account will be signed out. This one stays signed in.",
  );
  await dialog.getByRole("button", { name: "Sign out everywhere", exact: true }).click();

  await expect(page.getByText("Signed out everywhere else.", { exact: true })).toBeVisible();
  await expect
    .poll(() => store.requests.auth.filter((row) => row.path === "/api/auth/sign-out-everywhere"))
    .toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Account", exact: true }).last()).toBeVisible();
});

test("Settings explains when sign out everywhere is unavailable", async ({ page }) => {
  await mockApp(page, { signOutEverywhereAvailable: false });
  await openSettings(page, "account");

  await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Sign out everywhere?" })
    .getByRole("button", { name: "Sign out everywhere", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "Not available on this server yet.", exact: true }),
  ).toBeDisabled();
});
