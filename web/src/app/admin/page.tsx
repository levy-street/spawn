"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type FormEvent, Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AdminEmail, type AdminInvite, type AdminUser, ApiError, admin } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth";
import { hostLimitOverrideLabel } from "@/lib/billing";

const STATE_STYLE: Record<AdminInvite["state"], string> = {
  pending: "border-success/50 text-success",
  used: "border-border text-muted-foreground",
  expired: "border-border text-muted-foreground",
  revoked: "border-border text-muted-foreground",
};

function when(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString();
}

export default function AdminPage() {
  return (
    <div className="space-y-10">
      <Invites />
      <Users />
      <Emails />
    </div>
  );
}

const EMAIL_STATUS_STYLE: Record<AdminEmail["status"], string> = {
  sent: "border-success/50 text-success",
  failed: "border-destructive/60 text-destructive",
  not_delivered: "border-warning/50 text-warning",
};

function Emails() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["admin", "mail"], queryFn: admin.mailStatus });
  const emails = useQuery({ queryKey: ["admin", "emails"], queryFn: admin.emails });
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => admin.sendTestEmail(null),
    onSuccess: (row) => {
      setNote(
        row.status === "sent"
          ? `Sent to ${row.to_email}.`
          : `Not delivered: ${row.error ?? "unknown reason"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["admin", "emails"] });
    },
    onError: (cause) =>
      setNote(cause instanceof ApiError ? cause.message : "Could not send a test email"),
  });

  const delivering = status.data?.delivering ?? false;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Email</h2>
        <p className="text-sm text-muted-foreground">
          Every message this deployment tried to send. Reset and invite links are stored with their
          codes stripped, so this log cannot be used to take over an account.
        </p>
      </div>

      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${
          delivering ? "border-border" : "border-warning/50"
        }`}
        data-testid="mail-status"
      >
        <div className="min-w-0 text-sm">
          {status.isLoading ? (
            <span className="text-muted-foreground">Checking mail configuration…</span>
          ) : delivering ? (
            <>
              <span className="font-medium">Delivering</span>
              <span className="text-muted-foreground">
                {" "}
                via {status.data?.smtp_host} as {status.data?.from_address}
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">Not delivering</span>
              <span className="text-muted-foreground">
                {" "}
                — backend is <code className="font-mono">{status.data?.backend}</code>. Password
                resets and invitations are recorded but never sent. Set SPAWN_SMTP_HOST to turn
                delivery on.
              </span>
            </>
          )}
          {note !== null && (
            <p className="mt-1" role="status">
              {note}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "Sending…" : "Send test email"}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">To</th>
              <th className="px-3 py-2 font-medium">Subject</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border" data-testid="admin-emails">
            {emails.isLoading && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {!emails.isLoading && (emails.data ?? []).length === 0 && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  No email sent yet.
                </td>
              </tr>
            )}
            {(emails.data ?? []).map((email) => (
              <Fragment key={email.id}>
                <tr
                  className="cursor-pointer hover:bg-accent/40"
                  onClick={() => setOpen(open === email.id ? null : email.id)}
                >
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {when(email.created_at)}
                  </td>
                  <td className="px-3 py-2">{email.to_email}</td>
                  <td className="px-3 py-2">{email.subject}</td>
                  <td className="px-3 py-2 text-muted-foreground">{email.kind}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${EMAIL_STATUS_STYLE[email.status]}`}
                    >
                      {email.status.replace("_", " ")}
                    </span>
                  </td>
                </tr>
                {open === email.id && (
                  <tr>
                    <td className="px-3 pb-3 text-xs" colSpan={5}>
                      {email.error && <p className="mb-2 text-destructive">{email.error}</p>}
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
                        {email.body_redacted || "(body not recorded)"}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The comp control (docs/BILLING.md §4.8): how internal accounts, friends of
 * the house and support cases never pay.
 *
 * Every label here spells the value out, because the stored one is a trap:
 * **0 means unlimited**, not zero hosts, and an operator who reads it as
 * "none" would believe they had cut an account off at the moment they gave it
 * everything. The number appears on this screen exactly once, inside the field
 * that sets a specific count.
 */
function CompDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"none" | "unlimited" | "exact">(
    user.host_limit_override === null
      ? "none"
      : user.host_limit_override === 0
        ? "unlimited"
        : "exact",
  );
  const [count, setCount] = useState(
    user.host_limit_override && user.host_limit_override > 0
      ? String(user.host_limit_override)
      : "5",
  );
  const [error, setError] = useState<string | null>(null);

  const parsed = Number.parseInt(count, 10);
  const exactValid = Number.isFinite(parsed) && parsed > 0;
  const value = mode === "none" ? null : mode === "unlimited" ? 0 : parsed;

  const save = useMutation({
    mutationFn: () => admin.setHostLimitOverride(user.id, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Could not save the override"),
  });

  const choice = (
    key: "none" | "unlimited" | "exact",
    title: string,
    detail: string,
    extra?: ReactNode,
  ) => (
    <label
      className={`flex gap-3 rounded-md border p-3 ${
        mode === key ? "border-foreground/40 bg-accent/40" : "border-border"
      }`}
    >
      <input
        type="radio"
        name="comp-mode"
        className="mt-0.5"
        checked={mode === key}
        onChange={() => setMode(key)}
        disabled={save.isPending}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
        {extra}
      </span>
    </label>
  );

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="md" data-testid="comp-dialog">
        <DialogHeader>
          <DialogTitle>Host limit for {user.email}</DialogTitle>
          <DialogDescription>
            This account is sold <span className="font-medium">{user.billing_tier}</span> and is
            enforced right now at{" "}
            <span className="font-medium tabular-nums">
              {user.effective_host_limit === null ? "unlimited" : user.effective_host_limit}
            </span>
            . An override outranks the subscription entirely and needs no Stripe call, so it works
            on a lapsed card and never has to be cancelled in a dashboard.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 overflow-y-auto px-4">
          {choice(
            "none",
            "No override",
            "The subscription decides. This is the ordinary state for a paying account.",
          )}
          {choice(
            "unlimited",
            "Unlimited hosts",
            "Stored as 0, which means no ceiling — not zero. This is a full comp.",
          )}
          {choice(
            "exact",
            "A specific number of hosts",
            "Enforced whatever the account is paying for.",
            <span className="mt-2 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={10_000}
                className="w-28"
                value={count}
                aria-label="Hosts allowed"
                onFocus={() => setMode("exact")}
                onChange={(event) => setCount(event.target.value)}
                disabled={save.isPending}
              />
              <span className="text-xs text-muted-foreground">hosts</span>
            </span>,
          )}
          {error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || (mode === "exact" && !exactValid)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Users() {
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: admin.users });
  // The deployment's billing, not this admin's own plan: an operator on a
  // self-hosted install has no comps to grant, because nothing is metered.
  const { config } = useAuthConfig();
  const billingEnabled = config?.billing.enabled ?? false;
  const [comping, setComping] = useState<string | null>(null);
  const columns = billingEnabled ? 8 : 6;
  const compTarget = (users.data ?? []).find((row) => row.id === comping) ?? null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Users</h2>
        <p className="text-sm text-muted-foreground">
          Every account on this deployment. {users.data ? `${users.data.length} total.` : ""}
        </p>
      </div>
      {users.isError && (
        <p className="text-sm text-destructive" role="alert">
          Could not load users.
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium">Verified</th>
              <th className="px-3 py-2 text-right font-medium">Hosts</th>
              <th className="px-3 py-2 text-right font-medium">Sessions</th>
              <th className="px-3 py-2 text-right font-medium">Devices</th>
              {billingEnabled && <th className="px-3 py-2 font-medium">Plan</th>}
              {billingEnabled && <th className="px-3 py-2 font-medium">Host limit</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border" data-testid="admin-users">
            {users.isLoading && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={columns}>
                  Loading…
                </td>
              </tr>
            )}
            {(users.data ?? []).map((user) => (
              <tr key={user.id}>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{user.email}</span>
                    {user.is_admin && (
                      <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        admin
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">{user.id}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{when(user.created_at)}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {user.email_verified_at ? (
                    when(user.email_verified_at)
                  ) : (
                    <span className="text-warning">unverified</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{user.host_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{user.session_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{user.browser_device_count}</td>
                {billingEnabled && (
                  <td className="px-3 py-2 text-muted-foreground">{user.billing_tier}</td>
                )}
                {billingEnabled && (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">
                        {user.effective_host_limit === null
                          ? "unlimited"
                          : user.effective_host_limit}
                      </span>
                      {user.host_limit_override !== null && (
                        <span className="rounded border border-success/50 px-1.5 py-0.5 text-[11px] text-success">
                          comped: {hostLimitOverrideLabel(user.host_limit_override)}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setComping(user.id)}
                        aria-label={`Set host limit for ${user.email}`}
                      >
                        Comp
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {compTarget !== null && <CompDialog user={compTarget} onClose={() => setComping(null)} />}
    </section>
  );
}

function Invites() {
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ["admin", "invites"], queryFn: admin.invites });
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState("72");
  const [error, setError] = useState<string | null>(null);
  // The plaintext code exists only in the response that minted it, so the
  // link is held here until the admin dismisses it — a reload cannot get it
  // back.
  const [fresh, setFresh] = useState<AdminInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      admin.createInvite({
        email: email.trim() === "" ? null : email.trim(),
        ttl_hours: Number.parseInt(hours, 10) || null,
      }),
    onSuccess: (invite) => {
      setFresh(invite);
      setCopied(false);
      setEmail("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "invites"] });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Could not create an invite"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => admin.revokeInvite(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "invites"] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    create.mutate();
  };

  const copy = async () => {
    if (!fresh?.url) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Invites</h2>
        <p className="text-sm text-muted-foreground">
          Signup is closed: an invite admits exactly one account, once, before it expires.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
        <div className="space-y-1">
          <Label htmlFor="invite-email">Email (optional)</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="send it for me"
            className="w-64"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={create.isPending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invite-hours">Expires in (hours)</Label>
          <Input
            id="invite-hours"
            type="number"
            min={1}
            max={720}
            className="w-32"
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            disabled={create.isPending}
          />
        </div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create invite"}
        </Button>
      </form>

      {error !== null && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {fresh?.url && (
        <div
          className="space-y-2 rounded-md border border-success/50 p-3"
          data-testid="fresh-invite"
        >
          <p className="text-sm font-medium">
            Invite ready{fresh.email ? ` — emailed to ${fresh.email}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
              {fresh.url}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Dismiss
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Copy it now — the code is stored hashed, so this link cannot be shown again. Expires{" "}
            {when(fresh.expires_at)}.
          </p>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">For</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Expires</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border" data-testid="admin-invites">
            {invites.isLoading && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {!invites.isLoading && (invites.data ?? []).length === 0 && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  No invites yet.
                </td>
              </tr>
            )}
            {(invites.data ?? []).map((invite) => (
              <tr key={invite.id}>
                <td className="px-3 py-2">{invite.email ?? "anyone with the link"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${STATE_STYLE[invite.state]}`}
                  >
                    {invite.state}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{when(invite.created_at)}</td>
                <td className="px-3 py-2 text-muted-foreground">{when(invite.expires_at)}</td>
                <td className="px-3 py-2 text-right">
                  {invite.state === "pending" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(invite.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
