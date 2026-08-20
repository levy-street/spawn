import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockAuthenticatedApi } from "./app-mocks";

// Device approval lives on Settings → Access: unapproved sign-ins are waiting
// rows, an untrusted device gets a guided callout, and toward LEGACY hosts
// (no account-chain support, mesh R9) a trusted device approves per-host via
// the fingerprint ceremony under Advanced. Verification stays
// fingerprint-only throughout — names and any other server-supplied fields
// never substitute for the comparison.

const KEYED_HOST = {
  ...host,
  host_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
  host_key_fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
};

// A real Ed25519 key: the fingerprint derivation imports the key, so an
// arbitrary 32-byte string would be rejected as an invalid curve point.
const SECOND_DEVICE_KEY = (() => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
})();
const SECOND_DEVICE_ID = "00000000-0000-4000-8000-000000000077";

function fingerprintOf(publicKey: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest()
    .subarray(0, 12)
    .toString("base64url");
  return `SHA256:${digest}`;
}

const secondDevice = {
  id: SECOND_DEVICE_ID,
  key_algorithm: "ed25519",
  public_key: SECOND_DEVICE_KEY,
  fingerprint: fingerprintOf(SECOND_DEVICE_KEY),
  label: "Pixel phone",
  created_at: "2026-08-01T00:00:00Z",
  revoked_at: null,
};

test("an untrusted browser gets a guided callout, not a dead end", async ({ page }) => {
  await mockAuthenticatedApi(page, { hosts: [KEYED_HOST], hostPins: {} });
  await page.goto("/settings");

  const callout = page.getByTestId("untrusted-callout");
  await expect(callout).toBeVisible();
  await expect(callout).toContainText("waiting for approval");
  // The account's first (and only) device carries no waiting pill — there is
  // nothing that could approve it; the callout is its guidance.
  // An untrusted device cannot vouch for others: no Approve actions.
  await expect(page.getByRole("button", { name: "Approve…" })).toHaveCount(0);
});

test("a trusted browser approves a waiting device through the fingerprint ceremony", async ({
  page,
}) => {
  await mockAuthenticatedApi(page, {
    hosts: [KEYED_HOST],
    extraBrowserDevices: [secondDevice],
    hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] },
  });
  await page.goto("/settings");

  // This device is trusted; the fixture device is waiting.
  const pixelRow = page.getByTestId("device-row").filter({ hasText: "Pixel phone" });
  await expect(pixelRow.getByTestId("waiting-pill")).toBeVisible();

  // Toward a legacy host the per-host ceremony lives under Advanced.
  const advanced = page.getByTestId("access-advanced");
  await advanced.locator("summary").click();
  await advanced
    .locator("div", { hasText: "Approve for older hosts" })
    .getByRole("button", { name: "Approve…" })
    .first()
    .click();
  const panel = page.getByTestId("endorse-panel");
  await expect(panel).toBeVisible();
  // The panel shows the locally derived fingerprint of the waiting device.
  await expect(panel).toContainText(fingerprintOf(SECOND_DEVICE_KEY));

  await panel.getByRole("button", { name: "It matches — approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toContainText(
    "for 1 host",
  );
  // The waiting pill converges once the endorsement is recorded.
  await expect(pixelRow.getByTestId("waiting-pill")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("untrusted-callout")).toHaveCount(0);
});

test("a server-substituted key cannot be approved", async ({ page }) => {
  // The server lists the device with a fingerprint that does not match its
  // key. The ceremony re-derives locally and must refuse to sign.
  await mockAuthenticatedApi(page, {
    hosts: [KEYED_HOST],
    extraBrowserDevices: [{ ...secondDevice, fingerprint: "SHA256:attackerchoice_A" }],
    hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] },
  });
  await page.goto("/settings");

  const pixelRow = page.getByTestId("device-row").filter({ hasText: "Pixel phone" });
  const advanced = page.getByTestId("access-advanced");
  await advanced.locator("summary").click();
  await advanced
    .locator("div", { hasText: "Approve for older hosts" })
    .getByRole("button", { name: "Approve…" })
    .first()
    .click();
  await page
    .getByTestId("endorse-panel")
    .getByRole("button", { name: "It matches — approve" })
    .click();
  await expect(page.getByTestId("endorse-panel")).toContainText("does not match its key");
  await expect(pixelRow.getByTestId("waiting-pill")).toBeVisible();
});
