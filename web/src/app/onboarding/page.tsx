import { Suspense } from "react";
import { AuthShell } from "@/components/onboarding/auth-shell";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { Spinner } from "@/components/ui/spinner";

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <AuthShell title="Preparing setup" layout="split">
          <div className="flex min-h-28 items-center justify-center">
            <Spinner size={20} label="Preparing onboarding" />
          </div>
        </AuthShell>
      }
    >
      <OnboardingFlow />
    </Suspense>
  );
}
