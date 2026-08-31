"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { OAuthButtons } from "@/components/onboarding/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth";
import { safeNext, withNext } from "@/lib/safe-next";

function LoginPageContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { config, loading: configLoading, error: configError } = useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Read during render rather than in an effect: computed after paint, the
  // signup link spends its first frames as a bare "/signup", and a fast click
  // in that window drops the approval this visit came from.
  const next = useSearchParams().get("next");
  const returnTo = safeNext(next);
  // Carried on to signup, so someone who arrives from a host approval link and
  // then creates an account still lands back on that approval.
  const signupHref = withNext("/signup", next);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await auth.login({ email, password });
      queryClient.setQueryData(["me"], { user: result.user });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      router.replace(returnTo);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to reach the shells running across your machines."
    >
      <div className="space-y-5">
        <OAuthButtons
          providers={config?.providers ?? []}
          returnTo={returnTo}
          loading={configLoading}
        />
        {configError ? (
          <p className="text-sm text-muted-foreground" role="status">
            Social sign-in is temporarily unavailable. Email sign-in still works.
          </p>
        ) : null}
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
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
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="login-password">Password</Label>
              <Link
                href="/forgot-password"
                className="-my-2 inline-flex items-center py-2 font-sigil text-[10px] uppercase tracking-[0.16em] text-ash underline decoration-line-strong underline-offset-4 transition-colors hover:text-ember hover:decoration-ember"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="login-password"
              className="h-11"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="h-11 w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="text-center text-sm text-ash">
          No account?{" "}
          <Link
            href={signupHref}
            className="inline-flex min-h-11 items-center font-medium text-ember underline decoration-ember/50 underline-offset-4 transition-colors hover:text-hellfire hover:decoration-ember"
          >
            Create one
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}

export default function LoginPage() {
  // useSearchParams needs a boundary to suspend against during prerender.
  return (
    <Suspense
      fallback={
        <AuthShell
          title="Welcome back"
          description="Sign in to reach the shells running across your machines."
        >
          <div className="min-h-64" />
        </AuthShell>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
