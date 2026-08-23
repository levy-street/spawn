"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { OAuthButtons } from "@/components/onboarding/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth";

/**
 * Where to land after login: the `?next=` AuthGate set, but only when it is a
 * same-origin absolute path. Rejects protocol-relative (`//host`) and absolute
 * URLs so `next` can't become an open redirect.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/app";
  return raw;
}

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { config, loading: configLoading, error: configError } = useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await auth.login({ email, password });
      queryClient.setQueryData(["me"], { user: result.user });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
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
        <OAuthButtons providers={config?.providers ?? []} returnTo="/app" loading={configLoading} />
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
            href="/signup"
            className="inline-flex min-h-11 items-center font-medium text-ember underline decoration-ember/50 underline-offset-4 transition-colors hover:text-hellfire hover:decoration-ember"
          >
            Create one
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
