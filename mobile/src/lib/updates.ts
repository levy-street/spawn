import Constants from "expo-constants";
import * as Updates from "expo-updates";

export type MobileUpdateDecision = "none" | "check-ota" | "store";

export interface MobileUpdateDecisionInput {
  clientTree: string | null;
  serverTree: string | null;
  clientRuntime: string | null;
  serverRuntime: string | null;
  hard: boolean;
}

export interface MobileUpdatesClient {
  readonly isEnabled: boolean;
  readonly runtimeVersion: string | null;
  checkForUpdateAsync(): Promise<boolean>;
  fetchUpdateAsync(): Promise<void>;
  reloadAsync(): Promise<void>;
}

function knownIdentity(value: string | null): value is string {
  return value !== null && value.trim().length > 0 && !value.toLowerCase().includes("dirty");
}

export function decideMobileUpdate({
  clientTree,
  serverTree,
  clientRuntime,
  serverRuntime,
  hard,
}: MobileUpdateDecisionInput): MobileUpdateDecision {
  if (
    knownIdentity(clientRuntime) &&
    knownIdentity(serverRuntime) &&
    clientRuntime !== serverRuntime
  ) {
    return "store";
  }
  if (hard) return "check-ota";
  if (!knownIdentity(clientTree) || !knownIdentity(serverTree)) return "none";
  return clientTree === serverTree ? "none" : "check-ota";
}

export function clientMobileTree(): string | null {
  const value = Constants.expoConfig?.extra?.["mobileTree"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const enabled = !__DEV__ && Updates.isEnabled;

export const mobileUpdates: MobileUpdatesClient = {
  isEnabled: enabled,
  runtimeVersion: Updates.runtimeVersion ?? Constants.expoConfig?.version ?? null,
  async checkForUpdateAsync() {
    if (!enabled) return false;
    return (await Updates.checkForUpdateAsync()).isAvailable;
  },
  async fetchUpdateAsync() {
    if (!enabled) return;
    await Updates.fetchUpdateAsync();
  },
  async reloadAsync() {
    if (!enabled) return;
    await Updates.reloadAsync();
  },
};
