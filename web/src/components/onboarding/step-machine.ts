export const ONBOARDING_STEPS = ["account", "verify", "host", "done"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface DeriveStepInput {
  user: { email_verified_at: string | null } | null;
  config: { email_verification_required: boolean };
  hosts: readonly unknown[];
  skippedHost: boolean;
}

/**
 * Return the first onboarding gate that live state has not satisfied.
 *
 * Keeping this pure is important: auth, verification, and host pairing can
 * complete in another tab, so the UI must never preserve a stale local step.
 */
export function deriveStep({ user, config, hosts, skippedHost }: DeriveStepInput): OnboardingStep {
  if (user === null) return "account";
  if (config.email_verification_required && user.email_verified_at === null) return "verify";
  if (hosts.length === 0 && !skippedHost) return "host";
  return "done";
}

export function parseRequestedStep(value: string | null): OnboardingStep | null {
  return ONBOARDING_STEPS.find((step) => step === value) ?? null;
}

/** A deep link is valid only when it names the currently unsatisfied gate. */
export function resolveStep(input: DeriveStepInput, requested: string | null): OnboardingStep {
  const derived = deriveStep(input);
  const requestedStep = parseRequestedStep(requested);
  if (requestedStep === derived) return requestedStep;
  return derived;
}
