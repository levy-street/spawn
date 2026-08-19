import { SquareTerminal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS, type OnboardingStep } from "./step-machine";

const STEP_LABELS: Record<OnboardingStep, string> = {
  account: "Account",
  verify: "Verify",
  host: "Host",
  done: "Done",
};

interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  step?: OnboardingStep;
  cardClassName?: string;
}

export function AuthShell({ title, description, children, step, cardClassName }: AuthShellProps) {
  return (
    <main className="grimoire relative flex min-h-vv overflow-x-hidden bg-void pad-safe-x pad-safe-top pad-safe-bottom">
      <div
        className="grimoire-ring pointer-events-none absolute -right-40 -top-40 size-96 rounded-full border border-line-g sm:-right-24 sm:-top-48 sm:size-[34rem]"
        aria-hidden
      />
      <div
        className="grimoire-ring-rev pointer-events-none absolute -bottom-56 -left-56 size-[30rem] rounded-full border border-line-g sm:-bottom-72 sm:-left-40 sm:size-[42rem]"
        aria-hidden
      />

      <div className="relative mx-auto flex min-w-0 w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 py-8 sm:py-12">
        <Link
          href="/"
          className="mx-auto flex min-h-11 items-center gap-2 px-2 text-sm font-semibold tracking-wide text-bone transition-colors hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
        >
          <SquareTerminal className="size-5" aria-hidden />
          <span>spawnd</span>
        </Link>

        {step ? <StepIndicator current={step} /> : null}

        <Card
          className={cn(
            "min-w-0 w-full border-border bg-card font-sans text-card-foreground shadow-2xl shadow-void/40",
            cardClassName,
          )}
        >
          <CardHeader className="gap-2 p-5 pb-4 sm:p-6 sm:pb-4">
            <CardTitle className="text-2xl leading-tight tracking-tight">{title}</CardTitle>
            {description ? (
              <CardDescription className="max-w-prose leading-6">{description}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0">{children}</CardContent>
        </Card>

        <p className="text-center text-xs leading-5 text-ash">
          Private terminals, connected through infrastructure that cannot read them.
        </p>
      </div>
    </main>
  );
}

function StepIndicator({ current }: { current: OnboardingStep }) {
  const currentIndex = ONBOARDING_STEPS.indexOf(current);

  return (
    <ol className="grid grid-cols-4 gap-1" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((step, index) => {
        const active = step === current;
        const complete = index < currentIndex;
        return (
          <li
            key={step}
            className={cn(
              "flex min-w-0 flex-col items-center gap-2 text-[0.6875rem] tracking-wide",
              active ? "text-bone" : "text-ash",
            )}
            aria-current={active ? "step" : undefined}
          >
            <span
              className={cn(
                "size-2.5 rounded-full border transition-colors",
                active
                  ? "border-hellfire bg-hellfire"
                  : complete
                    ? "border-ember bg-ember"
                    : "border-line-strong bg-transparent",
              )}
              aria-hidden
            />
            <span className="truncate">{STEP_LABELS[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}
