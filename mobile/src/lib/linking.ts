export const APP_SCHEME = "spawn";

// Owner input: replace this placeholder with the canonical HTTPS host before universal links ship.
export const UNIVERSAL_LINK_HOST = "spawn.example.com";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ACCOUNT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ONBOARDING_STEPS = new Set(["account", "verify", "host", "done"]);

export type DeepLinkRoute =
  | "/"
  | "/(auth)/login"
  | "/(auth)/signup"
  | "/(auth)/forgot-password"
  | "/(auth)/reset-password"
  | "/(auth)/verify-email"
  | "/(onboarding)"
  | "/(onboarding)/device"
  | "/(tabs)/hosts/legion"
  | "/(tabs)/settings"
  | "/admin"
  | "/host/[id]"
  | "/host/[id]/files"
  | "/workspace/[id]"
  | "/terminal/[sessionId]";

export interface ResolvedDeepLink {
  route: DeepLinkRoute;
  params: Readonly<Record<string, string>>;
  href: string;
  requiresAuth: boolean;
  sensitive: boolean;
}

interface ParsedIncomingUrl {
  path: string;
  searchParams: URLSearchParams;
}

export interface IncomingUrlSource {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: "url", listener: (event: { url: string }) => void): { remove(): void };
}

let pendingAuthenticatedLink: ResolvedDeepLink | null = null;

function result(
  route: DeepLinkRoute,
  href: string,
  options: {
    params?: Readonly<Record<string, string>>;
    requiresAuth?: boolean;
    sensitive?: boolean;
  } = {},
): ResolvedDeepLink {
  return {
    route,
    params: options.params ?? {},
    href,
    requiresAuth: options.requiresAuth ?? false,
    sensitive: options.sensitive ?? false,
  };
}

function normalizedPath(path: string): string {
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  if (withLeadingSlash.length === 1) return withLeadingSlash;
  return withLeadingSlash.replace(/\/+$/, "");
}

function parseIncomingUrl(input: string): ParsedIncomingUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("/")) {
      const parsed = new URL(trimmed, `https://${UNIVERSAL_LINK_HOST}`);
      return { path: normalizedPath(parsed.pathname), searchParams: parsed.searchParams };
    }

    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === APP_SCHEME) {
      const customSchemePath = parsed.hostname
        ? `/${parsed.hostname}${parsed.pathname}`
        : parsed.pathname;
      return {
        path: normalizedPath(customSchemePath || "/"),
        searchParams: parsed.searchParams,
      };
    }
    if (scheme === "http" || scheme === "https") {
      if (parsed.hostname.toLowerCase() !== UNIVERSAL_LINK_HOST) return null;
      return { path: normalizedPath(parsed.pathname), searchParams: parsed.searchParams };
    }
    if (scheme === "exp" || scheme === "exps") {
      const marker = "/--";
      const markerIndex = parsed.pathname.indexOf(marker);
      const expoPath = markerIndex >= 0 ? parsed.pathname.slice(markerIndex + marker.length) : "/";
      return { path: normalizedPath(expoPath), searchParams: parsed.searchParams };
    }
  } catch {
    return null;
  }

  return null;
}

function withQuery(path: string, params: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${path}?${query}` : path;
}

function validUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

function validFilePath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.includes("\0");
}

/** Resolves both cold-start and foreground URLs without retaining or logging bearer tokens. */
export function resolveIncomingLink(input: string): ResolvedDeepLink | null {
  const parsed = parseIncomingUrl(input);
  if (!parsed) return null;
  const { path, searchParams } = parsed;

  if (path === "/" || path === "/app") return result("/", "/");
  if (path === "/login") return result("/(auth)/login", "/login");
  if (path === "/forgot-password") {
    return result("/(auth)/forgot-password", "/forgot-password");
  }
  if (path === "/signup") {
    const invite = searchParams.get("invite");
    if (invite !== null && !INVITE_TOKEN_PATTERN.test(invite)) return null;
    const params = invite === null ? {} : { invite };
    return result("/(auth)/signup", withQuery("/signup", params), {
      params,
      sensitive: invite !== null,
    });
  }
  if (path === "/verify-email" || path === "/reset-password") {
    const token = searchParams.get("token") ?? undefined;
    if (!token || !ACCOUNT_TOKEN_PATTERN.test(token)) return null;
    const params = { token };
    const route = path === "/verify-email" ? "/(auth)/verify-email" : "/(auth)/reset-password";
    return result(route, withQuery(path, params), { params, sensitive: true });
  }
  if (path === "/device") {
    return result("/(onboarding)/device", "/device", { requiresAuth: true });
  }
  if (path === "/onboarding") {
    const step = searchParams.get("step");
    if (step !== null && !ONBOARDING_STEPS.has(step)) return null;
    const params = step === null ? {} : { step };
    return result("/(onboarding)", withQuery("/onboarding", params), {
      params,
      requiresAuth: true,
    });
  }
  if (path === "/legion") {
    return result("/(tabs)/hosts/legion", "/hosts/legion", { requiresAuth: true });
  }
  if (path === "/admin") return result("/admin", "/admin", { requiresAuth: true });
  if (path === "/download" || path === "/security") {
    const section = path.slice(1);
    const params = { section };
    return result("/(tabs)/settings", withQuery("/settings", params), {
      params,
      requiresAuth: true,
    });
  }

  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "hosts" && validUuid(segments[1])) {
    const id = segments[1];
    if (segments.length === 2) {
      return result("/host/[id]", `/host/${id}`, {
        params: { id },
        requiresAuth: true,
      });
    }
    if (segments.length === 3 && segments[2] === "files") {
      const initialPath = searchParams.get("path");
      if (initialPath !== null && !validFilePath(initialPath)) return null;
      const params = initialPath === null ? { id } : { id, path: initialPath };
      const hrefParams = initialPath === null ? {} : { path: initialPath };
      return result("/host/[id]/files", withQuery(`/host/${id}/files`, hrefParams), {
        params,
        requiresAuth: true,
      });
    }
    return null;
  }
  if (segments[0] === "w" && segments.length === 2 && validUuid(segments[1])) {
    const id = segments[1];
    const tab = searchParams.get("tab") ?? undefined;
    const focus = searchParams.get("focus") ?? undefined;
    if ((tab !== undefined && !validUuid(tab)) || (focus !== undefined && !validUuid(focus))) {
      return null;
    }
    const queryParams = {
      ...(tab === undefined ? {} : { tab }),
      ...(focus === undefined ? {} : { focus }),
    };
    return result("/workspace/[id]", withQuery(`/workspace/${id}`, queryParams), {
      params: { id, ...queryParams },
      requiresAuth: true,
    });
  }
  if (segments[0] === "sessions" && segments.length === 2 && validUuid(segments[1])) {
    const sessionId = segments[1];
    return result("/terminal/[sessionId]", `/terminal/${sessionId}`, {
      params: { sessionId },
      requiresAuth: true,
    });
  }
  return null;
}

export function isSpawnOwnedUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith("/")) return true;
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    return (
      scheme === APP_SCHEME ||
      scheme === "exp" ||
      scheme === "exps" ||
      ((scheme === "http" || scheme === "https") &&
        parsed.hostname.toLowerCase() === UNIVERSAL_LINK_HOST)
    );
  } catch {
    return false;
  }
}

export function rememberPendingAuthenticatedLink(link: ResolvedDeepLink): void {
  pendingAuthenticatedLink = link.requiresAuth ? link : null;
}

export function takePendingAuthenticatedLink(): ResolvedDeepLink | null {
  const pending = pendingAuthenticatedLink;
  pendingAuthenticatedLink = null;
  return pending;
}

export function clearPendingAuthenticatedLink(): void {
  pendingAuthenticatedLink = null;
}

/** Uses the same resolver entry point for the launch URL and subsequent foreground links. */
export function subscribeToIncomingUrls(
  source: IncomingUrlSource,
  onUrl: (url: string) => void,
): () => void {
  let active = true;
  void source.getInitialURL().then(
    (url) => {
      if (active && url) onUrl(url);
    },
    () => undefined,
  );
  const subscription = source.addEventListener("url", ({ url }) => {
    if (active) onUrl(url);
  });
  return () => {
    active = false;
    subscription.remove();
  };
}
