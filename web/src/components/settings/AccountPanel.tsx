"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirm as confirmAction } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { ApiError, account, auth, type PasskeyCredential } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { UnreadableTrustStateError } from "@/lib/passkey-flows";
import { usePasskeyTrust } from "@/lib/trust-passkeys";

/**
 * Passkeys live in account settings, next to email and password — sign-in
 * furniture, not trust machinery (docs/TRUST_UX.md). The one taught promise:
 * if you lose every device, a passkey brings everything back.
 */
function PasskeysSection() {
  const passkey = usePasskeyTrust();
  const rows = passkey.passkeys.data;
  const count = rows?.length ?? null;

  // A GHOST is a listed credential holding no wrap in the current saved
  // protection (a partial enrollment's leftover): it opens nothing, so it can
  // always be removed as cleanup — and it must not count toward the
  // two-passkey reseal rule. Unknown wraps (no bundle / unreadable) treat
  // every row conservatively as real.
  const wrapIds = passkey.wrapCredentialIds;
  const isGhost = (row: PasskeyCredential) =>
    passkey.hasBundle && wrapIds !== null && !wrapIds.includes(row.credential_id);
  const realCount = rows === undefined ? null : rows.filter((row) => !isGhost(row)).length;

  const removeRow = async (row: PasskeyCredential) => {
    if (count === 1) {
      if (
        !confirm(
          "Remove your only passkey?\n\nYour devices keep working, but the " +
            "protection it provides ends: if you ever lose every device, nothing " +
            "will bring this account's hosts back.",
        )
      ) {
        return;
      }
      try {
        await passkey.removeLastPasskey.mutateAsync({ target: row });
      } catch (cause) {
        // The one state that re-asks (P-C6): the saved protection exists but
        // can't be read here, so removing the passkey abandons it while the
        // trust it granted lives on. Named exactly, decided explicitly.
        if (
          cause instanceof UnreadableTrustStateError &&
          confirm(
            "Your saved protection can't be read from here.\n\nRemoving this passkey " +
              "abandons it: your devices and hosts keep trusting the old setup, and if " +
              "you lose every device, nothing brings this account's hosts back.\n\n" +
              "Remove it anyway?",
          )
        ) {
          passkey.removeLastPasskey.mutate({ target: row, acknowledgeUnreadable: true });
        }
      }
      return;
    }
    if (isGhost(row)) {
      if (
        confirm(
          "Remove this passkey?\n\nIt can't open your saved protection, so it isn't " +
            "protecting anything. Removing it changes nothing else.",
        )
      ) {
        passkey.revokePasskey.mutate(row);
      }
      return;
    }
    passkey.revokePasskey.mutate(row);
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="passkey-list">
      <div>
        <p className="text-sm font-medium">Passkeys</p>
        <p className="text-sm text-muted-foreground">
          A passkey signs in and approves a device in one step — and if you lose every device, it
          brings everything back.
        </p>
      </div>
      {!passkey.supported && (
        <p className="text-sm text-muted-foreground">
          This browser cannot use passkeys here. Passkeys need a secure context (HTTPS).
        </p>
      )}
      {count !== null && count > 0 && (
        <ul className="flex flex-col gap-2">
          {rows?.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {row.label ?? "passkey"}
                <span className="ml-2 text-xs text-muted-foreground">
                  added {new Date(row.created_at).toLocaleDateString()}
                </span>
                {isGhost(row) && (
                  <span className="ml-2 text-xs text-muted-foreground" data-testid="ghost-passkey">
                    not protecting anything
                  </span>
                )}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                // A ghost is always removable (it opens nothing); a real one
                // needs the honest reseal rules: it is the last passkey, or
                // exactly one other REAL passkey survives to reseal for.
                disabled={
                  passkey.busy ||
                  (!isGhost(row) && count !== 1 && (realCount === null || realCount !== 2))
                }
                data-testid="revoke-passkey"
                onClick={() => void removeRow(row)}
              >
                {passkey.revokePasskey.isPending || passkey.removeLastPasskey.isPending
                  ? "Removing…"
                  : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {realCount !== null && realCount > 2 && (
        <p className="text-xs text-muted-foreground">
          Removing needs at most two passkeys enrolled. With more, this device cannot reseal for
          every survivor — remove from each surviving device instead.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!passkey.supported || passkey.busy}
          data-testid={passkey.hasBundle ? "add-backup-passkey" : "setup-passkey"}
          onClick={() => (passkey.hasBundle ? passkey.addBackup.mutate() : passkey.setUp.mutate())}
        >
          {passkey.setUp.isPending || passkey.addBackup.isPending ? "Adding…" : "Add passkey"}
        </Button>
        {count === 1 && (
          <p className="text-xs text-muted-foreground">
            A second passkey (another phone, a security key) survives losing this one.
          </p>
        )}
      </div>
      {passkey.status !== null && (
        <p className="text-sm font-medium" role="status" data-testid="trust-status">
          {passkey.status}
        </p>
      )}
      {passkey.error !== null && (
        <p className="text-sm text-destructive" role="alert" data-testid="trust-error">
          {passkey.error}
        </p>
      )}
    </div>
  );
}

export function AccountPanel() {
  const { user } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [resendNote, setResendNote] = useState<string | null>(null);
  const [signOutEverywhereAvailable, setSignOutEverywhereAvailable] = useState(true);
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
      // clears local auth state and hands back to the lander.
      void logout();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : String(cause)),
  });

  const signOutEverywhere = useMutation({
    mutationFn: () => auth.signOutEverywhere(),
    onSuccess: () => {
      // The server has already installed this session's replacement cookie.
      // The account row is unchanged, so no query invalidation is needed.
      toast("Signed out everywhere else.");
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.status === 404) {
        setSignOutEverywhereAvailable(false);
        return;
      }
      toast.error(cause instanceof ApiError ? cause.message : "Could not sign out everywhere.");
    },
  });

  const requestSignOutEverywhere = async () => {
    const accepted = await confirmAction({
      title: "Sign out everywhere?",
      body: "Every other browser and phone signed in to this account will be signed out. This one stays signed in.",
      confirmLabel: "Sign out everywhere",
      cancelLabel: "Cancel",
    });
    if (accepted) signOutEverywhere.mutate();
  };

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
      <PasskeysSection />

      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-medium">Sessions</p>
          <p className="text-sm text-muted-foreground">
            Sign out here, or end every other browser and phone session while keeping this one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void logout();
            }}
          >
            Log out
          </Button>
          <Button
            variant="secondary"
            disabled={!signOutEverywhereAvailable || signOutEverywhere.isPending}
            onClick={() => void requestSignOutEverywhere()}
          >
            {signOutEverywhereAvailable
              ? signOutEverywhere.isPending
                ? "Signing out…"
                : "Sign out everywhere"
              : "Not available on this server yet."}
          </Button>
        </div>
      </div>

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
