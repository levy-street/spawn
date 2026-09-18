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
const tokenRevisions = new Map<string, number>();
const tokenIdentities = new Map<string, number>();
const tokenWrites = new Map<string, Promise<void>>();

/** Credentials are bound to the origin and storage revision used by a request. */
export interface AuthTokenSnapshot {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly revision: number;
  readonly identity: number;
}

type CredentialGuard = "request" | "identity";

function revision(key: string): number {
  return tokenRevisions.get(key) ?? 0;
}

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

async function snapshot(baseUrl?: string, includeToken = true): Promise<AuthTokenSnapshot> {
  const origin = baseUrl ?? (await getBaseUrl());
  const key = storageKey(origin);
  // Public requests need an identity fence without requiring native keychain
  // access. Login may start while the keychain has never been read.
  if (!includeToken) {
    return {
      baseUrl: origin,
      token: null,
      revision: revision(key),
      identity: tokenIdentities.get(key) ?? 0,
    };
  }
  for (;;) {
    const pending = tokenWrites.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      continue;
    }
    const currentRevision = revision(key);
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
      // A read started before login/logout must never publish its old value.
      if (revision(key) !== currentRevision) continue;
      tokenCache.set(key, stored);
    }
    if (stored !== null && isExpired(stored)) {
      await writeStoredToken(key, null);
      continue;
    }
    return {
      baseUrl: origin,
      token: stored?.jwt ?? null,
      revision: currentRevision,
      identity: tokenIdentities.get(key) ?? 0,
    };
  }
}

async function get(): Promise<string | null> {
  return (await snapshot()).token;
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

async function writeStoredToken(
  key: string,
  stored: StoredToken | null,
  replaceIdentity = true,
): Promise<boolean> {
  const nextRevision = revision(key) + 1;
  tokenRevisions.set(key, nextRevision);
  if (replaceIdentity) tokenIdentities.set(key, (tokenIdentities.get(key) ?? 0) + 1);
  if (stored === null) {
    tokenCache.set(key, null);
    clearPendingAuthenticatedLink();
  }
  // Native writes/deletes can finish out of order. Queue them per origin so
  // persistence agrees with the latest login even across a process relaunch.
  const previous = tokenWrites.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      if (stored === null) await secureStorage.delete(key);
      else await secureStorage.set(key, JSON.stringify(stored));
      if (revision(key) === nextRevision) tokenCache.set(key, stored);
    });
  tokenWrites.set(key, write);
  try {
    await write;
  } finally {
    if (tokenWrites.get(key) === write) tokenWrites.delete(key);
  }
  if (revision(key) !== nextRevision) return false;
  notifyTokenChanged();
  return true;
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
  await writeStoredToken(key, stored);
}

async function clear(): Promise<void> {
  await writeStoredToken(await currentStorageKey(), null);
}

async function isCurrent(
  expected: AuthTokenSnapshot,
  guard: CredentialGuard = "request",
): Promise<boolean> {
  if ((await getBaseUrl()) !== expected.baseUrl) return false;
  const key = storageKey(expected.baseUrl);
  return (
    (tokenIdentities.get(key) ?? 0) === expected.identity &&
    (guard === "identity" || revision(key) === expected.revision)
  );
}

async function writeIfCurrent(
  expected: AuthTokenSnapshot,
  stored: StoredToken | null,
  guard: CredentialGuard,
  replaceIdentity: boolean,
): Promise<AuthTokenSnapshot | null> {
  if ((await getBaseUrl()) !== expected.baseUrl) return null;
  const key = storageKey(expected.baseUrl);
  if ((tokenIdentities.get(key) ?? 0) !== expected.identity) return null;
  if (guard === "request" && revision(key) !== expected.revision) return null;
  const accepted = {
    baseUrl: expected.baseUrl,
    token: stored?.jwt ?? null,
    revision: revision(key),
    identity: tokenIdentities.get(key) ?? 0,
  };
  // A response body can repeat the cookie already accepted by the HTTP client.
  if (!replaceIdentity && stored?.jwt === tokenCache.get(key)?.jwt && !tokenWrites.has(key)) {
    return accepted;
  }
  accepted.revision += 1;
  if (replaceIdentity) accepted.identity += 1;
  return (await writeStoredToken(key, stored, replaceIdentity)) ? accepted : null;
}

async function clearIfCurrent(
  expected: AuthTokenSnapshot,
  guard: CredentialGuard = "request",
): Promise<boolean> {
  return (await writeIfCurrent(expected, null, guard, true)) !== null;
}

/** A response body renews the existing identity; it never starts a new login. */
async function setIfCurrent(
  jwt: string,
  expected: AuthTokenSnapshot,
  guard: CredentialGuard = "request",
): Promise<boolean> {
  return (await writeIfCurrent(expected, { jwt, ...decodeClaims(jwt) }, guard, false)) !== null;
}

function sessionCookie(header: string): string | null {
  const match = /(?:^|,)\s*spawn_session=([^;,]*)/i.exec(header);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

async function captureFromResponse(
  response: Response,
  expected?: AuthTokenSnapshot,
  replaceIdentity = false,
): Promise<AuthTokenSnapshot | null> {
  const header = response.headers.get("set-cookie");
  if (header === null) return null;
  const jwt = sessionCookie(header);
  if (jwt === null) return null;
  // Login responses may follow a renewal of the previous session. They may
  // replace that same identity, but never a login/logout performed meanwhile.
  return writeIfCurrent(
    expected ?? (await snapshot(undefined, false)),
    { jwt, ...decodeClaims(jwt) },
    replaceIdentity || !expected ? "identity" : "request",
    replaceIdentity || !expected,
  );
}

export const authToken = {
  get,
  set,
  clear,
  snapshot,
  isCurrent,
  clearIfCurrent,
  setIfCurrent,
  captureFromResponse,
  subscribe,
};
