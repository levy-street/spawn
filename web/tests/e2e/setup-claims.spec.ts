import { expect, test } from "@playwright/test";
import { HOST_ID, host, mockApp } from "./app-mocks";

const SETUP_TOKEN = "s".repeat(43);
const APPROVAL_REF = "approval-ref-phase-c";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

function claimFixture(overrides: Record<string, unknown> = {}) {
  return {
    token: SETUP_TOKEN,
    expires_in: 1_800,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    status: "pending",
    approval_ref: null,
    host_name: null,
    os: null,
    host_key_fingerprint: null,
    host_id: null,
    error: null,
    ...overrides,
  };
}

test("setup claim advances inline approval through the existing onboarding done beat", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const store = await mockApp(page, {
    hosts: [],
    workspaces: [],
    setupClaim: claimFixture(),
  });

  await page.goto("/onboarding");
  const command = page.getByText(new RegExp(`--setup ${SETUP_TOKEN}`));
  await expect(command).toBeVisible();
  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect(page.locator('[data-step="1"]')).toHaveAttribute("data-state", "complete");

  Object.assign(store.setupClaim as Record<string, unknown>, {
    status: "ready",
    approval_ref: APPROVAL_REF,
    host_name: "Mac",
    os: "macos",
    host_key_fingerprint: "display-only",
  });

  await expect(page.locator('[data-step="2"]')).toHaveAttribute("data-state", "complete", {
    timeout: 5_000,
  });
  await expect(
    page.getByText(
      "Fastest: open the link in the machine's terminal — it verifies the identity automatically. Or compare the fingerprint below against the terminal.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter a pairing code instead" })).toBeVisible();

  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.locator('[data-step="3"]')).toHaveAttribute("data-state", "complete");

  Object.assign(store.setupClaim as Record<string, unknown>, {
    status: "approved",
    host_id: HOST_ID,
  });
  store.hosts.push({ ...host, status: "online", session_count: 0 });

  // The setup cache paints Online before its one-shot callback advances the parent.
  await expect(page.locator('[data-step="4"]')).toHaveAttribute("data-state", "complete", {
    timeout: 7_000,
  });
  await expect(page.getByText("Your host is online. Building a workspace…")).toBeVisible({
    timeout: 7_000,
  });
  await expect.poll(() => store.requests.workspaces.length).toBe(1);
  await expect(page).toHaveURL(/\/w\//);
});

test("the checklist adds its exact stalled escape after 60 seconds", async ({ page }) => {
  await page.clock.install();
  await mockApp(page, { hosts: [], workspaces: [], setupClaim: claimFixture() });
  await page.goto("/onboarding");
  await expect(page.getByTestId("setup-checklist")).toBeVisible();
  await page.clock.fastForward(30_100);
  await expect(page.getByText("Still waiting…")).toBeVisible();
  await page.clock.fastForward(30_100);
  await expect(page.getByTestId("setup-stalled-hint")).toHaveText(
    "Having trouble? Re-run the install command — it's safe to repeat.",
  );
});

test("expired typed codes use the catalogue instead of the raw server string", async ({ page }) => {
  await mockApp(page, {
    devicePendingError: { status: 400, detail: "user code is expired" },
  });
  await page.goto("/device?code=QZ4K-7HMT");
  const failure = page.getByTestId("pairing-failure");
  await expect(failure).toContainText(
    "That code expired. On the machine, run spawnd possess again.",
  );
  await expect(failure).not.toContainText("user code is expired");
});

test("AuthGate and password login restore the tab-scoped approval fragment", async ({ page }) => {
  const store = await mockApp(page, { me: null, workspaces: [] });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page).toHaveURL(/\/login\?next=.*device/);

  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  expect(store.requests.auth).toContainEqual({
    path: "/api/auth/device/pending",
    approval_ref: APPROVAL_REF,
  });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("spawn:device-approval")))
    .toBeNull();
});

test("OAuth receives the validated device path and query, never its fragment", async ({ page }) => {
  await mockApp(page, {
    me: null,
    config: { providers: [{ id: "google", name: "Google" }] },
  });
  const next = encodeURIComponent(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await page.goto(`/login?next=${next}`);
  const oauth = page.getByRole("link", { name: "Continue with Google" });
  await expect(oauth).toHaveAttribute(
    "href",
    `/api/auth/oauth/google/start?return_to=${encodeURIComponent(`/device?ref=${APPROVAL_REF}`)}`,
  );
  await expect(oauth).not.toHaveAttribute("href", /%23k%3D/);
});

test("key_conflict on /device shows the exact three-option catalogue", async ({ page }) => {
  await mockApp(page, {
    devicePendingError: { status: 409, code: "key_conflict", message: "key_conflict" },
  });
  await page.goto("/device?ref=conflicted");
  const failure = page.getByTestId("pairing-failure");
  await expect(failure).toContainText(
    "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.",
  );
  await expect(failure).toContainText(
    "To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.",
  );
  await expect(failure).toContainText(
    "To keep both accounts on this machine: spawnd possess --new-account",
  );
});
