import { getBaseUrl } from "@/data/api/config";
import { secureStorage } from "@/lib/secure-storage";

type StoredToken = {
  jwt: string;
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

function decodeExpiry(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded: unknown = JSON.parse(globalThis.atob(padded));
    if (typeof decoded !== "object" || decoded === null || !("exp" in decoded)) return null;
    const expiry = (decoded as { exp?: unknown }).exp;
    return typeof expiry === "number" && Number.isFinite(expiry) ? expiry : null;
  } catch {
    return null;
  }
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
        stored =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Partial<StoredToken>).jwt === "string" &&
          (typeof (parsed as Partial<StoredToken>).expiresAt === "number" ||
            (parsed as Partial<StoredToken>).expiresAt === null)
            ? (parsed as StoredToken)
            : null;
      } catch {
        stored = null;
      }
    }
    tokenCache.set(key, stored);
  }
  if (stored === null) return null;
  if (isExpired(stored)) {
    tokenCache.set(key, null);
    await secureStorage.delete(key);
    return null;
  }
  return stored.jwt;
}

async function set(jwt: string): Promise<void> {
  const key = await currentStorageKey();
  const stored: StoredToken = { jwt, expiresAt: decodeExpiry(jwt) };
  await secureStorage.set(key, JSON.stringify(stored));
  tokenCache.set(key, stored);
}

async function clear(): Promise<void> {
  const key = await currentStorageKey();
  tokenCache.set(key, null);
  await secureStorage.delete(key);
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

export const authToken = { get, set, clear, captureFromResponse };
