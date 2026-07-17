import { expect, test } from "@playwright/test";

test("device approval shows the server fingerprint before confirmation", async ({ page }) => {
  const fingerprint = "SHA256:0123456789abcdef";
  const hostPublicKey = "A".repeat(43);
  let approved = false;
  let approvalBody: unknown = null;

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
          host_public_key: hostPublicKey,
          host_key_fingerprint: fingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      approved = true;
      approvalBody = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
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
  expect(approvalBody).toEqual({
    user_code: "QZ4K-7HMT",
    host_key_algorithm: "ed25519",
    host_public_key: hostPublicKey,
    host_key_fingerprint: fingerprint,
  });
});

test("stale approval failure clears the reviewed identity and requires review again", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
          host_name: "changed-host",
          host_key_algorithm: "ed25519",
          host_public_key: "A".repeat(43),
          host_key_fingerprint: "SHA256:0123456789abcdef",
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        json: { detail: "host identity changed since review; review the device code again" },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await page.getByRole("button", { name: "Confirm approval" }).click();

  await expect(page.locator("p[role=alert]")).toContainText("review the device code again");
  await expect(page.getByTestId("host-key-fingerprint")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Review daemon" })).toBeVisible();
});
