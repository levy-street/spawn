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
import { commitAuthenticatedUser } from "@/lib/auth";

export default function SignupPage() {
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
      const result = await auth.signup({ email, password });
      commitAuthenticatedUser(queryClient, result.user);
      router.replace("/");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Signup failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-vv items-center justify-center px-4 pad-safe-top pad-safe-bottom">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your spawn account</CardTitle>
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
                  autoComplete="new-password"
                  required
                  minLength={8}
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
                {submitting ? "Creating..." : "Create account"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Already have an account?{" "}
                <Link href="/login" className="text-foreground underline">
                  Sign in
                </Link>
              </p>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
