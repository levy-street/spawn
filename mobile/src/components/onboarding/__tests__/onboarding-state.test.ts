import {
  type OnboardingStepInput,
  resolveOnboardingStep,
} from "@/components/onboarding/onboarding-state";

const READY_ACCOUNT = { emailVerified: true };

function state(overrides: Partial<OnboardingStepInput> = {}): OnboardingStepInput {
  return {
    account: READY_ACCOUNT,
    emailVerificationRequired: false,
    hostCount: 0,
    deviceTrustedHostCount: 0,
    hostSkipped: false,
    ...overrides,
  };
}

describe("resolveOnboardingStep", () => {
  it("requires account, verification, and host gates in order", () => {
    expect(resolveOnboardingStep(state({ account: null }))).toBe("account");
    expect(
      resolveOnboardingStep(
        state({ account: { emailVerified: false }, emailVerificationRequired: true }),
      ),
    ).toBe("verify");
    expect(resolveOnboardingStep(state())).toBe("host");
  });

  it("removes the verification gate when the server does not enforce it", () => {
    expect(
      resolveOnboardingStep(
        state({ account: { emailVerified: false }, emailVerificationRequired: false }),
      ),
    ).toBe("host");
  });

  it("finishes for a host that trusts this device or an explicit local skip", () => {
    expect(resolveOnboardingStep(state({ hostCount: 1, deviceTrustedHostCount: 1 }))).toBe("done");
    expect(resolveOnboardingStep(state({ hostSkipped: true }))).toBe("done");
  });

  it("keeps the host gate when the account owns hosts none of which trust this device", () => {
    expect(resolveOnboardingStep(state({ hostCount: 2, deviceTrustedHostCount: 0 }))).toBe("host");
  });
});
