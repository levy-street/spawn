import AsyncStorage from "@react-native-async-storage/async-storage";

export type OnboardingStep = "account" | "verify" | "host" | "done";

export interface OnboardingAccountState {
  emailVerified: boolean;
}

export interface OnboardingStepInput {
  account: OnboardingAccountState | null;
  emailVerificationRequired: boolean;
  hostCount: number;
  hostSkipped: boolean;
}

export const HOST_SKIP_STORAGE_KEY = "spawn.onboarding.skippedHost";

export function resolveOnboardingStep(input: OnboardingStepInput): OnboardingStep {
  if (input.account === null) return "account";
  if (input.emailVerificationRequired && !input.account.emailVerified) return "verify";
  if (input.hostCount === 0 && !input.hostSkipped) return "host";
  return "done";
}

export async function readHostSkipped(): Promise<boolean> {
  return (await AsyncStorage.getItem(HOST_SKIP_STORAGE_KEY)) === "true";
}

export async function setHostSkipped(skipped: boolean): Promise<void> {
  if (skipped) {
    await AsyncStorage.setItem(HOST_SKIP_STORAGE_KEY, "true");
  } else {
    await AsyncStorage.removeItem(HOST_SKIP_STORAGE_KEY);
  }
}
