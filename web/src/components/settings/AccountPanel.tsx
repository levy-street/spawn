"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, account, auth } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";

export function AccountPanel() {
  const { user } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [resendNote, setResendNote] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => auth.requestEmailVerification(),
    onSuccess: () => setResendNote("Sent — check your inbox."),
    onError: (cause) =>
      setResendNote(cause instanceof ApiError ? cause.message : "Could not send right now."),
  });

  const remove = useMutation({
    mutationFn: () =>
      account.remove({
        confirm_email: confirmEmail,
        ...(password !== "" ? { password } : {}),
      }),
    onSuccess: () => {
      // The server already deleted the session cookie with the account; this
      // clears local auth state and lands on the login page.
      void logout();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : String(cause)),
  });

  const emailMatches =
    user !== null && confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="text-sm text-muted-foreground">Signed in as {user?.email ?? "—"}</p>
      </div>

      {user !== null && user.email_verified_at === null && (
        <div
          className="space-y-2 rounded-md border border-warning/50 p-3"
          data-testid="verify-email-callout"
        >
          <p className="text-sm font-medium">Confirm your email address</p>
          <p className="text-sm text-muted-foreground">
            We sent a link to {user.email}. Verifying keeps account recovery working — a password
            reset can only reach an address you control.
          </p>
          {resendNote !== null && (
            <p className="text-sm" role="status">
              {resendNote}
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            {resend.isPending ? "Sending…" : "Resend verification email"}
          </Button>
        </div>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          void logout();
        }}
      >
        Log out
      </Button>

      <div className="space-y-3 rounded-md border border-destructive/50 p-3">
        <div>
          <p className="text-sm font-medium">Delete account</p>
          <p className="text-sm text-muted-foreground">
            Permanently deletes this account: every host pairing, session, workspace, agent, skill,
            device identity, and saved trust. Daemons on your machines keep running but lose this
            server. This cannot be undone.
          </p>
        </div>
        {!confirming ? (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Delete account…
          </Button>
        ) : (
          <form
            className="space-y-3"
            data-testid="delete-account-form"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              remove.mutate();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="delete-confirm-email">Type your email to confirm</Label>
              <Input
                id="delete-confirm-email"
                autoFocus
                autoComplete="off"
                placeholder={user?.email ?? ""}
                value={confirmEmail}
                onChange={(event) => setConfirmEmail(event.target.value)}
                disabled={remove.isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="delete-confirm-password">Password</Label>
              <Input
                id="delete-confirm-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={remove.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Signed up through a provider without a password? Leave this empty.
              </p>
            </div>
            {error !== null && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="destructive"
                disabled={!emailMatches || remove.isPending}
              >
                {remove.isPending ? "Deleting…" : "Permanently delete"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={remove.isPending}
                onClick={() => {
                  setConfirming(false);
                  setConfirmEmail("");
                  setPassword("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
