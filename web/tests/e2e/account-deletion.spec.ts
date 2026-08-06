import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi } from "./app-mocks";

// Account deletion is double-confirmed: the typed email gates the submit
// client-side, and the password is verified server-side. Success ends the
// session and leaves for the login page.

test("deletion is gated on the typed email and a correct password", async ({ page }) => {
  const deleteCalls: Array<Record<string, unknown>> = [];
  await mockAuthenticatedApi(page);
  await page.route("**/api/account/delete", async (route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    deleteCalls.push(body);
    if (body.password !== "correct horse battery") {
      await route.fulfill({ status: 403, json: { detail: "password confirmation failed" } });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/settings?tab=account");

  await page.getByRole("button", { name: "Delete account…" }).click();
  const submit = page.getByRole("button", { name: "Permanently delete" });
  await expect(submit).toBeDisabled();

  // A near-miss email keeps the trigger locked.
  await page.locator("#delete-confirm-email").fill("tester@example.co");
  await expect(submit).toBeDisabled();
  await page.locator("#delete-confirm-email").fill("Tester@Example.com");
  await expect(submit).toBeEnabled();

  // Server-side password refusal surfaces and keeps the session.
  await page.locator("#delete-confirm-password").fill("wrong password");
  await submit.click();
  await expect(page.getByRole("alert").last()).toContainText("password confirmation failed");
  expect(deleteCalls).toHaveLength(1);

  await page.locator("#delete-confirm-password").fill("correct horse battery");
  await submit.click();
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  expect(deleteCalls).toHaveLength(2);
  expect(deleteCalls[1]).toMatchObject({
    confirm_email: "Tester@Example.com",
    password: "correct horse battery",
  });
});
