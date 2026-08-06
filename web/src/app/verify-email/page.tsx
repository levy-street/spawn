"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, auth } from "@/lib/api";

type State = { status: "working" } | { status: "done" } | { status: "failed"; message: string };

function VerifyEmail() {
  const queryClient = useQueryClient();
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<State>({ status: "working" });

  useEffect(() => {
    if (token === "") {
      setState({ status: "failed", message: "This link is missing its token." });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await auth.confirmEmailVerification(token);
        if (cancelled) return;
        queryClient.setQueryData(["me"], { user: result.user });
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        setState({ status: "done" });
      } catch (cause) {
        if (cancelled) return;
        setState({
          status: "failed",
          message: cause instanceof ApiError ? cause.message : "Could not verify this address",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, queryClient]);

  if (state.status === "working") {
    return <p className="text-sm text-muted-foreground">Verifying…</p>;
  }
  if (state.status === "done") {
    return (
      <div className="space-y-4">
        <p className="text-sm" role="status">
          Your email address is verified.
        </p>
        <Button asChild className="w-full">
          <Link href="/">Continue to spawn</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-destructive" role="alert">
        {state.message}
      </p>
      <p className="text-sm text-muted-foreground">
        Verification links work once and expire after two days. Sign in and request a fresh one from
        Settings.
      </p>
      <Button asChild variant="secondary" className="w-full">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="flex min-h-vv items-center justify-center px-4 pad-safe-top pad-safe-bottom">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verify your email</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={null}>
            <VerifyEmail />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
