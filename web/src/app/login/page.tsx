"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { SocialLoginButtons } from "@/components/auth/SocialLoginButtons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth } from "@/lib/api";

/**
 * Where to land after login: the `?next=` AuthGate set, but only when it is a
 * same-origin absolute path. Rejects protocol-relative (`//host`) and absolute
 * URLs so `next` can't become an open redirect.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await auth.login({ email, password });
      queryClient.setQueryData(["me"], { user: result.user });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Login failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-vv items-center justify-center px-4 pad-safe-top pad-safe-bottom">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to spawn</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <SocialLoginButtons />
            <form className="space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Signing in..." : "Sign in"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                No account?{" "}
                <Link href="/signup" className="text-foreground underline">
                  Create one
                </Link>
                {" · "}
                <Link href="/forgot-password" className="text-foreground underline">
                  Forgot password?
                </Link>
              </p>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
