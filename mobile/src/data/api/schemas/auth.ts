import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const ProviderIdSchema = z.enum(["google", "microsoft", "github", "apple"]);
export const HealthzResponseSchema = z.object({ status: z.literal("ok") });
export const UserOutSchema = z.object({
  id: UUIDSchema,
  email: z.string(),
  created_at: IsoDateTimeSchema,
  email_verified_at: IsoDateTimeSchema.nullable(),
  is_admin: z.boolean(),
});
export const SignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  invite: z.string().max(256).nullable().optional(),
});
export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  user: UserOutSchema,
});
export const SessionRenewResponseSchema = z.object({
  access_token: z.string(),
  expires_at: IsoDateTimeSchema,
});
export const SignOutEverywhereResponseSchema = z.object({ access_token: z.string() });
export const MeResponseSchema = z.object({ user: UserOutSchema });
export const PasswordResetRequestSchema = z.object({ email: z.string().email() });
export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(16).max(256),
  new_password: z.string().min(12).max(256),
});
export const EmailVerifyConfirmSchema = z.object({ token: z.string().min(16).max(256) });
export const AccountDeleteRequestSchema = z.object({
  confirm_email: z.string().email(),
  password: z.string().nullable().optional(),
});
export const AuthProviderOutSchema = z.object({ id: ProviderIdSchema, name: z.string() });
export const OAuthExchangeRequestSchema = z.object({
  code: z.string().min(16).max(256),
  // PKCE: proves this app started the flow the code came back from. Optional
  // on the wire so a server that predates it still accepts the request.
  code_verifier: z.string().min(43).max(128).optional(),
});
// Sign in with Apple on iOS never leaves the app, so there is no callback and no
// one-time code: the identity token Apple hands the button goes straight up.
export const AppleNativeSignInSchema = z.object({
  identity_token: z.string().min(16).max(8192),
  invite: z.string().max(256).nullable().optional(),
});
// The address someone leaves while signup is closed. `source` names the page
// the form sat on; the server bounds it and treats it as a label.
export const WaitlistJoinRequestSchema = z.object({
  email: z.string().email(),
  source: z.string().max(120).nullable().optional(),
});
// Always `ok`: the server answers the same whether the address was new,
// already listed, or already an account, so nothing can be enumerated.
export const WaitlistJoinOutSchema = z.object({ ok: z.boolean() });
export const AuthConfigOutSchema = z.object({
  providers: z.array(AuthProviderOutSchema),
  email_verification_required: z.boolean(),
  invite_only: z.boolean(),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;
export type UserOut = z.infer<typeof UserOutSchema>;
export type SignupRequest = z.infer<typeof SignupRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type SessionRenewResponse = z.infer<typeof SessionRenewResponseSchema>;
export type SignOutEverywhereResponse = z.infer<typeof SignOutEverywhereResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirmSchema>;
export type EmailVerifyConfirm = z.infer<typeof EmailVerifyConfirmSchema>;
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;
export type AuthProviderOut = z.infer<typeof AuthProviderOutSchema>;
export type OAuthExchangeRequest = z.infer<typeof OAuthExchangeRequestSchema>;
export type AppleNativeSignIn = z.infer<typeof AppleNativeSignInSchema>;
export type AuthConfigOut = z.infer<typeof AuthConfigOutSchema>;
export type WaitlistJoinRequest = z.infer<typeof WaitlistJoinRequestSchema>;
export type WaitlistJoinOut = z.infer<typeof WaitlistJoinOutSchema>;
