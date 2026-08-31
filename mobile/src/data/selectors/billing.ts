import type { UserBilling } from "@/data/api/schemas/auth";

/**
 * Every billing word a person reads in this app, built from numbers.
 *
 * The mobile apps never sell anything (docs/BILLING.md §6.1): no price, no buy
 * button, no link to a purchase page, no clipboard copy or QR code carrying a
 * checkout URL. They show subscription *status*, and at the limit they say what
 * the limit is and what can be done about it **inside the app**.
 *
 * Two rules follow, and they are why this file exists at all:
 *
 * 1. **No string here contains a price or a venue.** One file to write, one
 *    file to review, one file for a test to sweep.
 * 2. **No server string is rendered as billing prose.** The server's 402 and
 *    its plan block carry a machine code and numbers only, deliberately, because
 *    `onboarding/trust-failure-state.tsx` renders `ApiError.message` verbatim
 *    inside a binary that ships through app review. The client owns the words.
 *
 * Apple polices the verb and Google polices the link, so the copy is written to
 * Apple's rule and Google is covered for free: declarative statements of account
 * state, never an instruction pointed off-platform. "Billing is managed on the
 * web." is deliberate and is not to be improved into "Manage your plan on the
 * web" — the imperative is the half that fails.
 */

/** Whether this deployment has billing at all. Null block = self-hosted, no billing. */
export function billingActive(billing: UserBilling | null | undefined): billing is UserBilling {
  if (billing === null || billing === undefined) return false;
  return billing.enabled;
}

/**
 * True once the account holds every host its plan admits.
 *
 * Narrows, so a caller that has asked the question can then read the figure it
 * needs without a second null check.
 */
export function atHostLimit(billing: UserBilling | null | undefined): billing is UserBilling {
  if (!billingActive(billing)) return false;
  if (billing.host_limit === null) return false;
  return billing.host_count >= billing.host_limit;
}

/** The title above the limit message, wherever it lands. */
export const HOST_LIMIT_TITLE = "Host limit reached";

/**
 * The limit message: account state, plus the one action available here.
 *
 * No price, no venue, no verb pointed off-platform — so it ships worldwide on
 * both platforms and stays compliant whatever the courts do with 3.1.1(a). The
 * server sends an email carrying the rest, which is outside the app and
 * expressly permitted; the app does not mention that it does.
 */
export function hostLimitDescription(hostLimit: number | null | undefined): string {
  if (hostLimit === null || hostLimit === undefined) {
    return "Your plan's host limit is in use. Disconnect one to connect another.";
  }
  const hosts = hostLimit === 1 ? "1 host" : `${hostLimit} hosts`;
  return `Your plan includes ${hosts}. Disconnect one to connect another.`;
}

/** "Coven · 3 of 3 hosts in use", or "Pandemonium · 3 hosts in use" when unlimited. */
export function planCapacityLine(billing: UserBilling): string {
  const used = billing.host_count === 1 ? "1 host" : `${billing.host_count} hosts`;
  if (billing.host_limit === null) return `${billing.tier_name} · ${used} in use`;
  return `${billing.tier_name} · ${billing.host_count} of ${billing.host_limit} hosts in use`;
}

/**
 * "Renews 24 September 2026", or "Ends …" when it has been set to stop.
 *
 * Null when there is no dated period to report — a free plan, or a comped one.
 * Saying "renews" about a subscription already set to end would be a lie told
 * for the sake of a fixed string.
 */
export function planRenewalLine(billing: UserBilling): string | null {
  if (billing.current_period_end === null) return null;
  const parsed = new Date(billing.current_period_end);
  if (Number.isNaN(parsed.getTime())) return null;
  const date = parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return billing.cancel_at_period_end ? `Ends ${date}` : `Renews ${date}`;
}

/**
 * Why there is no button here.
 *
 * Passive, names no venue, carries no verb aimed at the reader, and no price.
 * It reads as an explanation for the absence of a control rather than an
 * inducement to press one.
 */
export const BILLING_VENUE_NOTE = "Billing is managed on the web.";

/** The over-limit reconciliation modal's copy, built from the same numbers. */
export const OVER_LIMIT_TITLE = "Choose the hosts to keep";

export function overLimitDescription(billing: UserBilling): string {
  const limit = billing.host_limit ?? 0;
  const keeps = limit === 1 ? "1 host" : `${limit} hosts`;
  const held = billing.host_count === 1 ? "1 host" : `${billing.host_count} hosts`;
  return `Your account holds ${held} and your plan includes ${keeps}. Choose which to keep — or keep none. Everything keeps running until you decide, and nothing is removed except what you leave unselected.`;
}

/** "2 of 3 selected" under the list, so the cap is legible before the confirm. */
export function selectionCountLine(selected: number, limit: number): string {
  return `${selected} of ${limit} selected`;
}
