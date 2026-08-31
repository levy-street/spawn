import type { BillingTier } from "@/lib/api";

/**
 * The plans as the server defines them (`server/spawn_server/billing.py`),
 * repeated here for one reason only: so `/pricing` still prints when the API
 * cannot be reached. The advertised list wins whenever there is one. These
 * numbers are a fallback, never a second source of truth — if they ever
 * disagree with the server, the server is right and this list is stale.
 */
export const FALLBACK_TIERS: readonly BillingTier[] = [
  { key: "free", name: "Free", price_cents: 0, host_limit: 1 },
  { key: "coven", name: "Coven", price_cents: 500, host_limit: 3 },
  // "the Legion plan", spelled out, here as everywhere: `/legion` is the fleet
  // page, and bare "Legion" in a billing sentence reads as that page.
  { key: "legion", name: "the Legion plan", price_cents: 2000, host_limit: 20 },
  { key: "pandemonium", name: "Pandemonium", price_cents: 5000, host_limit: null },
];

/**
 * The column the page recommends. It is marked with an `Eyebrow` in hellfire
 * and given the row's one bone slab — never a red button. Hellfire is brand
 * ink on this site and never a call to act.
 */
export const RECOMMENDED_TIER = "coven";

/** What each plan is for, in one breath. Keyed by tier, not by index. */
export const TIER_BLURB: Record<string, string> = {
  free: "One host, at no cost, on every deployment. Enough to possess the machine you actually work on and never think about this page again.",
  coven:
    "The laptop, the desktop, and the box under the stairs. Three registrations — the first plan most people ever need.",
  legion:
    "Twenty registrations, for a fleet you tend rather than a desk you sit at. Named for the crowd, not for the page.",
  pandemonium:
    "Every machine you can reach. No count, no ceiling, and no conversation about it again.",
};

/** Standard verbs. `Upgrade`, never `Ascend`. */
export function tierAction(key: string): string {
  return key === "free" ? "Sign up" : "Upgrade";
}

/** `$5`, `$0`, and `$5.50` if a price ever stops being round. */
export function priceLabel(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/** What the price buys, counted in registrations. `null` is unlimited. */
export function hostLabel(limit: number | null): string {
  if (limit === null) return "Unlimited hosts";
  return limit === 1 ? "1 host" : `${limit} hosts`;
}
