import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

// The committed-ephemeral SAS on /device (docs/TRUST_DEVICE_MESH.md Appendix A),
// entry-style per docs/TRUST_UX.md: the browser contributes Nb, the daemon
// reveals Nd, the browser verifies the commitment opens and then asks the
// operator to TYPE the six digits the host's terminal shows. A correct entry is
// the approval; a relay that reveals a mismatched Nd (a substitution) must be
// caught by the commit check before any number is accepted.

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

/** The six digits both endpoints derive — byte-identical to src/lib/sas.ts. */
function sasDigits(hostKey: Buffer, browserKey: Buffer, nd: Buffer, nb: Buffer): string {
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from("SPAWN-SAS-V1"), hostKey, browserKey, nd, nb]))
    .digest();
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return (n % 1_000_000).toString().padStart(6, "0");
}

interface Contribution {
  nb: Buffer;
  browserKey: Buffer;
}

/** Install the common auth + browser-registration mocks, plus a SAS-aware
 * device flow. `revealedNd` is what the "daemon" reveals — pass a tampered value
 * to simulate a substituting relay. Returns a handle that captures the
 * browser's contribution, from which the test derives the number the host's
 * terminal would be showing. */
async function installRoutes(
  page: Page,
  opts: { revealedNd: Buffer },
): Promise<{ contribution: () => Contribution | null }> {
  const commit = sasCommit(HOST_PUBLIC_KEY, ND);
  let contribution: Contribution | null = null;
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
      const body = route.request().postDataJSON() as {
        sas_browser_nonce: string;
        browser_public_key: string;
      };
      contribution = {
        nb: Buffer.from(body.sas_browser_nonce, "base64url"),
        browserKey: Buffer.from(body.browser_public_key, "base64url"),
      };
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
          sas_host_nonce: contribution !== null ? opts.revealedNd.toString("base64url") : null,
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
  return { contribution: () => contribution };
}

test("possess types the six digits; a wrong entry burns a try, the right one approves", async ({
  page,
}) => {
  const routes = await installRoutes(page, { revealedNd: ND });
  await page.goto("/device?code=QZ4K-7HMT");

  // The entry field appears once the commitment opened and the SAS is derivable.
  const entry = page.getByTestId("number-entry");
  await expect(entry).toBeVisible({ timeout: 15_000 });
  const contribution = routes.contribution();
  if (contribution === null) throw new Error("browser never contributed Nb");
  const digits = sasDigits(
    Buffer.from(HOST_PUBLIC_KEY, "base64url"),
    contribution.browserKey,
    ND,
    contribution.nb,
  );

  // A wrong number is feedback, not approval.
  const wrong = digits.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
  await entry.fill(wrong);
  await expect(page.getByTestId("entry-error")).toContainText("2 tries left");

  // The right number IS the approval.
  await entry.fill(digits);
  await expect(page.getByTestId("ceremony-done")).toContainText("sas-host is possessed", {
    timeout: 15_000,
  });
});

test("three wrong entries end the ceremony with nothing trusted", async ({ page }) => {
  const routes = await installRoutes(page, { revealedNd: ND });
  await page.goto("/device?code=QZ4K-7HMT");

  const entry = page.getByTestId("number-entry");
  await expect(entry).toBeVisible({ timeout: 15_000 });
  const contribution = routes.contribution();
  if (contribution === null) throw new Error("browser never contributed Nb");
  const digits = sasDigits(
    Buffer.from(HOST_PUBLIC_KEY, "base64url"),
    contribution.browserKey,
    ND,
    contribution.nb,
  );
  const wrong = digits.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
  await entry.fill(wrong);
  await expect(page.getByTestId("entry-error")).toContainText("2 tries left");
  await entry.fill(wrong);
  await expect(page.getByTestId("entry-error")).toContainText("1 try left");
  await entry.fill(wrong);
  await expect(page.getByTestId("number-check")).toHaveAttribute("data-phase", "stopped");
  await expect(page.getByText("The numbers don't match")).toBeVisible();
});

test("a relay that reveals a mismatched Nd is caught by the commit check", async ({ page }) => {
  // The "daemon" reveals a nonce that does not open the commitment — exactly
  // what a substituting relay would have to do. The browser must refuse.
  await installRoutes(page, { revealedNd: Buffer.alloc(32, 8) });
  await page.goto("/device?code=QZ4K-7HMT");

  await expect(page.locator("p[role=alert]")).toContainText("commitment did not open", {
    timeout: 15_000,
  });
  // No entry field is offered: there is no sound number to check against.
  await expect(page.getByTestId("number-entry")).toHaveCount(0);
});
