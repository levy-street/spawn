"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { SignupForm } from "@/components/onboarding/signup-form";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAuthConfig } from "@/lib/auth";

function SignupPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { config, loading, error, refetch } = useAuthConfig();
  const invite = searchParams.get("invite");

  if (loading || config === null) {
    if (error) {
      return (
        <AuthShell
          title="Couldn’t load signup"
          description="The server’s signup settings are unavailable."
        >
          <Button className="h-11 w-full" onClick={() => void refetch()}>
            Try again
          </Button>
        </AuthShell>
      );
    }
    return <SignupLoading />;
  }

  return (
    <AuthShell
      title="Create your account"
      description="Start with an account, then connect the machine where your agents work."
    >
      <div className="space-y-5">
        {invite !== null ? (
          <p
            className="rounded-md border border-success/40 bg-success-soft px-3 py-2 text-sm"
            role="status"
          >
            You have an invite — finish creating your account below.
          </p>
        ) : null}
        <SignupForm
          config={config}
          initialInvite={invite}
          oauthReturnTo="/onboarding"
          onSuccess={() => router.replace("/onboarding")}
        />
      </div>
    </AuthShell>
  );
}

function SignupLoading() {
  return (
    <AuthShell title="Create your account">
      <div className="flex min-h-28 items-center justify-center">
        <Spinner size={20} label="Loading signup" />
      </div>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<SignupLoading />}>
      <SignupPageContent />
    </Suspense>
  );
}
