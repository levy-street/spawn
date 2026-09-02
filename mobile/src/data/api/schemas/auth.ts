import { z } from "zod";
import { IsoDateTimeSchema, UUIDSchema } from "@/data/api/schemas/common";

export const ProviderIdSchema = z.enum(["google", "microsoft", "github", "apple"]);
export const HealthzResponseSchema = z.object({ status: z.literal("ok") });

/**
 * Per-account plan state, carried on every shape that returns a user.
 *
 * Null means the deployment has no billing at all — a self-hosted server never
 * populates it, and the app then renders no billing surface anywhere.
 *
 * Every field is defaulted and the block itself is nullish, and that is
 * load-bearing rather than tidy: `/api/me` gates app **launch**, because
 * `useAuthBootstrap` reports `loading` while `meQuery.data` is undefined and
 * `AuthGate` holds a full-screen overlay until it resolves. A tightened shape
 * here breaks the launch path, not a screen. See docs/BILLING.md §6.2.
 *
 * It carries facts only — no prose, no price, no link. Every billing word a
 * person reads is built from these numbers in `data/selectors/billing.ts`.
 */
export const UserBillingSchema = z.object({
  enabled: z.boolean().default(false),
  tier: z.string().default("free"),
  /** Display name, from the server. The Legion tier is spelled "the Legion plan". */
  tier_name: z.string().default("Free"),
  /** null = unlimited. */
  host_limit: z.number().int().nullable().default(null),
  host_count: z.number().int().default(0),
  over_limit: z.boolean().default(false),
  /** Stripe's own subscription status, verbatim, or null for no subscription. */
  status: z.string().nullable().default(null),
  current_period_end: IsoDateTimeSchema.nullable().default(null),
  cancel_at_period_end: z.boolean().default(false),
});

export const UserOutSchema = z.object({
  id: UUIDSchema,
  email: z.string(),
  created_at: IsoDateTimeSchema,
  email_verified_at: IsoDateTimeSchema.nullable(),
  is_admin: z.boolean(),
  billing: UserBillingSchema.nullish().transform((value) => value ?? null),
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
/**
 * What this deployment's billing does, as the server advertises it.
 *
 * `enabled` false means render no billing surface at all. The `.default()`s are
 * load-bearing for the same reason as `UserBillingSchema`'s: a self-hosted
 * server that omits the block must not trip a schema mismatch and brick launch.
 *
 * The server's block also carries a `tiers` array with prices in it. This
 * schema deliberately drops it — zod strips what it does not name — because the
 * mobile apps never sell anything (docs/BILLING.md §6.1) and the surest way to
 * keep a price out of the binary is never to parse one into it.
 *
 * `mobile_upgrade_link` is false at launch and is the one switch that would
 * ever change that, server-side, without an App Store submission. Nothing in
 * the app may show an off-platform upgrade route while it is false.
 */
export const BillingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  free_host_limit: z.number().int().default(1),
  mobile_upgrade_link: z.boolean().default(false),
});

export const AuthConfigOutSchema = z.object({
  providers: z.array(AuthProviderOutSchema),
  email_verification_required: z.boolean(),
  invite_only: z.boolean(),
  billing: BillingConfigSchema.default({
    enabled: false,
    free_host_limit: 1,
    mobile_upgrade_link: false,
  }),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;
export type UserBilling = z.infer<typeof UserBillingSchema>;
export type UserOut = z.infer<typeof UserOutSchema>;
export type BillingConfig = z.infer<typeof BillingConfigSchema>;
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
