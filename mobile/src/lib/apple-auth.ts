import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";

import { signInWithApple as postAppleIdentityToken } from "@/data/api/endpoints/auth";
import type { TokenResponse } from "@/data/api/schemas/auth";

export type AppleSignInOutcome =
  | { status: "signed-in"; token: TokenResponse }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * Whether this device can show the Apple button at all.
 *
 * Android and the web build have no such button, and neither does an iOS
 * simulator signed out of iCloud — offering one that cannot complete is worse
 * than not offering it, so the caller hides it rather than letting it fail.
 */
export async function isAppleSignInAvailable(
  api: Pick<typeof AppleAuthentication, "isAvailableAsync"> = AppleAuthentication,
): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await api.isAvailableAsync();
  } catch {
    return false;
  }
}

function isCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_REQUEST_CANCELED"
  );
}

/**
 * Signs in through the native Apple sheet.
 *
 * The identity token carries a stable `sub` and the email, and the server keys
 * the account off those, so a second sign-in on a reinstalled app looks
 * identical to the first.
 */
export async function signInWithAppleNatively(
  options: {
    api?: Pick<typeof AppleAuthentication, "signInAsync">;
    post?: typeof postAppleIdentityToken;
    invite?: string | null;
  } = {},
): Promise<AppleSignInOutcome> {
  const api = options.api ?? AppleAuthentication;
  const post = options.post ?? postAppleIdentityToken;

  let identityToken: string | null;
  try {
    // Email only: the server keys accounts off `sub` and the email, and has
    // nowhere to put a name. See the scope note in `auth_providers.py`.
    const credential = await api.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
    });
    identityToken = credential.identityToken;
  } catch (error) {
    if (isCancellation(error)) return { status: "cancelled" };
    return { status: "failed", message: messageFor(error, "Apple sign-in failed.") };
  }

  if (!identityToken) {
    return { status: "failed", message: "Apple did not return an identity token." };
  }

  try {
    const token = await post({
      identity_token: identityToken,
      ...(options.invite ? { invite: options.invite } : {}),
    });
    return { status: "signed-in", token };
  } catch (error) {
    return {
      status: "failed",
      message: messageFor(error, "Apple sign-in could not be completed."),
    };
  }
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
