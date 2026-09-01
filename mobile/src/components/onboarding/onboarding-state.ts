import AsyncStorage from "@react-native-async-storage/async-storage";

export type OnboardingStep = "account" | "verify" | "host" | "done";

export interface OnboardingAccountState {
  emailVerified: boolean;
}

export interface OnboardingStepInput {
  account: OnboardingAccountState | null;
  emailVerificationRequired: boolean;
  hostCount: number;
  /**
   * Hosts that have pinned THIS device's browser identity. An account can own
   * hosts that were paired from somewhere else, and those hosts drop this
   * device's RTC offers without replying — so "the account has a host" is not
   * evidence that this phone can open anything.
   */
  deviceTrustedHostCount: number;
  hostSkipped: boolean;
}

export const HOST_SKIP_STORAGE_KEY = "spawn.onboarding.skippedHost";
type HostSkippedListener = (skipped: boolean) => void;
const hostSkippedListeners = new Set<HostSkippedListener>();

export function resolveOnboardingStep(input: OnboardingStepInput): OnboardingStep {
  if (input.account === null) return "account";
  if (input.emailVerificationRequired && !input.account.emailVerified) return "verify";
  if ((input.hostCount === 0 || input.deviceTrustedHostCount === 0) && !input.hostSkipped) {
    return "host";
  }
  return "done";
}

export async function readHostSkipped(): Promise<boolean> {
  return (await AsyncStorage.getItem(HOST_SKIP_STORAGE_KEY)) === "true";
}

/** Keep AuthGate and a mounted onboarding flow in the same live state. */
export function subscribeHostSkipped(listener: HostSkippedListener): () => void {
  hostSkippedListeners.add(listener);
  return () => hostSkippedListeners.delete(listener);
}

export async function setHostSkipped(skipped: boolean): Promise<void> {
  if (skipped) {
    await AsyncStorage.setItem(HOST_SKIP_STORAGE_KEY, "true");
  } else {
    await AsyncStorage.removeItem(HOST_SKIP_STORAGE_KEY);
  }
  for (const listener of [...hostSkippedListeners]) listener(skipped);
}
