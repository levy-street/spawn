"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { SignupForm } from "@/components/onboarding/signup-form";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAuthConfig } from "@/lib/auth";

/** Display name for a provider id, for copy that names who signed you in. */
function providerName(id: string): string {
  if (id === "apple") return "Apple";
  if (id === "google") return "Google";
  if (id === "github") return "GitHub";
  if (id === "microsoft") return "Microsoft";
  return id;
}

function SignupPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { config, loading, error, refetch } = useAuthConfig();
  const invite = searchParams.get("invite");
  // Set by the OAuth callback when the provider verified someone but the
  // deployment is closed and they carried no invite. They are one field away
  // from an account, so say that rather than showing a bare refusal.
  const inviteRequired = searchParams.get("invite_required") === "1";
  const blockedProvider = searchParams.get("provider");

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
        {inviteRequired ? (
          <p
            className="rounded-sm border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-bone"
            role="status"
          >
            {blockedProvider
              ? `${providerName(blockedProvider)} signed you in`
              : "You're signed in"}
            , but SPAWN D is invite only right now. Enter your invite code below and continue with{" "}
            {blockedProvider ? providerName(blockedProvider) : "your provider"} again to finish.
          </p>
        ) : invite !== null ? (
          <p
            className="rounded-sm border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-bone"
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
        <p className="text-center text-sm text-ash">
          Already have an account?{" "}
          <Link
            href="/login"
            className="-my-2 inline-flex items-center py-2 font-medium text-ember underline decoration-ember/50 underline-offset-4 transition-colors hover:text-hellfire hover:decoration-ember"
          >
            Log in
          </Link>
        </p>
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
