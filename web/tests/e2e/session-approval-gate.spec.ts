import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  BROWSER_DEVICE_ID,
  CREATED_AT,
  HOST_ID,
  host,
  mockApp,
  SESSION_ID,
  session,
} from "./app-mocks";

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
  // ...and the card says what would make next time one touch (#121).
  await expect(gate.getByTestId("session-gate-passkey-hint")).toHaveText(
    "Once you're in, add a passkey in Account. Next time this device can get back in without another one.",
  );
  await expect(gate.getByRole("link", { name: /Possess a host directly/u })).toBeVisible();

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
  const pinsAnswered = page.waitForResponse((response) =>
    response.url().endsWith(`/api/trust/hosts/${HOST_ID}/pins`),
  );
  await page.goto(`/sessions/${SESSION_ID}`);
  await pinsAnswered;

  // The session surface renders normally (header shows the agent), and the
  // gate, once it has decided, keeps the card away.
  await expect(page.getByText("palette").first()).toBeVisible();
  await expectGateClear(page);
});

/**
 * Waits for the gate's own decision, then checks it kept the card away. Only
 * meaningful once the pins have answered: before the host list loads the gate
 * has no host to ask about and reads clear.
 */
async function expectGateClear(page: Page) {
  await expect(page.getByTestId("session-approval-state")).toHaveAttribute("data-state", "clear");
  await expect(page.getByTestId("session-approval-gate")).toHaveCount(0);
}

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

// #138: the account's approval and one host's confirmation of it are different
// states. An approved browser whose host nacked a pin for a reason that says
// nothing against the approval (a reconcile that could not run, a full host)
// is not asked to be approved again — approving again would change nothing —
// while a pin the host could not verify, or a removed approver, still leaves
// the browser unapproved.

const APPROVER_ID = "00000000-0000-4000-8000-000000000077";
const approver = (revokedAt: string | null = null) => ({
  id: APPROVER_ID,
  key_algorithm: "ed25519",
  // Any key but this browser's own (which the page generates).
  public_key: "q3Z8V7mT2xQ9bN4cR6sW1yE5uI0oP8aS3dF7gH2jK4l",
  fingerprint: "SHA256:approverapprover",
  label: "Chrome on Mac",
  created_at: CREATED_AT,
  revoked_at: revokedAt,
});

/** Every request that asks other devices for approval: the roster stamp and the knock. */
function watchAsks(page: Page): string[] {
  const asks: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = request.url();
    if (url.endsWith("/request-approval") || url.endsWith("/api/trust/device-approvals")) {
      asks.push(url);
    }
  });
  return asks;
}

/**
 * Opens the session as a browser that was registered before this page load,
 * as an approved browser always is: the mock registers it on its first load,
 * so a single load could read the device list before this browser's own row
 * exists. Resolves once the gate has had everything it decides from.
 */
async function openSessionAsRegisteredBrowser(page: Page) {
  const registered = page.waitForResponse((response) =>
    response.url().endsWith("/api/browser-devices/register"),
  );
  await page.goto("/app");
  await registered;
  const answered = Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/trust/hosts/${HOST_ID}/pins`)),
    page.waitForResponse((response) => response.url().endsWith("/api/trust/account-endorsements")),
  ]);
  await page.goto(`/sessions/${SESSION_ID}`);
  await answered;
}

for (const reason of ["other", "pin_limit"] as const) {
  test(`an approved device is not asked again when its host has not confirmed an approval (${reason})`, async ({
    page,
  }) => {
    const asks = watchAsks(page);
    await mockApp(page, {
      hosts: [KEYED_HOST],
      sessions: [session()],
      extraBrowserDevices: [approver()],
      // The only pinned device's pin was nacked; this browser was approved by it.
      hostPinRecords: {
        [HOST_ID]: [
          { browser_device_id: APPROVER_ID, delivered: false, undelivered_reason: reason },
        ],
      },
      accountEndorsements: [
        { endorser_device_id: APPROVER_ID, endorsed_device_id: BROWSER_DEVICE_ID },
      ],
    });
    await openSessionAsRegisteredBrowser(page);

    await expect(page.getByText("palette").first()).toBeVisible();
    await expectGateClear(page);
    expect(asks).toEqual([]);
  });
}

test("a device whose own pin its host has not confirmed is not asked again", async ({ page }) => {
  const asks = watchAsks(page);
  await mockApp(page, {
    hosts: [KEYED_HOST],
    sessions: [session()],
    hostPinRecords: {
      [HOST_ID]: [
        { browser_device_id: BROWSER_DEVICE_ID, delivered: false, undelivered_reason: "other" },
      ],
    },
  });
  await openSessionAsRegisteredBrowser(page);

  await expect(page.getByText("palette").first()).toBeVisible();
  await expectGateClear(page);
  expect(asks).toEqual([]);
});

test("an approval the host could not verify still leaves the device waiting", async ({ page }) => {
  await mockApp(page, {
    hosts: [KEYED_HOST],
    sessions: [session()],
    extraBrowserDevices: [approver()],
    hostPinRecords: {
      [HOST_ID]: [
        { browser_device_id: APPROVER_ID, delivered: false, undelivered_reason: "invalid_chain" },
      ],
    },
    accountEndorsements: [
      { endorser_device_id: APPROVER_ID, endorsed_device_id: BROWSER_DEVICE_ID },
    ],
  });
  const knocked = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/trust/device-approvals") && request.method() === "POST",
  );
  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByTestId("session-approval-gate")).toBeVisible();
  await knocked;
});

test("a device approved only by a removed device still gets the card", async ({ page }) => {
  await mockApp(page, {
    hosts: [KEYED_HOST],
    sessions: [session()],
    extraBrowserDevices: [approver("2026-11-15T00:00:00Z")],
    // A stale row for the removed approver: it seeds nothing.
    hostPinRecords: {
      [HOST_ID]: [
        { browser_device_id: APPROVER_ID, delivered: false, undelivered_reason: "other" },
      ],
    },
    accountEndorsements: [
      { endorser_device_id: APPROVER_ID, endorsed_device_id: BROWSER_DEVICE_ID },
    ],
  });
  const knocked = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/trust/device-approvals") && request.method() === "POST",
  );
  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByTestId("session-approval-gate")).toBeVisible();
  await knocked;
});
