import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

// The committed-ephemeral SAS on /device (docs/TRUST_DEVICE_MESH.md Appendix A):
// the browser contributes Nb, the daemon reveals Nd, the browser verifies the
// commitment opens and shows the 6-digit number. A relay that reveals a
// mismatched Nd (a substitution) must be caught by the commit check.

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const ND = Buffer.alloc(32, 7); // daemon nonce (fixed for the test)

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return `SHA256:${digest.subarray(0, 12).toString("base64url")}`;
}

/** Cd = SHA256("SPAWN-SAS-COMMIT-V1" ‖ hostKey ‖ Nd) — same as daemon/web. */
function sasCommit(hostKeyB64url: string, nd: Buffer): string {
  const hostKey = Buffer.from(hostKeyB64url, "base64url");
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("SPAWN-SAS-COMMIT-V1"), hostKey, nd]))
    .digest()
    .toString("base64url");
}

/** Install the common auth + browser-registration mocks, plus a SAS-aware
 * device flow. `revealedNd` is what the "daemon" reveals — pass a tampered value
 * to simulate a substituting relay. */
async function installRoutes(page: Page, opts: { revealedNd: Buffer }): Promise<void> {
  const commit = sasCommit(HOST_PUBLIC_KEY, ND);
  let contributed = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        json: { user: { id: USER_ID, email: "sas@example.com", created_at: "2026-07-17T00:00:00Z" } },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = route.request().postDataJSON() as { public_key: string };
      await route.fulfill({
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
    if (path === "/api/auth/device/sas") {
      contributed = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path === "/api/auth/device/pending") {
      await route.fulfill({
        json: {
          host_name: "sas-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
          sas_commit: commit,
          // Nd is revealed only after the browser has contributed Nb.
          sas_host_nonce: contributed ? opts.revealedNd.toString("base64url") : null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          host_name: "sas-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_PUBLIC_KEY,
          host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
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
}

test("SAS pairing shows a 6-digit number and approves", async ({ page }) => {
  await installRoutes(page, { revealedNd: ND });
  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();

  // The committed-ephemeral number appears (not the "· · ·" placeholder).
  await expect(page.getByTestId("verification-code")).toHaveText(/^\d{3} \d{3}$/, {
    timeout: 15_000,
  });
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByRole("status")).toContainText("is connected");
});

test("a relay that reveals a mismatched Nd is caught by the commit check", async ({ page }) => {
  // The "daemon" reveals a nonce that does not open the commitment — exactly
  // what a substituting relay would have to do. The browser must refuse.
  await installRoutes(page, { revealedNd: Buffer.alloc(32, 8) });
  await page.goto("/device");
  await page.getByLabel("Code from the terminal").fill("QZ4K-7HMT");
  await page.getByRole("button", { name: "Look up host" }).click();

  await expect(page.locator("p[role=alert]")).toContainText("commitment did not open", {
    timeout: 15_000,
  });
  // No number was shown, and approval is blocked.
  await expect(page.getByTestId("verification-code")).toHaveText("· · ·");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
});
