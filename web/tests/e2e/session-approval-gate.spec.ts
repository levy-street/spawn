import { expect, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, HOST_ID, host, mockApp, SESSION_ID, session } from "./app-mocks";

// Opening an agent session on an unapproved device cannot connect — the daemon
// refuses the offer. The session approval gate (docs/TRUST_UX.md §3, §7) turns
// that refusal into the flow: a blocking card over the session that asks the
// account's other devices for approval and offers the passkey / possess
// escapes. It yields to the app-level number check the moment an approver
// starts, and it never appears on a trusted device.

const KEYED_HOST = {
  ...host,
  host_public_key: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
};

test("an unapproved device opening an agent session gets the approval card and asks out loud", async ({
  page,
}) => {
  await mockApp(page, { hosts: [KEYED_HOST], sessions: [session()], hostPins: {} });

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
  await expect(gate).toContainText("One step left");
  // The device carries a UA-derived label from registration; the sentence is
  // stable either way.
  await expect(gate).toContainText("from a device you already use");
  await asked;
  await knocked;
  await expect(gate).toContainText("Your other devices have been asked");
  // The approver compares against this: the browser's own key, derived here.
  await expect(gate.getByTestId("session-gate-fingerprint")).toContainText("SHA256:");
  // No passkey on this account: the escape hatch is possession, not unlock.
  await expect(gate.getByTestId("session-gate-passkey")).toHaveCount(0);
  await expect(gate.getByRole("button", { name: /Possess a host directly/u })).toBeVisible();

  // The ask landed on this device's roster row for every other device to see.
  const devices = await page.evaluate(async () => {
    const response = await fetch("/api/browser-devices");
    return (await response.json()) as Array<{ id: string; approval_requested_at: string | null }>;
  });
  const self = devices.find((device) => device.id === BROWSER_DEVICE_ID);
  expect(self?.approval_requested_at).not.toBeNull();
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
