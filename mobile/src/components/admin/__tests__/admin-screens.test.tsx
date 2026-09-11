import { fireEvent, render } from "@testing-library/react-native";

import { AdminEmailRecord } from "@/components/admin/admin-email-screen";
import { inviteBadgeVariant, parseAdminInviteInput } from "@/components/admin/admin-invites-screen";
import { AdminUsersContent } from "@/components/admin/admin-users-screen";
import { WaitlistCard, waitlistBadge } from "@/components/admin/admin-waitlist-screen";
import type { AdminEmailOut, AdminUserOut, AdminWaitlistEntryOut } from "@/data/api/schemas/admin";
import { ThemeProvider } from "@/theme";

const USER: AdminUserOut = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  created_at: "2026-08-20T00:00:00Z",
  email_verified_at: "2026-08-21T00:00:00Z",
  is_admin: true,
  host_count: 2,
  session_count: 7,
  browser_device_count: 3,
};

const EMAIL: AdminEmailOut = {
  id: "22222222-2222-4222-8222-222222222222",
  to_email: "person@example.com",
  subject: "Your spawn invite",
  kind: "invite",
  status: "not_delivered",
  error: "SMTP is not configured",
  body_redacted: "Invite credentials removed.",
  created_at: "2026-08-22T00:00:00Z",
};

const WAITING: AdminWaitlistEntryOut = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "waiting@example.com",
  source: "/claude-code-remote",
  created_at: "2026-09-10T00:00:00Z",
  invited_at: null,
  invite_id: null,
  invite_state: null,
  has_account: false,
};

describe("admin section behavior", () => {
  test("names where a waitlist entry stands, with an account outranking its invite", () => {
    expect(waitlistBadge(WAITING).label).toBe("waiting");
    expect(waitlistBadge({ ...WAITING, invite_state: "pending" }).label).toBe("invited");
    expect(waitlistBadge({ ...WAITING, invite_state: "used" }).label).toBe("used");
    expect(waitlistBadge({ ...WAITING, invite_state: "expired" }).label).toBe("expired");
    expect(waitlistBadge({ ...WAITING, invite_state: "revoked" }).label).toBe("revoked");
    expect(waitlistBadge({ ...WAITING, invite_state: "expired", has_account: true }).label).toBe(
      "has account",
    );
  });

  test("a waitlist card shows the entry and offers invite and remove", async () => {
    const onInvite = jest.fn();
    const onRemove = jest.fn();
    const screen = await render(
      <ThemeProvider>
        <WaitlistCard
          entry={WAITING}
          inviting={false}
          onInvite={onInvite}
          onRemove={onRemove}
          removing={false}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("waiting@example.com")).toBeOnTheScreen();
    expect(screen.getByText("waiting")).toBeOnTheScreen();
    expect(screen.getByText(/from \/claude-code-remote/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Invite" }));
    await fireEvent.press(screen.getByRole("button", { name: "Remove" }));
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test("an entry that already has an account cannot be invited", async () => {
    const screen = await render(
      <ThemeProvider>
        <WaitlistCard
          entry={{ ...WAITING, has_account: true }}
          inviting={false}
          onInvite={jest.fn()}
          onRemove={jest.fn()}
          removing={false}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("has account")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Invite" }).props["accessibilityState"],
    ).toMatchObject({ disabled: true });
  });

  test("validates optional-email invites and the complete expiry range", () => {
    expect(parseAdminInviteInput("", "72")).toEqual({
      ok: true,
      value: { email: null, ttl_hours: 72 },
    });
    expect(parseAdminInviteInput("not-an-email", "72")).toEqual({
      ok: false,
      field: "email",
      message: "Enter a valid email address.",
    });
    expect(parseAdminInviteInput("person@example.com", "721")).toEqual({
      ok: false,
      field: "ttl",
      message: "Expiry must be a whole number from 1 to 720.",
    });
    expect(inviteBadgeVariant("pending")).toBe("info");
  });

  test("retains every read-only admin user field", async () => {
    const screen = await render(
      <ThemeProvider>
        <AdminUsersContent users={[USER]} />
      </ThemeProvider>,
    );

    expect(screen.getByText("admin@example.com")).toBeOnTheScreen();
    expect(screen.getByText(USER.id)).toBeOnTheScreen();
    expect(screen.getByText("admin")).toBeOnTheScreen();
    for (const value of ["2", "7", "3", "Hosts", "Sessions", "Devices"]) {
      expect(screen.getByText(value)).toBeOnTheScreen();
    }
  });

  test("email disclosure exposes redacted body and transport failure", async () => {
    const onToggle = jest.fn();
    const screen = await render(
      <ThemeProvider>
        <AdminEmailRecord email={EMAIL} expanded onToggle={onToggle} />
      </ThemeProvider>,
    );

    expect(screen.getByText("not delivered")).toBeOnTheScreen();
    expect(screen.getByText("SMTP is not configured")).toBeOnTheScreen();
    expect(screen.getByText("Invite credentials removed.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Collapse email Your spawn invite" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
