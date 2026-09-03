import { AuthConfigSchema, type BillingConfig } from "@/lib/api";

/**
 * What `GET /api/auth/config` says about billing, read from the Next server
 * rather than from a browser.
 *
 * The app is single-origin on purpose: `/api/*` is a Next *rewrite*, so there
 * is no relative URL a server component can fetch it by and no public base URL
 * to borrow. The rewrite's own target is the API's only address from inside
 * this process, which is why this reaches for `SPAWN_API_PROXY_TARGET` — the
 * same value `next.config.ts` bakes the rewrite from.
 *
 * Every failure answers `null`, and `null` deliberately does not mean
 * `enabled: false`. "The server could not be asked" and "this deployment sells
 * nothing" are different facts and the callers treat them differently: a
 * pricing *link* fails closed on `null` (a self-hosted install must never
 * advertise a shop), while the pricing *page* falls back to the tiers it ships
 * with, because a marketing page that renders blank when the API hiccups is
 * worse than one printing last-known prices.
 */

/** Long enough for a healthy local API, short enough that a dead one costs a
 * page render rather than a page. */
const CONFIG_TIMEOUT_MS = 2_000;

/**
 * Where this process can reach `GET /api/auth/config`, or null when nothing in
 * the environment names the API. Split out from the fetch so the URL rule is
 * testable without a socket.
 */
export function authConfigUrl(env: Record<string, string | undefined>): string | null {
  // The proxy target first: it is the server's own truth about where the API
  // lives. NEXT_PUBLIC_SPAWN_API_URL is the dev escape hatch for a FastAPI on
  // another port, and is only consulted when the proxy target is unset.
  const base = env.SPAWN_API_PROXY_TARGET || env.NEXT_PUBLIC_SPAWN_API_URL;
  if (!base) return null;
  try {
    const url = new URL("/api/auth/config", base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The billing block, or null when the server could not be asked. */
export async function readBillingConfig(): Promise<BillingConfig | null> {
  const url = authConfigUrl(process.env);
  if (url === null) return null;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return AuthConfigSchema.parse(await response.json()).billing;
  } catch {
    // A public page must render whatever the API is doing. There is nothing
    // here worth logging on every request of a marketing page.
    return null;
  }
}
