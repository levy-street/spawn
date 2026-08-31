/**
 * Where to land after an auth screen, from the `?next=` AuthGate set.
 *
 * This is a security boundary, not a convenience: `next` arrives from the URL,
 * so anything but a same-origin absolute path would turn the login page into
 * an open redirect. Protocol-relative (`//evil.test`) and absolute URLs are
 * rejected outright.
 *
 * The fragment is dropped on purpose. `/device` approval links carry the
 * host's identity key there, and it must never travel through a redirect —
 * `device-approval-stash` keeps it in sessionStorage instead, out of band.
 */
export const DEFAULT_NEXT = "/app";

export function safeNext(raw: string | null, fallback: string = DEFAULT_NEXT): string {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw.split("#", 1)[0] || fallback;
}

/** Carry `next` from one auth screen to the other, if there is one worth carrying. */
export function withNext(path: string, next: string | null, fallback: string = DEFAULT_NEXT) {
  const resolved = safeNext(next, fallback);
  if (resolved === fallback) return path;
  return `${path}?next=${encodeURIComponent(resolved)}`;
}
