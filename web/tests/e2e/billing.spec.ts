import { expect, test } from "@playwright/test";
import { host, mockApp, openSettings, user } from "./app-mocks";

/**
 * Billing, from the app's side (docs/BILLING.md §5).
 *
 * Four things this file exists to hold still:
 *   1. the ceremony refuses a machine the plan will not admit, and says how to
 *      fix it — but never inside onboarding, where the first host is free;
 *   2. a downgrade asks which machines to keep and releases them itself,
 *      because the server never releases one on a billing signal;
 *   3. the over-limit modal cannot be got rid of without answering it, and
 *      keeping none is offered in the open;
 *   4. a deployment without billing shows none of it, anywhere.
 */

const APPROVAL_REF = "wL0aFhZ0S3nQ8yq2m4X1nAmBcDeFgHiJkLmNoPqRsTu";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

const HOST_LIMIT_402 = {
  status: 402,
  detail: { code: "host_limit", tier: "coven", host_limit: 3, host_count: 3 },
};

function extraHost(index: number, name: string) {
  return {
    ...host,
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    name,
  };
}

test("a full plan refuses the ceremony, says the numbers, and offers the way out", async ({
  page,
}) => {
  await mockApp(page, {
    hosts: [host, extraHost(1, "Studio"), extraHost(2, "Linux box")],
    billing: { tier: "coven", host_limit: 3, has_subscription: true },
    deviceApproveError: HOST_LIMIT_402,
  });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("possess-approve").click();

  const block = page.getByTestId("possess-host-limit");
  await expect(block).toBeVisible();
  // The reader is told what the limit is and what they are on — not just that
  // they hit one.
  await expect(block).toContainText("Coven");
  await expect(block).toContainText("3");
  await expect(block).toContainText("Nothing on the machine was changed");
  // Not the plain-text catalogue path: this failure has controls.
  await expect(page.getByTestId("pairing-failure")).toHaveCount(0);
  await expect(block.getByRole("link", { name: "Manage hosts" })).toHaveAttribute(
    "href",
    "/legion",
  );

  // Upgrade opens Settings → Subscription rather than leaving the product,
  // because this same component runs inside the desktop window.
  await page.getByTestId("possess-host-limit-upgrade").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
});

test("onboarding never shows a paywall, even if the server refuses", async ({ page }) => {
  // The first host is free on every tier, so this is a wall nobody can
  // honestly hit — and meeting one before your first machine is even online
  // would be the worst possible introduction (docs/BILLING.md §5.8).
  await mockApp(page, {
    me: user,
    hosts: [],
    workspaces: [],
    billing: { tier: "free", host_limit: 1 },
    deviceApproveError: HOST_LIMIT_402,
  });
  await page.goto(`/onboarding?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("possess-approve").click();

  await expect(page.getByTestId("pairing-failure")).toBeVisible();
  await expect(page.getByTestId("possess-host-limit")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upgrade" })).toHaveCount(0);
});

test("the subscription panel reports the plan and its usage", async ({ page }) => {
  await mockApp(page, {
    hosts: [host, extraHost(1, "Studio")],
    billing: {
      tier: "coven",
      host_limit: 3,
      has_subscription: true,
      current_period_end: "2026-09-30T00:00:00Z",
    },
  });
  await openSettings(page, "subscription");
  await expect(page.getByTestId("subscription-tier")).toHaveText("Coven");
  await expect(page.getByTestId("subscription-hosts")).toHaveText("2 of 3 hosts");
  await expect(page.getByTestId("subscription-period")).toContainText("Renews on");
  await expect(page.getByRole("button", { name: "Change plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
});

test("a free account is offered an upgrade, which starts Checkout", async ({ page }) => {
  const store = await mockApp(page, {
    hosts: [host],
    billing: { tier: "free", host_limit: 1 },
  });
  await openSettings(page, "subscription");
  await expect(page.getByRole("button", { name: "Change plan" })).toHaveCount(0);
  await page.getByTestId("subscription-upgrade").click();

  const dialog = page.getByTestId("plan-change-dialog");
  await expect(dialog).toBeVisible();
  // Free is where a subscription ends, not a plan to move to: cancelling is
  // the portal's job, so it is not offered as a target here.
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  await dialog.getByRole("radio", { name: /Coven/ }).check();
  await dialog.getByTestId("plan-change-confirm").click();

  await expect.poll(() => store.requests.billing.map((row) => row.tier)).toEqual(["coven"]);
});

test("a downgrade asks which machines to keep, releases them, then changes plan", async ({
  page,
}) => {
  const store = await mockApp(page, {
    hosts: [host, extraHost(1, "Studio"), extraHost(2, "Linux box"), extraHost(3, "Old laptop")],
    billing: { tier: "legion", host_limit: 20, has_subscription: true },
  });
  await openSettings(page, "subscription");
  await page.getByRole("button", { name: "Change plan" }).click();

  const dialog = page.getByTestId("plan-change-dialog");
  await dialog.getByRole("radio", { name: /Coven/ }).check();
  await expect(dialog).toContainText("Applies immediately, not at the end of the month");
  await dialog.getByTestId("plan-change-confirm").click();

  // Four hosts, three admitted: the server answers 409 and the client turns
  // that into the choice rather than a refusal.
  await expect(dialog.getByTestId("host-keep-picker")).toBeVisible();
  await expect(dialog).toContainText("0 of 3 chosen");
  const release = dialog.getByTestId("plan-change-release-confirm");
  await expect(release).toBeDisabled();

  await dialog.getByRole("checkbox", { name: "Keep Mac" }).check();
  await dialog.getByRole("checkbox", { name: "Keep Studio" }).check();
  await dialog.getByRole("checkbox", { name: "Keep Linux box" }).check();
  // Exactly the number the new plan admits — no more.
  await expect(dialog.getByRole("checkbox", { name: "Keep Old laptop" })).toBeDisabled();
  await expect(release).toBeEnabled();
  await release.click();

  await expect
    .poll(() => store.hosts.map((row) => row.name))
    .toEqual(["Mac", "Studio", "Linux box"]);
  // The release happens FIRST, and the plan change is retried after it.
  await expect.poll(() => store.requests.billing.length).toBe(2);
  await expect(page.getByTestId("subscription-tier")).toHaveText("Coven");
});

test("a plan change that fails for any other reason says so, and asks for nothing", async ({
  page,
}) => {
  // Only `host_selection_required` turns into the host picker. Every other
  // refusal is a refusal, and must not be mistaken for a question.
  await mockApp(page, {
    hosts: [host],
    billing: { tier: "legion", host_limit: 20, has_subscription: true },
    changePlanError: { status: 503, detail: "Billing is temporarily unavailable" },
  });
  await openSettings(page, "subscription");
  await page.getByRole("button", { name: "Change plan" }).click();
  const dialog = page.getByTestId("plan-change-dialog");
  await dialog.getByRole("radio", { name: /Coven/ }).check();
  await dialog.getByTestId("plan-change-confirm").click();

  await expect(dialog.getByRole("alert")).toContainText("Billing is temporarily unavailable");
  await expect(dialog.getByTestId("host-keep-picker")).toHaveCount(0);
});

test("an over-limit account must choose, cannot dismiss, and may keep none", async ({ page }) => {
  const store = await mockApp(page, {
    hosts: [host, extraHost(1, "Studio"), extraHost(2, "Linux box")],
    // Cancelled through the portal: the plan is Free again while the account
    // still holds three machines (docs/BILLING.md §5.7).
    billing: { tier: "free", host_limit: 1 },
  });
  await page.goto("/legion");

  const modal = page.getByTestId("over-limit-reconciliation");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("carries on running until you decide");
  // No close affordance of any kind.
  await expect(modal.getByRole("button", { name: "Close" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  // A click on the scrim, well away from the panel.
  await page.mouse.click(5, 5);
  await expect(modal).toBeVisible();
  expect(store.hosts).toHaveLength(3);

  // Keeping none is a control in the open — live before anything is ticked,
  // not something you reach by unticking everything.
  await expect(modal.getByTestId("over-limit-keep-none")).toBeEnabled();
  await expect(modal.getByTestId("over-limit-confirm")).toHaveText("Release all 3 machines");
  await modal.getByRole("checkbox", { name: "Keep Mac" }).check();
  await modal.getByTestId("over-limit-keep-none").click();
  await expect(modal.getByTestId("over-limit-confirm")).toHaveText("Release all 3 machines");

  await modal.getByRole("checkbox", { name: "Keep Studio" }).check();
  await expect(modal.getByTestId("over-limit-confirm")).toHaveText("Keep 1, release 2");
  await modal.getByTestId("over-limit-confirm").click();

  await expect.poll(() => store.hosts.map((row) => row.name)).toEqual(["Studio"]);
  await expect(modal).toHaveCount(0);
});

test("the legion says it is full without disabling the way to add a machine", async ({ page }) => {
  await mockApp(page, {
    hosts: [host, extraHost(1, "Studio"), extraHost(2, "Linux box")],
    billing: { tier: "coven", host_limit: 3, has_subscription: true },
  });
  await page.goto("/legion");

  await expect(page.getByTestId("legion-at-capacity")).toContainText("3 of 3 hosts");
  await expect(page.getByTestId("legion-at-capacity")).toContainText("Coven is full");
  const add = page.getByRole("button", { name: "Add a machine", exact: true }).first();
  await expect(add).toBeEnabled();

  // A disabled button with no explanation is worse than a click that explains
  // itself, so the click still works and the dialog carries the reason.
  await add.click();
  const notice = page.getByTestId("legion-capacity-notice");
  await expect(notice).toContainText("Coven is full at 3 of 3 hosts");
  await notice.getByRole("button", { name: "Change plan" }).click();
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
});

test("the admin comp control never shows a bare 0, and stores one for unlimited", async ({
  page,
}) => {
  const patches: Array<Record<string, unknown>> = [];
  await mockApp(page, {
    me: { ...user, is_admin: true },
    billing: { tier: "coven", host_limit: 3, has_subscription: true },
  });
  const row = {
    id: "00000000-0000-4000-8000-000000000021",
    email: "guest@example.com",
    created_at: "2026-06-01T00:00:00Z",
    email_verified_at: null,
    is_admin: false,
    host_count: 4,
    session_count: 0,
    browser_device_count: 1,
    host_limit_override: null,
    billing_tier: "coven",
    effective_host_limit: 3,
  };
  await page.route("**/api/admin/users", async (route) => {
    await route.fulfill({ status: 200, json: [row] });
  });
  await page.route("**/api/admin/users/*", async (route) => {
    patches.push((await route.request().postDataJSON()) as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      json: { ...row, host_limit_override: 0, effective_host_limit: null },
    });
  });
  await page.route("**/api/admin/mail", (route) =>
    route.fulfill({
      status: 200,
      json: { backend: "console", delivering: false, from_address: "x", smtp_host: null },
    }),
  );
  await page.route("**/api/admin/emails", (route) => route.fulfill({ status: 200, json: [] }));
  await page.route("**/api/admin/invites", (route) => route.fulfill({ status: 200, json: [] }));

  await page.goto("/admin");
  await page.getByRole("button", { name: "Set host limit for guest@example.com" }).click();
  const dialog = page.getByTestId("comp-dialog");
  // The stored 0 is never shown as a number an operator could read as "none".
  await expect(dialog.getByText("Unlimited hosts")).toBeVisible();
  await expect(dialog.getByText("means no ceiling — not zero")).toBeVisible();
  await dialog.getByRole("radio", { name: /Unlimited hosts/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => patches).toEqual([{ host_limit_override: 0 }]);
});

test("a self-hosted deployment shows no billing anywhere", async ({ page }) => {
  // `mockApp` without a `billing` block is a self-hosted server: the config
  // advertises nothing, `/api/me` carries no plan, and `/api/billing/*` 404s.
  const store = await mockApp(page, {
    hosts: [host, extraHost(1, "Studio"), extraHost(2, "Linux box")],
  });
  await page.goto("/legion");

  await expect(page.getByTestId("over-limit-reconciliation")).toHaveCount(0);
  await expect(page.getByTestId("legion-at-capacity")).toHaveCount(0);
  await expect(page.getByText("hosts on plan")).toHaveCount(0);

  await page.getByRole("button", { name: "Add a machine", exact: true }).first().click();
  await expect(page.getByTestId("legion-capacity-notice")).toHaveCount(0);
  // Nothing asked the billing API anything.
  expect(store.requests.billing).toHaveLength(0);
});
