import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, user } from "./app-mocks";

// The admin dashboard: visible to admins, an empty shell to everyone else,
// and the invite link shown exactly once at creation.

const INVITE_URL = "https://spawn.example/signup?invite=test-invite-code-123";

async function mockAdminApi(page: import("@playwright/test").Page, options: { isAdmin: boolean }) {
  await mockAuthenticatedApi(page, { me: { ...user, is_admin: options.isAdmin } });
  const invites: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/users", async (route) => {
    if (!options.isAdmin) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          email: "owner@example.com",
          created_at: "2026-05-24T00:00:00Z",
          email_verified_at: "2026-05-24T00:00:00Z",
          is_admin: true,
          host_count: 2,
          agent_count: 7,
          browser_device_count: 3,
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          email: "guest@example.com",
          created_at: "2026-06-01T00:00:00Z",
          email_verified_at: null,
          is_admin: false,
          host_count: 0,
          agent_count: 0,
          browser_device_count: 1,
        },
      ],
    });
  });
  await page.route("**/api/admin/mail", async (route) => {
    if (!options.isAdmin) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        backend: "console",
        delivering: false,
        from_address: "spawn <no-reply@example.com>",
        smtp_host: null,
      },
    });
  });
  await page.route("**/api/admin/emails", async (route) => {
    if (!options.isAdmin) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: [
        {
          id: "00000000-0000-4000-8000-0000000000e1",
          to_email: "friend@example.com",
          subject: "You're invited to spawn",
          kind: "invite",
          status: "not_delivered",
          error: "email backend is 'console' (logged, not sent)",
          body_redacted:
            "You have been invited to create an account on spawn.\n\nhttps://spawn.example/signup?invite=<redacted>\n",
          created_at: "2026-08-06T12:00:00Z",
        },
      ],
    });
  });
  await page.route("**/api/admin/invites", async (route) => {
    if (!options.isAdmin) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    if (route.request().method() === "POST") {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      const created = {
        id: "00000000-0000-4000-8000-000000000090",
        email: body.email ?? null,
        state: "pending",
        expires_at: "2026-08-09T00:00:00Z",
        created_at: "2026-08-06T00:00:00Z",
        used_at: null,
        created_by_user_id: null,
        used_by_user_id: null,
        url: INVITE_URL,
      };
      // Listing never returns the url again — the code is stored hashed.
      invites.unshift({ ...created, url: null });
      await route.fulfill({ status: 200, json: created });
      return;
    }
    await route.fulfill({ status: 200, json: invites });
  });
}

test("an admin sees every account and can mint a shareable invite", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockAdminApi(page, { isAdmin: true });
  await page.goto("/admin");

  // Users table carries the account details.
  const users = page.getByTestId("admin-users");
  await expect(users).toContainText("owner@example.com");
  await expect(users).toContainText("guest@example.com");
  await expect(users.getByText("unverified")).toBeVisible();
  await expect(users.getByText("admin", { exact: true })).toBeVisible();

  await expect(page.getByTestId("admin-invites")).toContainText("No invites yet");

  await page.getByRole("button", { name: "Create invite" }).click();

  const fresh = page.getByTestId("fresh-invite");
  await expect(fresh).toBeVisible();
  await expect(fresh).toContainText(INVITE_URL);
  await expect(fresh).toContainText("cannot be shown again");

  await fresh.getByRole("button", { name: "Copy link" }).click();
  await expect(fresh.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(INVITE_URL);

  // The new invite appears in the list, without its URL.
  await expect(page.getByTestId("admin-invites")).toContainText("pending");
  await expect(page.getByTestId("admin-invites")).not.toContainText(INVITE_URL);
});

test("a non-admin gets nothing", async ({ page }) => {
  await mockAdminApi(page, { isAdmin: false });
  await page.goto("/admin");

  await expect(page.getByText("does not administer this deployment")).toBeVisible();
  await expect(page.getByTestId("admin-users")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create invite" })).toHaveCount(0);
});

test("an invite link carries its code into signup", async ({ page }) => {
  const submitted: Array<Record<string, unknown>> = [];
  await page.route("**/api/auth/signup", async (route) => {
    submitted.push((await route.request().postDataJSON()) as Record<string, unknown>);
    await route.fulfill({ status: 403, json: { detail: "this invite is not valid" } });
  });
  await page.route("**/api/auth/providers", async (route) => {
    await route.fulfill({ status: 200, json: { providers: [] } });
  });

  await page.goto("/signup?invite=abc123xyz");
  await expect(page.getByRole("status")).toContainText("You have an invite");

  await page.getByLabel("Email").fill("guest@example.com");
  await page.locator("#password").fill("correct-horse-battery");
  await page.getByRole("button", { name: /Create account|Sign up/i }).click();

  await expect.poll(() => submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ email: "guest@example.com", invite: "abc123xyz" });
  // The server's refusal is surfaced rather than swallowed.
  await expect(page.getByText("this invite is not valid")).toBeVisible();
});


test("the email log shows delivery state without exposing credentials", async ({ page }) => {
  await mockAdminApi(page, { isAdmin: true });
  await page.goto("/admin");

  // A deployment that only logs must say so rather than looking healthy.
  const status = page.getByTestId("mail-status");
  await expect(status).toContainText("Not delivering");
  await expect(status).toContainText("console");

  const log = page.getByTestId("admin-emails");
  await expect(log).toContainText("friend@example.com");
  await expect(log).toContainText("not delivered");

  // Expanding a row shows the body with the invite code stripped out.
  await log.getByText("You're invited to spawn").click();
  await expect(page.getByText("invite=<redacted>")).toBeVisible();
});
