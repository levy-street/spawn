import { ApiError, type BillingTier } from "@/lib/api";

/**
 * The framework-free half of billing: the numbers a plan surface reads, and
 * the two structured refusals the server answers with.
 *
 * Nothing here decides whether billing exists at all — that is
 * `useBilling()`, which needs React. Everything here assumes it does.
 */

/** The shape every plan surface reads: `/api/me`'s block and `/api/billing/state` both fit. */
export interface HostAllowance {
  /** null = unlimited. */
  host_limit: number | null;
  host_count: number;
}

/** `null` is unlimited everywhere in this feature; say so in words, once. */
export function hostLimitLabel(limit: number | null): string {
  return limit === null ? "unlimited" : String(limit);
}

/** "3 of 3 hosts" — and, with no ceiling to count against, just "3 hosts". */
export function hostsUsedLabel({ host_count, host_limit }: HostAllowance): string {
  // The noun agrees with the number it sits beside — the ceiling where there
  // is one ("1 of 3 hosts"), the count where there is not ("1 host").
  const governing = host_limit ?? host_count;
  const noun = governing === 1 ? "host" : "hosts";
  return host_limit === null ? `${host_count} ${noun}` : `${host_count} of ${host_limit} ${noun}`;
}

/** At the ceiling: the next host would be refused. Never true when unlimited. */
export function atCapacity({ host_count, host_limit }: HostAllowance): boolean {
  return host_limit !== null && host_count >= host_limit;
}

/**
 * How many hosts must go before the account is inside its limit again.
 *
 * Reachable without anyone doing anything wrong — a downgrade is always
 * allowed — so this is a number the app has to be able to say out loud.
 */
export function overBy({ host_count, host_limit }: HostAllowance): number {
  return host_limit === null ? 0 : Math.max(0, host_count - host_limit);
}

/** Monthly, USD, from cents. The only price the product has. */
export function priceLabel(cents: number): string {
  if (cents <= 0) return "Free";
  const dollars = cents / 100;
  const amount = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  return `$${amount}/mo`;
}

export interface PeriodNotice {
  /** `renews` — the ordinary state. `ends` — cancelled, still entitled until the date. */
  tone: "renews" | "ends";
  /** ISO 8601, exactly as the server sent it. Formatting is the screen's job. */
  at: string;
}

/**
 * What to say about the date, or nothing at all.
 *
 * Free accounts and lapsed ones have no period to report, and inventing
 * "renews —" for them would be a sentence about a subscription that does not
 * exist.
 */
export function periodNotice(state: {
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}): PeriodNotice | null {
  if (state.current_period_end === null) return null;
  return {
    tone: state.cancel_at_period_end ? "ends" : "renews",
    at: state.current_period_end,
  };
}

/**
 * Which way a plan change goes, by price.
 *
 * Price rather than host count because that is what the words mean to the
 * person paying, and because two tiers could in principle share a limit. An
 * unknown tier key compares as "same", which shows the neutral wording rather
 * than a claim the app cannot support.
 */
export function planDirection(
  currentTier: string,
  targetTier: string,
  tiers: readonly BillingTier[],
): "upgrade" | "downgrade" | "same" {
  if (currentTier === targetTier) return "same";
  const priceOf = (key: string) => tiers.find((tier) => tier.key === key)?.price_cents;
  const from = priceOf(currentTier);
  const to = priceOf(targetTier);
  if (from === undefined || to === undefined || from === to) return "same";
  return to > from ? "upgrade" : "downgrade";
}

/**
 * An admin's comp, in words — because the stored value cannot be read at a
 * glance and misreading it is expensive.
 *
 * `null` is no override at all. **`0` is UNLIMITED, not zero hosts.** Any
 * other integer is that many. An operator who reads `0` as "none" would think
 * they had locked an account out when they had just given it everything, so
 * the number is never shown on its own anywhere in the admin surface.
 */
export function hostLimitOverrideLabel(value: number | null): string {
  if (value === null) return "No override";
  if (value === 0) return "Unlimited";
  return `${value} ${value === 1 ? "host" : "hosts"}`;
}

/** The facts the server sends with both structured billing refusals. */
export interface LimitFacts {
  tier: string;
  /** null = unlimited. */
  host_limit: number | null;
  host_count: number;
}

function readLimitFacts(error: unknown, code: string): LimitFacts | null {
  if (!(error instanceof ApiError)) return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const body = detail as Record<string, unknown>;
  if (body.code !== code) return null;
  const limit = body.host_limit;
  return {
    tier: typeof body.tier === "string" ? body.tier : "free",
    host_limit: typeof limit === "number" ? limit : null,
    host_count: typeof body.host_count === "number" ? body.host_count : 0,
  };
}

/**
 * The 402 the possession ceremony is refused with
 * (`billing.limit_error_detail`): a machine code and three numbers, no prose.
 * Every word the reader sees is ours.
 */
export function hostLimitFacts(error: unknown): LimitFacts | null {
  return readLimitFacts(error, "host_limit");
}

/**
 * The 409 `POST /api/billing/change-plan` answers when the account holds more
 * hosts than the target tier admits. It is not a refusal of the downgrade —
 * downgrades are always allowed — it is the server asking which machines to
 * keep, because it will never release one on a billing signal.
 */
export function hostSelectionRequired(error: unknown): LimitFacts | null {
  return readLimitFacts(error, "host_selection_required");
}

/**
 * The other 409 that route answers: there is no subscription to move.
 *
 * It reaches a client whose account holds a Stripe row Stripe has itself
 * given up on — cancelled, or lapsed to `unpaid`. The server names the next
 * step in a machine code rather than in prose, and that step is Checkout.
 */
export function subscriptionRequired(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const detail = error.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as Record<string, unknown>).code === "subscription_required"
  );
}

/**
 * The server's own words for a failure, or null where it sent only a machine
 * code.
 *
 * Null is the important half: `ApiError.message` falls back to the HTTP status
 * text, and putting "Conflict" in front of somebody is worse than saying
 * nothing, because the caller has a real sentence to show instead.
 */
export function serverMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const detail = error.detail;
  if (typeof detail === "string") return detail.trim() === "" ? null : detail;
  if (typeof detail === "object" && detail !== null) {
    const message = (detail as Record<string, unknown>).message;
    return typeof message === "string" && message.trim() !== "" ? message : null;
  }
  return null;
}
