"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AdminInvite, ApiError, admin } from "@/lib/api";

const STATE_STYLE: Record<AdminInvite["state"], string> = {
  pending: "border-emerald-600/50 text-emerald-600 dark:text-emerald-400",
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
    </div>
  );
}

function Users() {
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: admin.users });

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
              <th className="px-3 py-2 text-right font-medium">Agents</th>
              <th className="px-3 py-2 text-right font-medium">Devices</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border" data-testid="admin-users">
            {users.isLoading && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={6}>
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
                    <span className="text-amber-600 dark:text-amber-400">unverified</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{user.host_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{user.agent_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{user.browser_device_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          className="space-y-2 rounded-md border border-emerald-600/50 p-3"
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
