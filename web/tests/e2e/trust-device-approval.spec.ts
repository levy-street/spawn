import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockAuthenticatedApi } from "./app-mocks";

// Device approval now lives in Settings → Browser devices: untrusted devices
// are badged, a trusted browser approves them inline via the fingerprint
// ceremony, and an untrusted browser gets a guided callout instead of a
// dead-end. Verification stays fingerprint-only throughout — names and any
// other server-supplied fields never substitute for the comparison.

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
  await expect(callout).toContainText("can't open terminals yet");
  await expect(callout).toContainText(/SHA256:/);
  await expect(page.getByText("not trusted yet").first()).toBeVisible();
  // An untrusted browser cannot vouch for others: no Approve actions.
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

  // This browser is trusted; the fixture device is waiting.
  await expect(page.getByText(/^trusted · 1 host$/).first()).toBeVisible();
  const pixelRow = page.locator("div.p-3", { hasText: "Pixel phone" }).first();
  await expect(pixelRow.getByText("not trusted yet")).toBeVisible();

  await pixelRow.getByRole("button", { name: "Approve…" }).click();
  const panel = page.getByTestId("endorse-panel");
  await expect(panel).toBeVisible();
  // The panel shows the locally derived fingerprint of the waiting device.
  await expect(panel).toContainText(fingerprintOf(SECOND_DEVICE_KEY));

  await panel.getByRole("button", { name: "It matches — approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toContainText(
    "for 1 host",
  );
  // The advisory badge converges once the endorsement is recorded.
  await expect(pixelRow.getByText(/^trusted · 1 host$/)).toBeVisible({ timeout: 20_000 });
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

  const pixelRow = page.locator("div.p-3", { hasText: "Pixel phone" }).first();
  await pixelRow.getByRole("button", { name: "Approve…" }).click();
  await page
    .getByTestId("endorse-panel")
    .getByRole("button", { name: "It matches — approve" })
    .click();
  await expect(page.getByTestId("endorse-panel")).toContainText("does not match its key");
  await expect(pixelRow.getByText("not trusted yet")).toBeVisible();
});
