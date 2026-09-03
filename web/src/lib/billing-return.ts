import { safeNext } from "@/lib/safe-next";

/**
 * Leaving for Stripe, and coming back.
 *
 * Checkout and the Customer Portal are full-page navigations away from the
 * app, and Stripe returns the browser to one fixed URL the server built:
 * `/app?billing=complete|cancelled|portal`. That is the product rather than
 * the marketing page, but it is not necessarily where the person was — they
 * may have opened Settings from /legion or from inside a workspace — so the
 * leaving side writes down where it left from, and the returning side reads
 * it back and goes there.
 *
 * sessionStorage on purpose: it is per tab, it survives the round trip
 * through a third-party origin in the same tab, and it dies with the tab, so
 * a stale note can never send some later visit somewhere surprising. The
 * path goes through `safeNext` on the way in AND on the way out, so a
 * tampered value can only ever land on a same-origin path.
 */
export const BILLING_RETURN_KEY = "spawn.billing.return";
export const BILLING_RETURN_PARAM = "billing";

export type BillingReturn = "complete" | "cancelled" | "portal";

/** The flag Stripe brought back, or null when this is an ordinary visit. */
export function parseBillingReturn(search: string): BillingReturn | null {
  const value = new URLSearchParams(search).get(BILLING_RETURN_PARAM);
  return value === "complete" || value === "cancelled" || value === "portal" ? value : null;
}

/** The same location without the flag, so a reload cannot replay the return. */
export function withoutBillingParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(BILLING_RETURN_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

export function rememberBillingReturn(storage: Storage | null, path: string): void {
  try {
    storage?.setItem(BILLING_RETURN_KEY, safeNext(path));
  } catch {
    // Private mode or a full quota: the return lands on /app, which is fine.
  }
}

/** Read the note and tear it up — one return per departure. */
export function takeBillingReturn(storage: Storage | null): string | null {
  try {
    const raw = storage?.getItem(BILLING_RETURN_KEY) ?? null;
    storage?.removeItem(BILLING_RETURN_KEY);
    return raw === null ? null : safeNext(raw);
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Note where we are, then go. Checkout and the portal both leave this way. */
export function leaveForBilling(url: string): void {
  rememberBillingReturn(sessionStore(), `${window.location.pathname}${window.location.search}`);
  window.location.assign(url);
}

/** Where a return should land: the noted page, or nowhere in particular. */
export function takeBillingReturnHere(): string | null {
  return takeBillingReturn(sessionStore());
}

/**
 * `/w/abc` + `?billing=complete&x=1` → `/w/abc?billing=complete`. The /app
 * entry page is a router rather than a destination: with a workspace to open
 * it redirects before its shell (and this handler) ever mounts, so it has to
 * hand the flag on to the page that will.
 */
export function carryBillingParam(path: string, search: string): string {
  const kind = parseBillingReturn(search);
  return kind === null ? path : `${path}?${BILLING_RETURN_PARAM}=${kind}`;
}
