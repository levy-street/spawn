import { expect, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockApp, SESSION_ID, session } from "./app-mocks";

// Opening an agent session on an unapproved device cannot connect — the daemon
// refuses the offer. The session approval gate (docs/TRUST_UX.md §3, §7) turns
// that refusal into the flow: an in-pane card that asks the
// account's other devices for approval and offers the passkey / possess
// escapes. It yields to the app-level number check the moment an approver
// starts, and it never appears on a trusted device.

const KEYED_HOST = {
  ...host,
  host_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
};
const TRUSTED_DEVICE_ID = "00000000-0000-4000-8000-000000000077";
const TRUSTED_DEVICE = {
  id: TRUSTED_DEVICE_ID,
  key_algorithm: "ed25519",
  public_key: "zMT5uuBbVnK1BqiZZKcmQ_6LR08rPL4KJQOqhPmxZ5c",
  label: "Trusted phone",
  created_at: "2026-08-01T00:00:00Z",
  revoked_at: null,
};

test("an unapproved device opening an agent session gets the approval card and asks out loud", async ({
  page,
}) => {
  await mockApp(page, {
    hosts: [KEYED_HOST],
    sessions: [session()],
    extraBrowserDevices: [TRUSTED_DEVICE],
    hostPins: { [HOST_ID]: [TRUSTED_DEVICE_ID] },
  });

  const asked = page.waitForRequest(
    (request) =>
      request.url().includes("/api/browser-devices/") &&
      request.url().endsWith("/request-approval") &&
      request.method() === "POST",
  );
  // The knock: what raises the approval prompt on trusted screens and pushes
  // to the account's phones.
  const knocked = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/trust/device-approvals") && request.method() === "POST",
  );
  await page.goto(`/sessions/${SESSION_ID}`);

  const gate = page.getByTestId("session-approval-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("Approve this device");
  // The device carries a UA-derived label from registration; the sentence is
  // stable either way.
  await expect(gate).toContainText("from a device you already use");
  await asked;
  await knocked;
  await expect(gate).toContainText("4-digit number");
  await expect(gate.getByTestId("session-gate-fingerprint")).toHaveCount(0);
  // No passkey on this account: the escape hatch is possession, not unlock.
  await expect(gate.getByTestId("session-gate-passkey")).toHaveCount(0);
  await expect(gate.getByRole("button", { name: "Open Access" })).toBeVisible();
  // The card is in the pane, so navigation stays available.
  await expect(page.getByRole("button", { name: /^Settings/u })).toBeVisible();

  // The ask landed on this device's roster row for every other device to see.
  const devices = await page.evaluate(async () => {
    const response = await fetch("/api/browser-devices");
    return (await response.json()) as Array<{ id: string; approval_requested_at: string | null }>;
  });
  const self = devices.find((device) => device.id === BROWSER_DEVICE_ID);
  expect(self?.approval_requested_at).not.toBeNull();
});

test("zero trusted approvers swaps the spinner for recovery guidance", async ({ page }) => {
  await mockApp(page, { hosts: [KEYED_HOST], sessions: [session()], hostPins: {} });
  await page.goto(`/sessions/${SESSION_ID}`);

  const gate = page.getByTestId("session-approval-gate");
  await expect(gate).toContainText("No trusted device can approve this one");
  await expect(gate).toContainText("Manage this machine");
  await expect(gate).toContainText("spawnd");
  await expect(gate.getByLabel("Waiting for device approval")).toHaveCount(0);
});

test("a trusted device never sees the gate", async ({ page }) => {
  await mockApp(page, {
    hosts: [KEYED_HOST],
    sessions: [session()],
    hostPins: { [HOST_ID]: [BROWSER_DEVICE_ID] },
  });
  await page.goto(`/sessions/${SESSION_ID}`);

  // The session surface renders normally (header shows the agent) and the
  // gate stays away through a couple of poll cycles.
  await expect(page.getByText("palette").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("session-approval-gate")).toHaveCount(0);
});

test("the card yields to the number check when an approver starts", async ({ page }) => {
  await mockApp(page, { hosts: [KEYED_HOST], sessions: [session()], hostPins: {} });
  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByTestId("session-approval-gate")).toBeVisible();

  // An approver started a ceremony naming this device as the joiner: the
  // pairing poll now returns a live row (registered after the app mocks, so it
  // wins), and the gate must hand the screen to the ceremony dialog.
  await page.route(
    (url) => url.pathname === "/api/trust/pairing" && url.searchParams.has("device_id"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: [
          {
            id: "00000000-0000-4000-8000-0000000000aa",
            initiator_device_id: "00000000-0000-4000-8000-000000000077",
            joiner_device_id: BROWSER_DEVICE_ID,
            initiator_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
            initiator_commit: "A".repeat(43),
            joiner_public_key: null,
            joiner_nonce: null,
            initiator_nonce: null,
            created_at: "2026-08-21T00:00:00Z",
            expires_at: "2027-01-01T00:00:00Z",
          },
        ],
      });
    },
  );

  const ceremony = page.getByTestId("approve-ceremony");
  await expect(ceremony).toBeVisible();
  await expect(page.getByTestId("session-approval-gate")).toHaveCount(0);
});
