import * as WebBrowser from "expo-web-browser";

import { exchangeOAuthCode, getOAuthStartUrl } from "@/data/api/endpoints/auth";
import type { ProviderId, TokenResponse } from "@/data/api/schemas/auth";

/**
 * The scheme the server hands the one-time code back on.
 *
 * This string is matched exactly against the server's allow-list
 * (`oauth_native_redirect_uris`, default `spawn://auth/oauth`), so it is not a
 * free choice — changing it here means changing it there in the same breath, or
 * every sign-in starts failing with "redirect_uri is not an allowed native
 * redirect".
 */
export const NATIVE_REDIRECT_URI = "spawn://auth/oauth";

export type OAuthSignInOutcome =
  | { status: "signed-in"; token: TokenResponse }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/** The slice of expo-web-browser this flow needs, so tests can stand in for it. */
export interface AuthSessionOpener {
  openAuthSessionAsync(
    url: string,
    redirectUrl: string,
  ): Promise<WebBrowser.WebBrowserAuthSessionResult>;
}

/**
 * Reads the callback URL the system web view closed on.
 *
 * The server appends `?code=...` on success. Anything else — an `error`, or a
 * URL with neither — is a failure worth naming rather than a silent no-op.
 */
export function readCallbackCode(url: string): { code: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "The sign-in callback was not a valid URL." };
  }
  const failure = parsed.searchParams.get("error");
  if (failure) return { error: failure };
  const code = parsed.searchParams.get("code");
  if (!code) return { error: "The sign-in callback did not include a code." };
  return { code };
}

/**
 * Runs a provider sign-in in the system web view and returns a session.
 *
 * The web view is the point: it is the only surface that can show the provider's
 * real domain in a chrome the app cannot draw over, and on iOS it shares the
 * Safari cookie jar, so an already-signed-in account needs no password.
 */
export async function signInWithProvider(
  provider: ProviderId,
  options: {
    browser?: AuthSessionOpener;
    exchange?: typeof exchangeOAuthCode;
    invite?: string | null;
  } = {},
): Promise<OAuthSignInOutcome> {
  const browser = options.browser ?? WebBrowser;
  const exchange = options.exchange ?? exchangeOAuthCode;

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    const startUrl = await getOAuthStartUrl(provider, {
      redirectUri: NATIVE_REDIRECT_URI,
      invite: options.invite ?? null,
    });
    result = await browser.openAuthSessionAsync(startUrl, NATIVE_REDIRECT_URI);
  } catch (error) {
    return { status: "failed", message: messageFor(error, "Sign-in could not be started.") };
  }

  // `dismiss` is the user tapping Cancel and `locked` is a second attempt while
  // one is already open — neither is an error to shout about.
  if (result.type !== "success") return { status: "cancelled" };

  const callback = readCallbackCode(result.url);
  if ("error" in callback) return { status: "failed", message: callback.error };

  try {
    return { status: "signed-in", token: await exchange({ code: callback.code }) };
  } catch (error) {
    return { status: "failed", message: messageFor(error, "Sign-in could not be completed.") };
  }
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
