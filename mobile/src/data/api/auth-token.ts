import { getBaseUrl } from "@/data/api/config";
import { clearPendingAuthenticatedLink } from "@/lib/linking";
import { secureStorage } from "@/lib/secure-storage";

type StoredToken = {
  jwt: string;
  issuedAt: number | null;
  expiresAt: number | null;
};

const TOKEN_KEY_PREFIX = "spawn.auth.session.v1";
const tokenCache = new Map<string, StoredToken | null>();

function storageKey(baseUrl: string): string {
  const encodedOrigin = Array.from(baseUrl, (character) =>
    /^[A-Za-z0-9.-]$/.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16).padStart(4, "0")}_`,
  ).join("");
  return `${TOKEN_KEY_PREFIX}.${encodedOrigin}`;
}

interface SessionTokenClaims {
  issuedAt: number | null;
  expiresAt: number | null;
}

function decodeClaims(jwt: string): SessionTokenClaims {
  const payload = jwt.split(".")[1];
  if (!payload) return { issuedAt: null, expiresAt: null };
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded: unknown = JSON.parse(globalThis.atob(padded));
    if (typeof decoded !== "object" || decoded === null) {
      return { issuedAt: null, expiresAt: null };
    }
    const record = decoded as { iat?: unknown; exp?: unknown };
    return {
      issuedAt: typeof record.iat === "number" && Number.isFinite(record.iat) ? record.iat : null,
      expiresAt: typeof record.exp === "number" && Number.isFinite(record.exp) ? record.exp : null,
    };
  } catch {
    return { issuedAt: null, expiresAt: null };
  }
}

/** True at and after the midpoint of a JWT's declared lifetime. */
export function sessionTokenNeedsRenewal(jwt: string, nowSeconds = Date.now() / 1_000): boolean {
  const { issuedAt, expiresAt } = decodeClaims(jwt);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) return false;
  return nowSeconds >= issuedAt + (expiresAt - issuedAt) / 2 && nowSeconds < expiresAt;
}

function isExpired(token: StoredToken): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() / 1000;
}

async function currentStorageKey(): Promise<string> {
  return storageKey(await getBaseUrl());
}

async function get(): Promise<string | null> {
  const key = await currentStorageKey();
  let stored = tokenCache.get(key);
  if (stored === undefined) {
    const encoded = await secureStorage.get(key);
    if (encoded === null) {
      stored = null;
    } else {
      try {
        const parsed: unknown = JSON.parse(encoded);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Partial<StoredToken>).jwt === "string"
        ) {
          const jwt = (parsed as StoredToken).jwt;
          stored = { jwt, ...decodeClaims(jwt) };
        } else {
          stored = null;
        }
      } catch {
        stored = null;
      }
    }
    tokenCache.set(key, stored);
  }
  if (stored === null) return null;
  if (isExpired(stored)) {
    await clearStoredToken(key);
    return null;
  }
  return stored.jwt;
}

// Consumers need to know when credentials appear or disappear. Without this the
// auth gate can only re-read the token by coincidence — e.g. on a navigation —
// which leaves a fresh login invisible until something else happens to change.
const changeListeners = new Set<() => void>();

function notifyTokenChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {
      // A bad listener must not stop the others, or block a login.
    }
  }
}

async function clearStoredToken(key: string): Promise<void> {
  tokenCache.set(key, null);
  clearPendingAuthenticatedLink();
  await secureStorage.delete(key);
  notifyTokenChanged();
}

/** Subscribe to credential changes. Returns an unsubscribe function. */
function subscribe(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

async function set(jwt: string): Promise<void> {
  const key = await currentStorageKey();
  const stored: StoredToken = { jwt, ...decodeClaims(jwt) };
  await secureStorage.set(key, JSON.stringify(stored));
  tokenCache.set(key, stored);
  notifyTokenChanged();
}

async function clear(): Promise<void> {
  await clearStoredToken(await currentStorageKey());
}

function sessionCookie(header: string): string | null {
  const match = /(?:^|,)\s*spawn_session=([^;,]*)/i.exec(header);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

async function captureFromResponse(response: Response): Promise<string | null> {
  const header = response.headers.get("set-cookie");
  if (header === null) return null;
  const jwt = sessionCookie(header);
  if (jwt === null) return null;
  await set(jwt);
  return jwt;
}

export const authToken = { get, set, clear, captureFromResponse, subscribe };
