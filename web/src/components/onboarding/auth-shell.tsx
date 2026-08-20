import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { RegistrationMarks } from "@/components/brand/press";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { poster } from "@/lib/fonts";
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
  /** The gates this account actually has to pass; defaults to all of them. */
  steps?: readonly OnboardingStep[];
  /**
   * `stacked` is one centred column — the right measure for a sign-in form.
   * `split` ranges the masthead against a wider plate, which is what the
   * onboarding gates need: they carry borrowed panels and long install lines.
   */
  layout?: "stacked" | "split";
  cardClassName?: string;
}

/**
 * The press sheet every account surface is printed on — signup, login,
 * recovery, and the onboarding gates. It carries the landing page's own
 * vocabulary through the funnel: the ink plate under a scrim, the press bed's
 * registration marks, the poster didone for the title, and the sigil for the
 * controls (see `.pressroom` in globals.css, which re-cuts the app's shared
 * primitives in press ink for anything rendered inside here).
 */
export function AuthShell({
  title,
  description,
  children,
  step,
  steps = ONBOARDING_STEPS,
  layout = "stacked",
  cardClassName,
}: AuthShellProps) {
  const rail = step ? <StepRail current={step} steps={steps} /> : null;

  return (
    <main className="grimoire pressroom relative isolate flex min-h-vv flex-col overflow-hidden bg-void pad-safe-x pad-safe-top pad-safe-bottom">
      {/* The plate the landing page closes on, so the sheet you sign up from is
       * the one you were just reading. */}
      <Image
        src="/brand/ink/altar-ink.png"
        alt=""
        aria-hidden
        fill
        priority
        sizes="100vw"
        className="pointer-events-none -z-10 object-cover object-[50%_32%]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,.96) 0%, rgba(0,0,0,.88) 30%, rgba(0,0,0,.82) 55%, rgba(0,0,0,.96) 100%)",
        }}
      />
      <RegistrationMarks />

      {/* The escape hatch, pinned to the top of the sheet and ranged with the
       * masthead below it. Out of flow so the columns can hang from one line. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto w-full max-w-6xl px-5 pt-4 lg:px-10 lg:pt-6">
        <Link
          href="/"
          className="group pointer-events-auto inline-flex min-h-11 items-center gap-2 font-sigil text-[11px] tracking-[0.16em] text-ash uppercase transition-colors hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
        >
          <ArrowLeft
            className="size-4 transition-transform group-hover:-translate-x-0.5"
            aria-hidden
          />
          Back home
        </Link>
      </div>

      {layout === "split" ? (
        // Both columns hang from the same line: 200px down a roomy desktop
        // page, giving that height back as the window gets shorter, and clear
        // of the back link on narrow screens.
        <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center gap-8 px-5 pt-24 pb-12 lg:flex-row lg:items-start lg:justify-between lg:gap-16 lg:px-10 lg:pt-[clamp(88px,22vh,200px)] lg:pb-20">
          <header className="flex w-full max-w-md min-w-0 flex-col items-center text-center lg:w-[38%] lg:max-w-sm lg:shrink-0 lg:items-start lg:text-left">
            <BrandLockup />
            <h1
              className={cn(
                poster.className,
                "mt-7 text-[clamp(30px,5.4vw,48px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
              )}
            >
              {title}
            </h1>
            {description ? (
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-ash">{description}</p>
            ) : null}
            {rail}
          </header>

          <section className={cn(PLATE, "p-5 sm:p-7 lg:max-w-xl lg:flex-1", cardClassName)}>
            {children}
          </section>
        </div>
      ) : (
        <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 pt-24 pb-12">
          <BrandLockup className="mx-auto" />
          {rail}
          <section className={cn(PLATE, cardClassName)}>
            <header className="border-line-g border-b px-5 py-5 sm:px-6">
              <h1
                className={cn(
                  poster.className,
                  "text-[clamp(26px,5.9vw,32px)] leading-[1.06] font-light text-bone uppercase [text-wrap:balance]",
                )}
              >
                {title}
              </h1>
              {description ? (
                <p className="mt-3 max-w-prose text-[15px] leading-6 text-ash">{description}</p>
              ) : null}
            </header>
            <div className="px-5 py-5 sm:px-6">{children}</div>
          </section>
        </div>
      )}
    </main>
  );
}

/** The printed plate both layouts set their work on. */
const PLATE =
  "w-full min-w-0 rounded-sm border border-line-g bg-char/85 shadow-2xl shadow-void/60 backdrop-blur-sm";

function BrandLockup({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="spawnd home"
      className={cn(
        "flex min-h-11 w-fit items-center gap-3 text-hellfire transition-colors hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember",
        className,
      )}
    >
      {/* The mark stands only a shade above the wordmark's cap height. */}
      <Trident className="size-[26px]" />
      <Wordmark aria-hidden className="h-5" />
    </Link>
  );
}

/** The gates as a ladder of rules — struck for the one you're on, inked for
 * the ones behind you, blank for the ones ahead. */
function StepRail({
  current,
  steps,
}: {
  current: OnboardingStep;
  steps: readonly OnboardingStep[];
}) {
  const currentIndex = steps.indexOf(current);

  return (
    <ol
      className="mt-9 flex w-full flex-wrap justify-center gap-x-6 gap-y-3 font-sigil text-[11px] tracking-[0.18em] uppercase lg:flex-col lg:gap-3.5"
      aria-label="Onboarding progress"
    >
      {steps.map((step, index) => {
        const active = step === current;
        const complete = index < currentIndex;
        return (
          <li
            key={step}
            className={cn(
              "flex min-w-0 items-center gap-3",
              active ? "text-bone" : complete ? "text-ash" : "text-ash/55",
            )}
            aria-current={active ? "step" : undefined}
          >
            <span
              className={cn(
                "h-[2px] shrink-0 transition-all",
                active ? "w-10 bg-hellfire" : complete ? "w-6 bg-ember/60" : "w-6 bg-line-strong",
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
