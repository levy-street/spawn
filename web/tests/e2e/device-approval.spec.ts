import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return `SHA256:${digest.subarray(0, 12).toString("base64url")}`;
}

test("device approval shows the server fingerprint before confirmation", async ({ page }) => {
  const hostFingerprint = "SHA256:0123456789abcdef";
  const hostPublicKey = "A".repeat(43);
  let approved = false;
  let approvalBody: unknown = null;
  let browserPublicKey = "";
  let browserFingerprint = "";

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      browserPublicKey = body.public_key;
      browserFingerprint = fingerprint(body.public_key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: browserPublicKey,
          fingerprint: browserFingerprint,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
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
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      approved = true;
      approvalBody = request.postDataJSON();
      const body = approvalBody as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "build-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
          browser_device_id: body.browser_device_id,
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
          browser_key_fingerprint: body.browser_key_fingerprint,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();

  await expect(page.getByTestId("host-key-fingerprint")).toHaveText(hostFingerprint);
  await expect(page.getByTestId("browser-key-fingerprint")).toHaveText(browserFingerprint);
  await expect(page.getByText("build-host", { exact: false })).toBeVisible();
  expect(approved).toBe(false);

  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByRole("status")).toContainText("Approved daemon for host build-host");
  expect(approved).toBe(true);
  expect(approvalBody).toMatchObject({
    user_code: "QZ4K-7HMT",
    approval_nonce: APPROVAL_NONCE,
    host_key_algorithm: "ed25519",
    host_public_key: hostPublicKey,
    host_key_fingerprint: hostFingerprint,
    browser_device_id: BROWSER_DEVICE_ID,
    browser_key_algorithm: "ed25519",
    browser_public_key: browserPublicKey,
    browser_key_fingerprint: browserFingerprint,
  });
  expect((approvalBody as { signature: string }).signature).toHaveLength(86);
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
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = route.request().postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          fingerprint: fingerprint(body.public_key),
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
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
          approval_nonce: APPROVAL_NONCE,
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

test("substituted approval response fails loudly and requires review again", async ({ page }) => {
  const hostPublicKey = "A".repeat(43);
  const hostFingerprint = "SHA256:0123456789abcdef";

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          user: {
            id: USER_ID,
            email: "owner@example.com",
            created_at: "2026-07-17T00:00:00Z",
          },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          fingerprint: fingerprint(body.public_key),
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "substituted-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      const body = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_name: "substituted-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: hostPublicKey,
          host_key_fingerprint: hostFingerprint,
          browser_device_id: "00000000-0000-4000-8000-000000000010",
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
          browser_key_fingerprint: body.browser_key_fingerprint,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/device");
  await page.getByLabel("Device code").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Review daemon" }).click();
  await page.getByRole("button", { name: "Confirm approval" }).click();

  await expect(page.locator("p[role=alert]")).toContainText(
    "Approval response changed the reviewed host or browser identity",
  );
  await expect(page.getByTestId("host-key-fingerprint")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Review daemon" })).toBeVisible();
});
