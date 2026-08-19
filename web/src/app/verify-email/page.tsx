"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { deriveStep } from "@/components/onboarding/step-machine";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, auth, hosts, type User } from "@/lib/api";

const SKIPPED_HOST_KEY = "spawn.onboarding.skippedHost";
const verificationRequests = new Map<string, ReturnType<typeof auth.confirmEmailVerification>>();

type State =
  | { status: "working" }
  | { status: "done"; user: User }
  | { status: "failed"; message: string };

function confirmEmailOnce(token: string) {
  const existing = verificationRequests.get(token);
  if (existing) return existing;
  const request = auth.confirmEmailVerification(token);
  verificationRequests.set(token, request);
  return request;
}

function VerifyEmail() {
  const queryClient = useQueryClient();
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<State>({ status: "working" });
  const [storage, setStorage] = useState({ ready: false, skippedHost: false });

  useEffect(() => {
    setStorage({
      ready: true,
      skippedHost: window.localStorage.getItem(SKIPPED_HOST_KEY) !== null,
    });
  }, []);

  useEffect(() => {
    if (token === "") {
      setState({ status: "failed", message: "This link is missing its token." });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await confirmEmailOnce(token);
        if (cancelled) return;
        queryClient.setQueryData(["me"], { user: result.user });
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        setState({ status: "done", user: result.user });
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

  const hostsQuery = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    enabled: state.status === "done",
    retry: 1,
  });

  if (state.status === "working") {
    return (
      <div className="flex min-h-28 items-center justify-center gap-3 text-sm text-muted-foreground">
        <Spinner label="Verifying email" />
        Verifying your email…
      </div>
    );
  }

  if (state.status === "done") {
    const routingReady = storage.ready && hostsQuery.data !== undefined;
    const continueHref =
      routingReady &&
      deriveStep({
        user: state.user,
        config: { email_verification_required: false },
        hosts: hostsQuery.data,
        skippedHost: storage.skippedHost,
      }) === "done"
        ? "/"
        : "/onboarding";

    return (
      <div className="space-y-5">
        <div
          className="flex items-center gap-3 rounded-md bg-success-soft p-4 text-success"
          role="status"
        >
          <Check className="size-5 shrink-0" aria-hidden />
          <p className="text-sm font-medium">Your email address is verified.</p>
        </div>
        {routingReady ? (
          <Button asChild className="h-11 w-full">
            <Link href={continueHref}>Continue to spawn</Link>
          </Button>
        ) : (
          <Button className="h-11 w-full" disabled>
            <Spinner label="Checking onboarding" />
            Checking setup…
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-destructive" role="alert">
        {state.message}
      </p>
      <p className="text-sm leading-6 text-muted-foreground">
        Verification links work once and expire after two days. Sign in and request a fresh one from
        Settings.
      </p>
      <Button asChild variant="secondary" className="h-11 w-full">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthShell
      title="Verify your email"
      description="Confirm the address attached to your spawnd account."
    >
      <Suspense fallback={<Spinner size={20} label="Loading verification" />}>
        <VerifyEmail />
      </Suspense>
    </AuthShell>
  );
}
