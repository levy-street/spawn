import { expect, test } from "@playwright/test";

test("device approval shows the server fingerprint before confirmation", async ({ page }) => {
  const fingerprint = "SHA256:0123456789abcdef";
  let approved = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          host_key_algorithm: "ed25519",
          host_public_key: "A".repeat(43),
          host_key_fingerprint: fingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      approved = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          host_key_algorithm: "ed25519",
          host_public_key: "A".repeat(43),
          host_key_fingerprint: fingerprint,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();

  await expect(page.getByTestId("host-key-fingerprint")).toHaveText(fingerprint);
  await expect(page.getByText("build-host", { exact: false })).toBeVisible();
  expect(approved).toBe(false);

  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByRole("status")).toContainText("Approved daemon for host build-host");
  expect(approved).toBe(true);
});
