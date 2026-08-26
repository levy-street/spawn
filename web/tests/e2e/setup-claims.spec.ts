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
  // The command this screen handed over carries a setup token, so the terminal
  // shows the same fingerprint and no link — the copy must ask for exactly the
  // comparison the terminal is offering, with no manual-entry escape.
  await expect(
    page.getByText(
      "The terminal you ran the command in is showing a key. Check it matches the one below, then approve.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter a pairing code instead" })).toHaveCount(0);

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
  // The ceremony ends at a possessed machine, not at a workspace nobody chose.
  await expect(page).toHaveURL("/app", { timeout: 7_000 });
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
  expect(store.requests.workspaces).toHaveLength(0);
});

test("closing a fingerprint mismatch returns a usable screen, not a forever loader", async ({
  page,
}) => {
  // "They don't match" is terminal, and Close resets the ceremony. The reset
  // clears the loaded approval while the claim's handle stays on the surface —
  // which used to read as "handed a ceremony, do not have it yet" and left a
  // progress bar captioned "Looking up that machine…" running for ever over a
  // ceremony that had just been deliberately abandoned.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const store = await mockApp(page, {
    hosts: [],
    workspaces: [],
    setupClaim: claimFixture(),
  });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Copy install command" }).click();
  Object.assign(store.setupClaim as Record<string, unknown>, {
    status: "ready",
    approval_ref: APPROVAL_REF,
    host_name: "Mac",
    os: "macos",
    host_key_fingerprint: "display-only",
  });
  await expect(page.getByTestId("host-key-fingerprint")).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: "They don't match" }).click();
  await expect(page.getByText("The numbers don't match")).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();

  // Closing re-mints, and the server answers a fresh claim — this mock holds
  // one, so put it back to pending the way a new one would arrive.
  Object.assign(store.setupClaim as Record<string, unknown>, {
    status: "pending",
    approval_ref: null,
    host_name: null,
    os: null,
    host_key_fingerprint: null,
  });

  // Back to the start, not to an empty approval surface: a refused ceremony
  // spends its claim, so beginning again means a fresh command to run.
  await expect(page.getByTestId("pairing-loading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible({
    timeout: 7_000,
  });
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
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

test("expired approval links use the catalogue instead of the raw server string", async ({
  page,
}) => {
  await mockApp(page, {
    devicePendingError: { status: 400, detail: "user code is expired" },
  });
  await page.goto("/device?code=QZ4K-7HMT");
  const failure = page.getByTestId("pairing-failure");
  await expect(failure).toContainText(
    "That approval expired. On the machine, run spawnd possess again.",
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
