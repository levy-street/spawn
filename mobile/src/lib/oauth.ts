import * as ExpoCrypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";

import { exchangeOAuthCode, getOAuthStartUrl } from "@/data/api/endpoints/auth";
import type { ProviderId, TokenResponse } from "@/data/api/schemas/auth";
import { encodeBase64Url } from "@/lib/crypto/bytes";

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

/**
 * A PKCE pair for one sign-in.
 *
 * Only the challenge crosses the network on the way out. The one-time code the
 * callback carries back therefore proves which account signed in, but redeeming
 * it also takes the verifier — which never left this process. That is what ties
 * the code to the app that asked for it, rather than to whoever happens to be
 * holding it.
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = encodeBase64Url(ExpoCrypto.getRandomValues(new Uint8Array(32)));
  // The verifier is base64url, so it is ASCII and one byte per character.
  const ascii = new Uint8Array(new ArrayBuffer(verifier.length));
  for (let index = 0; index < verifier.length; index += 1) {
    ascii[index] = verifier.charCodeAt(index);
  }
  const digest = await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, ascii);
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
}

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
  if (failure) {
    // The server's own signal, not the provider's: the sign-in worked and the
    // deployment is closed. Worth naming plainly, because "access_denied" is
    // what a provider says when *it* refused, and the two need different
    // responses from the person reading it.
    if (failure === "invite_required") {
      return { error: "SPAWN D is invite only right now. Enter an invite code to continue." };
    }
    return { error: failure };
  }
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
  let verifier: string;
  try {
    const pkce = await createPkcePair();
    verifier = pkce.verifier;
    const startUrl = await getOAuthStartUrl(provider, {
      redirectUri: NATIVE_REDIRECT_URI,
      invite: options.invite ?? null,
      codeChallenge: pkce.challenge,
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
    return {
      status: "signed-in",
      token: await exchange({ code: callback.code, code_verifier: verifier }),
    };
  } catch (error) {
    return { status: "failed", message: messageFor(error, "Sign-in could not be completed.") };
  }
}

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
