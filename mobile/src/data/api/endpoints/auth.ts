import { authToken } from "@/data/api/auth-token";
import { api } from "@/data/api/client";
import { getBaseUrl } from "@/data/api/config";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type AppleNativeSignIn,
  AppleNativeSignInSchema,
  type AuthConfigOut,
  AuthConfigOutSchema,
  type EmailVerifyConfirm,
  EmailVerifyConfirmSchema,
  type HealthzResponse,
  HealthzResponseSchema,
  type LoginRequest,
  LoginRequestSchema,
  type MeResponse,
  MeResponseSchema,
  type OAuthExchangeRequest,
  OAuthExchangeRequestSchema,
  type PasswordResetConfirm,
  PasswordResetConfirmSchema,
  type PasswordResetRequest,
  PasswordResetRequestSchema,
  type ProviderId,
  type SignupRequest,
  SignupRequestSchema,
  type TokenResponse,
  TokenResponseSchema,
} from "@/data/api/schemas/auth";
import { unregisterForPushNotifications } from "@/lib/push";

export function healthCheck(): Promise<HealthzResponse> {
  return api("/healthz", { auth: false, schema: HealthzResponseSchema });
}

export function getAuthConfig(): Promise<AuthConfigOut> {
  return api("/api/auth/config", { auth: false, schema: AuthConfigOutSchema });
}

export function signUp(body: SignupRequest): Promise<TokenResponse> {
  return api("/api/auth/signup", {
    method: "POST",
    auth: false,
    body: jsonBody(SignupRequestSchema.parse(body)),
    schema: TokenResponseSchema,
    onResponse: authToken.captureFromResponse,
  });
}

export function logIn(body: LoginRequest): Promise<TokenResponse> {
  return api("/api/auth/login", {
    method: "POST",
    auth: false,
    body: jsonBody(LoginRequestSchema.parse(body)),
    schema: TokenResponseSchema,
    onResponse: authToken.captureFromResponse,
  });
}

export async function logOut(): Promise<void> {
  try {
    // Before the token goes: the call needs this session to authorize, and a
    // handset that keeps its registration would go on showing the previous
    // account's alerts to whoever signs in next.
    await unregisterForPushNotifications();
    await api<void>("/api/auth/logout", { method: "POST" });
  } finally {
    await authToken.clear();
  }
}

export function requestPasswordReset(body: PasswordResetRequest): Promise<void> {
  return api("/api/auth/password-reset/request", {
    method: "POST",
    auth: false,
    body: jsonBody(PasswordResetRequestSchema.parse(body)),
  });
}

export function confirmPasswordReset(body: PasswordResetConfirm): Promise<TokenResponse> {
  return api("/api/auth/password-reset/confirm", {
    method: "POST",
    auth: false,
    body: jsonBody(PasswordResetConfirmSchema.parse(body)),
    schema: TokenResponseSchema,
    onResponse: authToken.captureFromResponse,
  });
}

export function requestEmailVerification(): Promise<void> {
  return api("/api/auth/verify-email/request", { method: "POST" });
}

export function confirmEmailVerification(body: EmailVerifyConfirm): Promise<MeResponse> {
  return api("/api/auth/verify-email/confirm", {
    method: "POST",
    auth: false,
    body: jsonBody(EmailVerifyConfirmSchema.parse(body)),
    schema: MeResponseSchema,
  });
}

/**
 * The start URL for a provider sign-in that comes back to the app.
 *
 * `redirect_uri` is what turns this into a native flow: the server checks it
 * against its allow-list and, when it matches, ends the callback on that scheme
 * with a one-time code instead of setting a cookie the app could never read.
 * Omitting it leaves the ordinary web redirect in place.
 */
export async function getOAuthStartUrl(
  provider: ProviderId,
  options: { returnTo?: string; redirectUri?: string } = {},
): Promise<string> {
  return `${await getBaseUrl()}/api/auth/oauth/${pathPart(provider)}/start${queryString({
    return_to: options.returnTo ?? "/",
    redirect_uri: options.redirectUri,
  })}`;
}

/** Trade the callback's one-time code for the token a password login returns. */
export function exchangeOAuthCode(body: OAuthExchangeRequest): Promise<TokenResponse> {
  return api("/api/auth/oauth/exchange", {
    method: "POST",
    auth: false,
    body: jsonBody(OAuthExchangeRequestSchema.parse(body)),
    schema: TokenResponseSchema,
    onResponse: authToken.captureFromResponse,
  });
}

/** Sign in with the identity token from the native Apple button. */
export function signInWithApple(body: AppleNativeSignIn): Promise<TokenResponse> {
  return api("/api/auth/oauth/apple/native", {
    method: "POST",
    auth: false,
    body: jsonBody(AppleNativeSignInSchema.parse(body)),
    schema: TokenResponseSchema,
    onResponse: authToken.captureFromResponse,
  });
}
