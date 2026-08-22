import { authToken } from "@/data/api/auth-token";
import { api } from "@/data/api/client";
import { getBaseUrl } from "@/data/api/config";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
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

// Expo Go cannot complete the server's web-relative OAuth redirect back into the app.
export async function getOAuthStartUrl(provider: ProviderId, returnTo = "/"): Promise<string> {
  return `${await getBaseUrl()}/api/auth/oauth/${pathPart(provider)}/start${queryString({
    return_to: returnTo,
  })}`;
}

// Exposed for route parity and diagnostics; this remains a browser callback in Expo Go.
export async function getOAuthCallbackUrl(
  provider: ProviderId,
  values: { state?: string; code?: string; error?: string },
): Promise<string> {
  return `${await getBaseUrl()}/api/auth/oauth/${pathPart(provider)}/callback${queryString(values)}`;
}
