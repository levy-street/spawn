import { type NextRequest, NextResponse } from "next/server";

/**
 * Serve the admin area from its own hostname.
 *
 * `admin.<domain>` rewrites to `/admin/*` so the dashboard gets a separate
 * origin — which also means a separate cookie jar, so an admin session is not
 * the same session the product uses.
 *
 * This is packaging, not permission. Every admin API checks the account's
 * admin flag and answers 404 otherwise, so reaching `/admin` by any other
 * route (including the main origin) shows an empty shell and nothing more.
 */
export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const isAdminHost = host.split(":")[0].startsWith("admin.");
  const { pathname } = request.nextUrl;

  if (!isAdminHost) return NextResponse.next();

  // API, auth pages, and Next internals must pass through untouched: the
  // admin origin still signs in and still talks to the same backend.
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/verify-email") ||
    pathname.startsWith("/admin")
  ) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/admin" : `/admin${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
