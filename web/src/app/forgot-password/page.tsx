"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await auth.requestPasswordReset(email);
    } catch {
      // Deliberately ignored. Every address receives the exact same UI state,
      // preserving the endpoint's protection against account enumeration.
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      description={
        sent ? "Check the inbox associated with that address." : "We’ll send a one-time reset link."
      }
    >
      {sent ? (
        <div className="space-y-5">
          <p className="text-sm leading-6" role="status">
            If an account exists for <span className="break-all font-medium">{email}</span>, a reset
            link is on its way. It works once and expires in an hour.
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            Your password stays unchanged until you use the link.
          </p>
          <Button asChild variant="secondary" className="h-11 w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="recovery-email">Email</Label>
            <Input
              id="recovery-email"
              className="h-11"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
            />
          </div>
          <Button type="submit" className="h-11 w-full" disabled={submitting || email === ""}>
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            <Link
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href="/login"
            >
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
