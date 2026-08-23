"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, auth } from "@/lib/api";

const MIN_PASSWORD_LENGTH = 12;

function ResetPasswordForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH || password !== confirm) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await auth.confirmPasswordReset({ token, new_password: password });
      queryClient.setQueryData(["me"], { user: result.user });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      router.replace("/app");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not reset your password");
    } finally {
      setSubmitting(false);
    }
  };

  if (token === "") {
    return (
      <div className="space-y-4">
        <p className="text-sm" role="alert">
          This link is missing its token. Request a new one.
        </p>
        <Button asChild className="h-11 w-full">
          <Link href="/forgot-password">Request a reset link</Link>
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          className="h-11"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          className="h-11"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          disabled={submitting}
        />
      </div>
      {tooShort || mismatch || error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {error ??
            (tooShort
              ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
              : "Both passwords must match.")}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        Every device currently signed in to this account will be signed out.
      </p>
      <Button
        type="submit"
        className="h-11 w-full"
        disabled={submitting || password.length < MIN_PASSWORD_LENGTH || password !== confirm}
      >
        {submitting ? "Resetting…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Choose a new password"
      description="Use a unique password with at least 12 characters."
    >
      <Suspense fallback={<Spinner size={20} label="Loading password reset" />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
